import { chromium, GL_ARGS } from './pw.mjs';

export const BASE = process.env.E2E_BASE ?? 'http://localhost:5199/';
export async function launch() {
  return chromium.launch({ args: GL_ARGS });
}
/** A fresh "device": isolated storage, phone viewport, touch enabled. */
export async function device(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: opts.dpr ?? 1, hasTouch: true, isMobile: true, locale: opts.locale ?? 'en-US', ...(opts.storageState ? { storageState: opts.storageState } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} ${(e.stack ?? '').split('\n').slice(1, 3).join(' | ')}`));
  page.errors = errors;
  return { ctx, page };
}
export async function open(page, query = '') {
  await page.goto(BASE + query);
  await page.waitForSelector('#btn-play', { timeout: 20000 });
}
export const battleState = (page) => page.evaluate(() => { const s = window.__app.battle?.b.s; return s ? { phase: s.phase, wave: s.wave, time: s.time, enemies: s.enemies.length, coins: s.coins, hp: s.castleHp, kills: s.stats.kills, towers: s.towers.map((t) => ({ id: t.id, def: t.def, tier: t.tier, slot: t.slot, branch: t.branch, rank: t.rank })), merges: s.stats.merges, boosts: s.stats.boosts, abilities: s.stats.abilities, offer: s.offer } : null; });
export const slotPt = (page, i) => page.evaluate((i) => { const b = window.__app.battle; const s = b.b.slotPos(i); return b.view.screenOf(s.x, s.y, 0.05); }, i);
export async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x * 2 + to.x) / 3, (from.y * 2 + to.y) / 3, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(250);
}
export async function cardPt(page, def) {
  const b = await page.locator(`.card[data-tower="${def}"]`).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** Fast-forwards the simulation (no UI interaction) until `pred` holds or the phase needs input. */
export async function fastForward(page, untilPhases = ['boost', 'won', 'lost'], maxSeconds = 200, extra = 'false') {
  return page.evaluate(([phases, max, extra]) => {
    const b = window.__app.battle.b;
    let n = 0;
    // eslint-disable-next-line no-new-func
    const stop = new Function('b', `return (${extra});`);
    while (!phases.includes(b.s.phase) && n++ < max * 30 && !stop(b)) b.step();
    return b.s.phase;
  }, [untilPhases, maxSeconds, extra]);
}
export function check(cond, msg, results) {
  results.push({ ok: !!cond, msg });
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
}
