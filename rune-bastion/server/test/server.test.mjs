import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.mjs';
import { createOidcVerifier, hashPassword, verifyPassword } from '../src/auth.mjs';
import { createAppleVerifier, createGoogleVerifier } from '../src/iap.mjs';
import { createStore } from '../src/store.mjs';

// ---- helpers -------------------------------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function idToken(claims, key = privateKey) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', kid: 'test-key' })}.${enc(claims)}`;
  return `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`;
}
const googleClaims = (sub, over = {}) => ({ iss: 'https://accounts.google.com', aud: 'client-1', sub, exp: Math.floor(Date.now() / 1000) + 600, email: `${sub}@example.com`, ...over });

async function boot(opts = {}) {
  const store = createStore(null);
  const app = createApp({
    store,
    iapVerifiers: { sandbox: async ({ purchaseToken, productId }) => ({ valid: purchaseToken === `sandbox:${productId}` }), ...(opts.iapVerifiers ?? {}) },
    oidc: createOidcVerifier({ audiences: { google: ['client-1'], apple: ['com.runebastion.game'] }, fetchJwks: async () => ({ keys: [jwk] }) }),
    ...(opts.rate ? { rate: opts.rate } : {}),
  });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  return { call, store, close: () => new Promise((r) => server.close(r)) };
}
const guest = async (s, deviceId) => (await s.call('POST', '/v1/auth/guest', { deviceId })).data;
const doc = (over = {}) => ({ id: 'p1', v: 1, gold: 100, ...over });

// ---- tests ---------------------------------------------------------------
test('passwords are hashed with scrypt and verified in constant time', () => {
  const h = hashPassword('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword('correct horse', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('guest accounts: created per device, reused for the same device, validated', async () => {
  const s = await boot();
  const a = await guest(s, 'device-aaaa-1111');
  const again = await guest(s, 'device-aaaa-1111');
  const b = await guest(s, 'device-bbbb-2222');
  assert.equal(a.kind, 'guest');
  assert.equal(again.userId, a.userId);
  assert.notEqual(again.token, a.token);
  assert.notEqual(b.userId, a.userId);
  assert.equal((await s.call('POST', '/v1/auth/guest', { deviceId: 'x' })).status, 400);
  await s.close();
});

test('cloud save: upload, download, optimistic concurrency, history and restore', async () => {
  const s = await boot();
  const g = await guest(s, 'device-save-0001');
  assert.equal((await s.call('GET', '/v1/save', null, g.token)).status, 404);
  assert.equal((await s.call('GET', '/v1/save')).status, 401);
  assert.equal((await s.call('GET', '/v1/save', null, 'bogus-token')).status, 401);
  const p1 = await s.call('PUT', '/v1/save', { baseRev: 0, doc: doc({ gold: 1 }), summary: { cleared: 1, score: 1000, playtime: 60 } }, g.token);
  assert.deepEqual([p1.status, p1.data.rev], [200, 1]);
  const p2 = await s.call('PUT', '/v1/save', { baseRev: 1, doc: doc({ gold: 2 }), summary: { cleared: 2, score: 2000, playtime: 120 } }, g.token);
  assert.equal(p2.data.rev, 2);
  // a stale writer (another device that never saw rev 2) is rejected and told the current revision
  const stale = await s.call('PUT', '/v1/save', { baseRev: 1, doc: doc({ gold: 999 }) }, g.token);
  assert.deepEqual([stale.status, stale.data.rev], [409, 2]);
  const got = await s.call('GET', '/v1/save', null, g.token);
  assert.deepEqual([got.data.rev, got.data.doc.gold], [2, 2]);
  const hist = await s.call('GET', '/v1/save/history', null, g.token);
  assert.deepEqual(hist.data.items.map((i) => [i.rev, i.summary.cleared]), [[1, 1]]);
  const old = await s.call('GET', '/v1/save/history/1', null, g.token);
  assert.equal(old.data.doc.gold, 1);
  assert.equal((await s.call('GET', '/v1/save/history/77', null, g.token)).status, 404);
  // history is bounded
  for (let r = 2; r < 12; r++) await s.call('PUT', '/v1/save', { baseRev: r, doc: doc({ gold: r }) }, g.token);
  assert.equal((await s.call('GET', '/v1/save/history', null, g.token)).data.items.length, 5);
  // malformed documents are refused
  assert.equal((await s.call('PUT', '/v1/save', { baseRev: 12, doc: 'nope' }, g.token)).status, 400);
  assert.equal((await s.call('PUT', '/v1/save', { baseRev: 12, doc: [] }, g.token)).status, 400);
  await s.close();
});

test('guest → account upgrade keeps progress and enables cross-device login', async () => {
  const s = await boot();
  const g = await guest(s, 'device-android-01');
  await s.call('PUT', '/v1/save', { baseRev: 0, doc: doc({ gold: 777 }) }, g.token);
  assert.equal((await s.call('POST', '/v1/auth/register', { email: 'bad', password: 'longenough' }, g.token)).status, 400);
  assert.equal((await s.call('POST', '/v1/auth/register', { email: 'a@b.co', password: 'short' }, g.token)).status, 400);
  assert.equal((await s.call('POST', '/v1/auth/register', { email: 'a@b.co', password: 'longenough' })).status, 401);
  const reg = await s.call('POST', '/v1/auth/register', { email: 'Player@Example.com', password: 'longenough' }, g.token);
  assert.deepEqual([reg.status, reg.data.kind, reg.data.email, reg.data.userId], [200, 'account', 'player@example.com', g.userId]);
  // "iOS device": a different install signs in and sees the same save
  assert.equal((await s.call('POST', '/v1/auth/login', { email: 'player@example.com', password: 'nope-nope' })).status, 401);
  const login = await s.call('POST', '/v1/auth/login', { email: 'player@example.com', password: 'longenough' });
  assert.equal(login.data.userId, g.userId);
  assert.equal((await s.call('GET', '/v1/save', null, login.data.token)).data.doc.gold, 777);
  // the e-mail cannot be claimed by someone else
  const other = await guest(s, 'device-other-0002');
  assert.equal((await s.call('POST', '/v1/auth/register', { email: 'player@example.com', password: 'longenough' }, other.token)).status, 409);
  // an upgraded account no longer hands out guest tokens for the old device id
  const re = await guest(s, 'device-android-01');
  assert.notEqual(re.userId, g.userId);
  await s.close();
});

test('Google / Apple identities: link, sign in, reject forged or foreign tokens', async () => {
  const s = await boot();
  const g = await guest(s, 'device-link-0001');
  const tok = idToken(googleClaims('g-123'));
  assert.equal((await s.call('POST', '/v1/auth/oidc', { provider: 'google', idToken: tok })).status, 404);
  const link = await s.call('POST', '/v1/auth/link', { provider: 'google', idToken: tok }, g.token);
  assert.deepEqual([link.status, link.data.links.google, link.data.kind], [200, true, 'account']);
  const login = await s.call('POST', '/v1/auth/oidc', { provider: 'google', idToken: tok });
  assert.equal(login.data.userId, g.userId);
  // another user cannot take the same identity
  const other = await guest(s, 'device-link-0002');
  assert.equal((await s.call('POST', '/v1/auth/link', { provider: 'google', idToken: tok }, other.token)).status, 409);
  // forged signature, wrong audience, wrong issuer, expired
  const forged = idToken(googleClaims('g-123'), crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  for (const bad of [forged, idToken(googleClaims('g-1', { aud: 'someone-else' })), idToken(googleClaims('g-1', { iss: 'https://evil.example' })), idToken(googleClaims('g-1', { exp: 1 })), 'not.a.jwt', '']) {
    assert.equal((await s.call('POST', '/v1/auth/oidc', { provider: 'google', idToken: bad })).status, 401);
  }
  const apple = idToken({ iss: 'https://appleid.apple.com', aud: 'com.runebastion.game', sub: 'a-9', exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await s.call('POST', '/v1/auth/link', { provider: 'apple', idToken: apple }, g.token)).data.links.apple, true);
  assert.equal((await s.call('POST', '/v1/auth/oidc', { provider: 'apple', idToken: apple })).data.userId, g.userId);
  await s.close();
});

test('purchase verification is idempotent and blocks receipt replay', async () => {
  const s = await boot();
  const a = await guest(s, 'device-iap-0001'), b = await guest(s, 'device-iap-0002');
  const tx = { platform: 'sandbox', productId: 'gems_small', transactionId: 'sbx-1', purchaseToken: 'sandbox:gems_small' };
  assert.equal((await s.call('POST', '/v1/iap/verify', tx)).status, 401);
  const first = await s.call('POST', '/v1/iap/verify', tx, a.token);
  assert.deepEqual([first.status, first.data.valid, first.data.duplicate], [200, true, undefined]);
  const retry = await s.call('POST', '/v1/iap/verify', tx, a.token);
  assert.deepEqual([retry.status, retry.data.duplicate], [200, true]);
  const replay = await s.call('POST', '/v1/iap/verify', tx, b.token);
  assert.deepEqual([replay.status, replay.data.valid], [409, false]);
  const fake = await s.call('POST', '/v1/iap/verify', { ...tx, transactionId: 'sbx-2', purchaseToken: 'forged' }, a.token);
  assert.deepEqual([fake.status, fake.data.valid], [402, false]);
  assert.equal((await s.call('POST', '/v1/iap/verify', { ...tx, transactionId: 'x', platform: 'android' }, a.token)).status, 503);
  assert.equal((await s.call('POST', '/v1/iap/verify', { platform: 'sandbox' }, a.token)).status, 400);
  await s.close();
});

test('store verifiers talk to Google / Apple correctly (mocked HTTP)', async () => {
  const sa = { client_email: 'svc@example.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  const gFetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    if (String(url).includes('tok-bad')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ purchaseState: String(url).includes('tok-pending') ? 2 : 0, orderId: 'GPA.1' }) };
  };
  const g = createGoogleVerifier({ serviceAccount: sa, packageName: 'com.runebastion.game', fetchImpl: gFetch });
  assert.deepEqual(await g({ productId: 'gems_small', purchaseToken: 'tok-ok' }), { valid: true, orderId: 'GPA.1' });
  assert.equal((await g({ productId: 'gems_small', purchaseToken: 'tok-pending' })).valid, false);
  assert.equal((await g({ productId: 'gems_small', purchaseToken: 'tok-bad' })).valid, false);
  assert.equal((await g({ productId: 'gems_small' })).valid, false);
  assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1, 'access token is cached');
  assert.ok(calls.some((c) => c.includes('/applications/com.runebastion.game/purchases/products/gems_small/tokens/tok-ok')));

  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jws = (info) => `h.${Buffer.from(JSON.stringify(info)).toString('base64url')}.s`;
  const aFetch = async (url, init) => {
    assert.match(init.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    if (String(url).includes('missing')) return { ok: false, status: 404, json: async () => ({}) };
    const info = String(url).includes('revoked') ? { bundleId: 'com.runebastion.game', productId: 'premium', revocationDate: 1 } : { bundleId: 'com.runebastion.game', productId: 'premium' };
    return { ok: true, status: 200, json: async () => ({ signedTransactionInfo: jws(info) }) };
  };
  const a = createAppleVerifier({ issuerId: 'iss', keyId: 'kid', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), bundleId: 'com.runebastion.game', fetchImpl: aFetch });
  assert.deepEqual(await a({ productId: 'premium', transactionId: '1000' }), { valid: true });
  assert.equal((await a({ productId: 'gems_small', transactionId: '1000' })).reason, 'product_mismatch');
  assert.equal((await a({ productId: 'premium', transactionId: 'revoked' })).reason, 'revoked');
  assert.equal((await a({ productId: 'premium', transactionId: 'missing' })).reason, 'unknown_purchase');
});

test('account deletion removes personal data but keeps receipts unusable', async () => {
  const s = await boot();
  const g = await guest(s, 'device-del-0001');
  await s.call('POST', '/v1/auth/register', { email: 'gone@example.com', password: 'longenough' }, g.token);
  await s.call('PUT', '/v1/save', { baseRev: 0, doc: doc() }, g.token);
  const tx = { platform: 'sandbox', productId: 'premium', transactionId: 'sbx-del', purchaseToken: 'sandbox:premium' };
  await s.call('POST', '/v1/iap/verify', tx, g.token);
  await s.call('POST', '/v1/support/ticket', { category: 'bug', message: 'help', contact: 'gone@example.com' }, g.token);
  assert.equal((await s.call('DELETE', '/v1/account', null, g.token)).status, 200);
  assert.equal((await s.call('GET', '/v1/save', null, g.token)).status, 401);
  assert.equal((await s.call('POST', '/v1/auth/login', { email: 'gone@example.com', password: 'longenough' })).status, 401);
  const db = s.store.db;
  assert.equal(Object.keys(db.users).length, 0);
  assert.equal(Object.keys(db.saves).length, 0);
  assert.equal(JSON.stringify(db).includes('gone@example.com'), false);
  const other = await guest(s, 'device-del-0002');
  assert.equal((await s.call('POST', '/v1/iap/verify', tx, other.token)).status, 409);
  await s.close();
});

test('support tickets, time, CORS, limits and malformed input', async () => {
  const s = await boot();
  const t = await s.call('POST', '/v1/support/ticket', { category: 'purchase', message: 'I paid but got nothing', tech: '{"v":"1.0.0"}' });
  assert.equal(t.status, 200);
  assert.equal(s.store.db.tickets.length, 1);
  assert.equal((await s.call('POST', '/v1/support/ticket', { message: '   ' })).status, 400);
  const time = await s.call('GET', '/v1/time');
  assert.ok(Math.abs(time.data.now - Date.now()) < 5000);
  assert.equal(time.headers.get('access-control-allow-origin'), '*');
  assert.equal((await s.call('GET', '/v1/nope')).status, 404);
  assert.equal((await s.call('POST', '/v1/auth/guest', '{not json')).status, 400);
  assert.equal((await s.call('POST', '/v1/support/ticket', JSON.stringify({ message: 'x'.repeat(400 * 1024) }))).status, 413);
  await s.close();
});

test('rate limiting protects auth endpoints', async () => {
  const s = await boot({ rate: { window: 60_000, max: 1000, authMax: 5 } });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await s.call('POST', '/v1/auth/login', { email: 'a@b.co', password: 'whatever1' })).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[7], 429);
  await s.close();
});

test('the store persists to disk atomically and reloads', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-')), 'db.json');
  const st = createStore(file);
  st.db.users.u1 = { id: 'u1', kind: 'guest' };
  st.flushNow();
  assert.equal(createStore(file).db.users.u1.kind, 'guest');
  fs.writeFileSync(file, '{corrupt');
  assert.deepEqual(createStore(file).db.users, {});
});
