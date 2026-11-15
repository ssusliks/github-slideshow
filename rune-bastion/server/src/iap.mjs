import crypto from 'node:crypto';

/**
 * Store receipt verification. Each verifier resolves to { valid, reason? }.
 * They are only active when the corresponding credentials are configured; otherwise the
 * endpoint answers 503 so clients keep the purchase pending instead of losing or forging it.
 */
const b64url = (b) => Buffer.from(b).toString('base64url');

/** Google Play Developer API (purchases.products.get) authorised with a service account. */
export function createGoogleVerifier({ serviceAccount, packageName, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;
  async function accessToken() {
    if (cached && cached.exp > now() + 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }))}`;
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key).toString('base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}` });
    const data = await res.json();
    if (!data.access_token) throw new Error('google oauth failed');
    cached = { token: data.access_token, exp: now() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  }
  return async function verify({ productId, purchaseToken }) {
    if (!purchaseToken) return { valid: false, reason: 'missing_token' };
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 400 || res.status === 404 || res.status === 410) return { valid: false, reason: 'unknown_purchase' };
    if (!res.ok) throw new Error(`google verify http ${res.status}`);
    const p = await res.json();
    // purchaseState: 0 purchased, 1 cancelled, 2 pending
    return p.purchaseState === 0 ? { valid: true, orderId: p.orderId } : { valid: false, reason: `state_${p.purchaseState}` };
  };
}

/** App Store Server API (Get Transaction Info) authorised with an ES256 key. */
export function createAppleVerifier({ issuerId, keyId, privateKey, bundleId, fetchImpl = fetch, now = () => Date.now() }) {
  function jwt() {
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 1200, aud: 'appstoreconnect-v1', bid: bundleId }))}`;
    const sig = crypto.createSign('SHA256').update(unsigned).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${unsigned}.${sig}`;
  }
  return async function verify({ productId, transactionId }) {
    if (!transactionId) return { valid: false, reason: 'missing_transaction' };
    for (const host of ['api.storekit.itunes.apple.com', 'api.storekit-sandbox.itunes.apple.com']) {
      const res = await fetchImpl(`https://${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, { headers: { authorization: `Bearer ${jwt()}` } });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`apple verify http ${res.status}`);
      const { signedTransactionInfo } = await res.json();
      // The payload arrives over TLS straight from Apple; decode the JWS body.
      const info = JSON.parse(Buffer.from(String(signedTransactionInfo).split('.')[1], 'base64url').toString('utf8'));
      if (info.bundleId !== bundleId) return { valid: false, reason: 'bundle_mismatch' };
      if (info.productId !== productId) return { valid: false, reason: 'product_mismatch' };
      if (info.revocationDate) return { valid: false, reason: 'revoked' };
      return { valid: true };
    }
    return { valid: false, reason: 'unknown_purchase' };
  };
}

/** Builds the verifier map from environment variables. */
export function verifiersFromEnv(env = process.env) {
  const v = {};
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON && env.ANDROID_PACKAGE_NAME) {
    v.android = createGoogleVerifier({ serviceAccount: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), packageName: env.ANDROID_PACKAGE_NAME });
  }
  if (env.APPLE_ISSUER_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY && env.APPLE_BUNDLE_ID) {
    v.ios = createAppleVerifier({ issuerId: env.APPLE_ISSUER_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'), bundleId: env.APPLE_BUNDLE_ID });
  }
  // Development only: accept sandbox transactions created by the game's sandbox store.
  if (env.ALLOW_SANDBOX_IAP === '1') v.sandbox = async ({ purchaseToken, productId }) => ({ valid: purchaseToken === `sandbox:${productId}` });
  return v;
}
