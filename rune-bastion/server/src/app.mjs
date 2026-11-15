import http from 'node:http';
import { createOidcVerifier, hashPassword, randomToken, sha256, verifyPassword } from './auth.mjs';

const MAX_BODY = 300 * 1024;
const HISTORY = 5;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/**
 * HTTP API. Everything is injected (store, clock, verifiers) so the same app runs in tests.
 * Auth is a bearer token (random 256-bit value, stored hashed). No cookies → CORS can be open.
 */
export function createApp({ store, now = () => Date.now(), iapVerifiers = {}, oidc, rate = { window: 60_000, max: 240, authMax: 30 } }) {
  const db = store.db;
  const verifyOidc = oidc ?? createOidcVerifier({ audiences: {} });
  const hits = new Map();

  const limited = (ip, bucket, max) => {
    const key = `${bucket}:${ip}`, t = now();
    const h = (hits.get(key) ?? []).filter((x) => t - x < rate.window);
    h.push(t);
    hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > rate.window) hits.delete(k);
    return h.length > max;
  };
  const publicUser = (u, token) => ({ userId: u.id, kind: u.kind, email: u.email ?? null, links: { google: !!u.google, apple: !!u.apple }, ...(token ? { token } : {}) });
  const issueToken = (u) => {
    const token = randomToken();
    db.tokens[sha256(token)] = { userId: u.id, at: now() };
    return token;
  };
  const newUser = (kind) => {
    const u = { id: randomToken(12), kind, createdAt: now() };
    db.users[u.id] = u;
    return u;
  };
  const userFromReq = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const t = db.tokens[sha256(m[1])];
    return t ? db.users[t.userId] ?? null : null;
  };
  const summaryOf = (s) => {
    const o = s && typeof s === 'object' ? s : {};
    const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
    return { cleared: n(o.cleared), score: n(o.score), playtime: n(o.playtime) };
  };

  const routes = {
    'GET /v1/health': () => [200, { ok: true }],
    'GET /v1/time': () => [200, { now: now() }],

    'POST /v1/auth/guest': ({ body }) => {
      const deviceId = typeof body.deviceId === 'string' && body.deviceId.length >= 8 && body.deviceId.length <= 128 ? body.deviceId : null;
      if (!deviceId) return [400, { error: 'bad_device' }];
      // The same install gets its guest back; an upgraded account must sign in explicitly.
      let u = db.users[db.devices[deviceId]];
      if (!u || u.kind !== 'guest') { u = newUser('guest'); db.devices[deviceId] = u.id; }
      return [200, publicUser(u, issueToken(u))];
    },
    'POST /v1/auth/register': ({ body, user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      const email = String(body.email ?? '').trim().toLowerCase(), password = String(body.password ?? '');
      if (!EMAIL_RE.test(email) || password.length < 8 || password.length > 200) return [400, { error: 'invalid' }];
      if (db.emails[email] && db.emails[email] !== user.id) return [409, { error: 'email_taken' }];
      if (user.email && user.email !== email) delete db.emails[user.email];
      user.email = email; user.pass = hashPassword(password); user.kind = 'account';
      db.emails[email] = user.id;
      return [200, publicUser(user)];
    },
    'POST /v1/auth/login': ({ body }) => {
      const email = String(body.email ?? '').trim().toLowerCase(), password = String(body.password ?? '');
      const u = db.users[db.emails[email]];
      if (!u || !u.pass || !verifyPassword(password, u.pass)) return [401, { error: 'credentials' }];
      return [200, publicUser(u, issueToken(u))];
    },
    'POST /v1/auth/oidc': async ({ body }) => {
      const id = await verifyOidc(body.provider, body.idToken);
      if (!id) return [401, { error: 'credentials' }];
      const u = db.users[db.identities[`${body.provider}:${id.sub}`]];
      if (!u) return [404, { error: 'not_linked' }];
      return [200, publicUser(u, issueToken(u))];
    },
    'POST /v1/auth/link': async ({ body, user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      const id = await verifyOidc(body.provider, body.idToken);
      if (!id) return [401, { error: 'credentials' }];
      const key = `${body.provider}:${id.sub}`;
      if (db.identities[key] && db.identities[key] !== user.id) return [409, { error: 'identity_taken' }];
      db.identities[key] = user.id;
      user[body.provider] = id.sub;
      user.kind = 'account';
      return [200, publicUser(user)];
    },

    'GET /v1/save': ({ user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      const s = db.saves[user.id];
      return s ? [200, { rev: s.rev, updatedAt: s.updatedAt, doc: s.doc }] : [404, { error: 'no_save' }];
    },
    'PUT /v1/save': ({ body, user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      const doc = body.doc;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.id !== 'string') return [400, { error: 'bad_doc' }];
      const cur = db.saves[user.id];
      const curRev = cur?.rev ?? 0;
      // Optimistic concurrency: the client must have seen the latest revision.
      if (body.baseRev !== curRev) return [409, { error: 'conflict', rev: curRev }];
      const history = cur ? [{ rev: cur.rev, updatedAt: cur.updatedAt, doc: cur.doc, summary: cur.summary }, ...(cur.history ?? [])].slice(0, HISTORY) : [];
      db.saves[user.id] = { rev: curRev + 1, updatedAt: now(), doc, hash: sha256(JSON.stringify(doc)), summary: summaryOf(body.summary), history };
      return [200, { rev: curRev + 1 }];
    },
    'GET /v1/save/history': ({ user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      const s = db.saves[user.id];
      return [200, { items: (s?.history ?? []).map((h) => ({ rev: h.rev, updatedAt: h.updatedAt, summary: h.summary })) }];
    },

    'POST /v1/iap/verify': async ({ body, user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      const { platform, productId, transactionId } = body;
      if (typeof platform !== 'string' || typeof productId !== 'string' || typeof transactionId !== 'string' || !transactionId || transactionId.length > 300) return [400, { error: 'bad_request' }];
      const key = `${platform}:${transactionId}`;
      const seen = db.purchases[key];
      if (seen) {
        // Same buyer retrying is fine (idempotent); the same receipt on another account is a replay.
        if (seen.userId === user.id && seen.productId === productId) return [200, { valid: true, duplicate: true }];
        return [409, { valid: false, error: 'receipt_already_used' }];
      }
      const verifier = iapVerifiers[platform];
      if (!verifier) return [503, { error: 'verifier_not_configured' }];
      let result;
      try { result = await verifier({ productId, transactionId, purchaseToken: body.purchaseToken, receipt: body.receipt }); } catch (e) { return [502, { error: 'verifier_unreachable' }]; }
      if (!result.valid) return [402, { valid: false, error: result.reason ?? 'invalid' }];
      db.purchases[key] = { userId: user.id, productId, at: now() };
      return [200, { valid: true }];
    },

    'POST /v1/support/ticket': ({ body, user }) => {
      const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
      const message = cut(body.message, 4000);
      if (!message.trim()) return [400, { error: 'empty' }];
      const t = { id: randomToken(8), at: now(), userId: user?.id ?? null, category: cut(body.category, 40), message, contact: cut(body.contact, 200), tech: cut(body.tech, 4000), logs: cut(body.logs, 60000) };
      db.tickets.push(t);
      if (db.tickets.length > 5000) db.tickets.splice(0, db.tickets.length - 5000);
      return [200, { id: t.id }];
    },

    'DELETE /v1/account': ({ user }) => {
      if (!user) return [401, { error: 'unauthorized' }];
      if (user.email) delete db.emails[user.email];
      for (const k of Object.keys(db.identities)) if (db.identities[k] === user.id) delete db.identities[k];
      for (const k of Object.keys(db.devices)) if (db.devices[k] === user.id) delete db.devices[k];
      for (const k of Object.keys(db.tokens)) if (db.tokens[k].userId === user.id) delete db.tokens[k];
      // Receipts stay in the ledger without the owner so they cannot be replayed later.
      for (const k of Object.keys(db.purchases)) if (db.purchases[k].userId === user.id) db.purchases[k].userId = null;
      for (const t of db.tickets) if (t.userId === user.id) { t.userId = null; t.contact = ''; }
      delete db.saves[user.id];
      delete db.users[user.id];
      return [200, { deleted: true }];
    },
  };

  async function handle(req, res) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-max-age': '86400' };
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const url = new URL(req.url, 'http://x');
      const ip = req.socket.remoteAddress ?? '?';
      const isAuth = url.pathname.startsWith('/v1/auth/');
      if (limited(ip, 'all', rate.max) || (isAuth && limited(ip, 'auth', rate.authMax))) return send(429, { error: 'rate_limited' });
      let route = routes[`${req.method} ${url.pathname}`];
      let params = {};
      const hm = /^\/v1\/save\/history\/(\d+)$/.exec(url.pathname);
      if (!route && req.method === 'GET' && hm) {
        params.rev = Number(hm[1]);
        route = ({ user }) => {
          if (!user) return [401, { error: 'unauthorized' }];
          const h = (db.saves[user.id]?.history ?? []).find((x) => x.rev === params.rev);
          return h ? [200, { rev: h.rev, updatedAt: h.updatedAt, doc: h.doc }] : [404, { error: 'no_revision' }];
        };
      }
      if (!route) return send(404, { error: 'not_found' });
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) return send(413, { error: 'too_large' });
          chunks.push(c);
        }
        if (size) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'bad_json' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'bad_json' });
        }
      }
      const [status, out] = await route({ body, user: userFromReq(req), params });
      if (req.method !== 'GET' && status < 400) store.touch();
      send(status, out);
    } catch (e) {
      console.error('request failed', e);
      try { send(500, { error: 'internal' }); } catch { /* socket gone */ }
    }
  }

  return { handle, server: () => http.createServer(handle) };
}
