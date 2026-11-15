// Checks the production bundle: boots, no dev-only providers, integrity self-check works both ways.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, device, launch } from './lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.E2E_RELEASE_BASE ?? 'http://localhost:4173/';
const results = [];
const browser = await launch();
const boot = async () => { const d = await device(browser); await d.page.goto(base); await d.page.waitForSelector('#btn-play', { timeout: 20000 }); await d.page.waitForTimeout(2500); return d; };
let d = await boot();
const info = await d.page.evaluate(() => ({ dev: window.__app.config.dev, modified: window.__app.modified, ads: window.__app.ads.providerName, iap: window.__app.iap.providerName, cloud: window.__app.cloud.enabled }));
check(info.dev === false, 'production bundle is not a dev build', results);
check(info.modified === false, 'integrity self-check passes on the untouched bundle', results);
check(info.ads === 'none' && info.iap === 'none', 'simulated ads / sandbox store are absent from the web release build', results);
await d.page.evaluate(() => window.__app.startBattle('1-1', 'campaign'));
await d.page.waitForFunction(() => !!window.__app.battle);
check(true, 'campaign starts with no backend, no ads and no store (offline play)', results);
check(d.page.errors.length === 0, `no runtime errors (${d.page.errors.length})${d.page.errors[0] ?? ''}`, results);
await d.ctx.close();
// tamper with the shipped script and boot again
const dist = path.join(here, '..', 'dist', 'assets');
const js = fs.readdirSync(dist).find((f) => /^index-.*\.js$/.test(f));
const file = path.join(dist, js), orig = fs.readFileSync(file);
fs.writeFileSync(file, Buffer.concat([orig, Buffer.from('\n/* patched */')]));
try {
  d = await boot();
  const t = await d.page.evaluate(() => ({ modified: window.__app.modified, restricted: window.__app.cloud.restricted }));
  check(t.modified === true && t.restricted === true, 'a patched bundle is detected and online uploads are restricted', results);
  await d.page.evaluate(() => window.__app.startBattle('1-1', 'campaign'));
  await d.page.waitForFunction(() => !!window.__app.battle);
  check(true, 'single-player still works in a modified build (no lock-out)', results);
  await d.ctx.close();
} finally { fs.writeFileSync(file, orig); }
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`RELEASE CHECK: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
