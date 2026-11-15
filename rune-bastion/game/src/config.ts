/**
 * Build / deployment configuration. Everything that differs between development, store builds
 * and platforms lives here (or in VITE_* env variables) – never inside game logic.
 */
const env = (import.meta as any).env ?? {};

export const CONFIG = {
  version: '1.0.0',
  appId: 'com.runebastion.game',
  /** Backend base URL ('' = cloud features disabled, the game stays fully playable offline). */
  apiUrl: (env.VITE_API_URL as string) ?? '',
  /** Development build: enables the sandbox store / simulated ads and debug hooks. */
  dev: !!env.DEV || env.VITE_SANDBOX === '1',
  admob: {
    // Google's public TEST units. Replace with real unit ids via env for store builds.
    rewardedAndroid: (env.VITE_ADMOB_REWARDED_ANDROID as string) ?? 'ca-app-pub-3940256099942544/5224354917',
    rewardedIos: (env.VITE_ADMOB_REWARDED_IOS as string) ?? 'ca-app-pub-3940256099942544/1712485313',
    testing: env.VITE_ADMOB_TESTING !== '0',
  },
  auth: {
    googleWebClientId: (env.VITE_GOOGLE_WEB_CLIENT_ID as string) ?? '',
    googleIosClientId: (env.VITE_GOOGLE_IOS_CLIENT_ID as string) ?? '',
    appleClientId: (env.VITE_APPLE_CLIENT_ID as string) ?? 'com.runebastion.game',
  },
  /** Expected SHA-256 of the release signing certificate (lower-case hex, no colons). '' = skip check. */
  signingCertSha256: (env.VITE_SIGNING_CERT_SHA256 as string) ?? '',
  supportEmail: (env.VITE_SUPPORT_EMAIL as string) ?? 'support@runebastion.example',
  privacyUrl: (env.VITE_PRIVACY_URL as string) ?? '',
};

/** Runtime override used by tests and QA builds: ?api=http://host:port */
export function applyRuntimeOverrides(search: string): void {
  try {
    const q = new URLSearchParams(search);
    const api = q.get('api');
    if (api && CONFIG.dev) CONFIG.apiUrl = api;
  } catch { /* ignore */ }
}
