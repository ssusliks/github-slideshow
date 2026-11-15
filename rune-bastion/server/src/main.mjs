import path from 'node:path';
import { createApp } from './app.mjs';
import { createOidcVerifier } from './auth.mjs';
import { verifiersFromEnv } from './iap.mjs';
import { createStore } from './store.mjs';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const store = createStore(env.DATA_FILE ?? path.resolve('data/db.json'));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const app = createApp({
  store,
  iapVerifiers: verifiersFromEnv(env),
  oidc: createOidcVerifier({ audiences: { google: list(env.GOOGLE_CLIENT_IDS), apple: list(env.APPLE_CLIENT_IDS) } }),
});
const server = app.server();
server.listen(port, () => console.log(`rune-bastion-server listening on :${port}`));
const stop = () => { store.flushNow(); server.close(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
