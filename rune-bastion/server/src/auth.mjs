import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expect = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expect.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expect, got);
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export const PROVIDERS = {
  google: { jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] },
  apple: { jwks: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] },
};

/**
 * Verifies a Google / Apple ID token (RS256 JWT): signature against the provider's JWKS,
 * issuer, audience and expiry. `fetchJwks(provider)` is injectable for tests.
 */
export function createOidcVerifier({ audiences, fetchJwks, now = () => Date.now() }) {
  const cache = new Map();
  async function keys(provider) {
    const c = cache.get(provider);
    if (c && now() - c.at < 3600_000) return c.keys;
    const jwks = fetchJwks ? await fetchJwks(provider) : await (await fetch(PROVIDERS[provider].jwks)).json();
    cache.set(provider, { at: now(), keys: jwks.keys ?? [] });
    return jwks.keys ?? [];
  }
  return async function verify(provider, idToken) {
    if (!PROVIDERS[provider] || typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { return null; }
    if (header.alg !== 'RS256') return null;
    let jwk = (await keys(provider)).find((k) => k.kid === header.kid);
    if (!jwk) { cache.delete(provider); jwk = (await keys(provider)).find((k) => k.kid === header.kid); }
    if (!jwk) return null;
    const ok = crypto.createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    if (!PROVIDERS[provider].issuers.includes(payload.iss)) return null;
    const allowed = audiences[provider] ?? [];
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!allowed.length || !aud.some((a) => allowed.includes(a))) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now() - 60_000) return null;
    if (!payload.sub) return null;
    return { sub: String(payload.sub), email: typeof payload.email === 'string' ? payload.email : undefined };
  };
}
