// End-to-end regression suite: drives the real game UI in a phone-sized Chromium with touch input.
// Usage: npm run e2e     (starts the dev server and the backend itself)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, battleState, cardPt, check, device, drag, fastForward, launch, open, slotPt } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });
const API = 'http://127.0.0.1:8788';
const results = [];
const procs = [];
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up yet */ } await sleep(300); }
  throw new Error(`server not reachable: ${url}`);
}
async function startServers() {
  let up = false;
  try { up = (await fetch(BASE)).ok; } catch { up = false; }
  if (!up) {
    const u = new URL(BASE);
    procs.push(spawn('npx', ['vite', '--port', u.port, '--strictPort'], { cwd: path.join(here, '..'), stdio: 'ignore' }));
    await waitHttp(BASE);
  }
  procs.push(spawn('node', ['src/main.mjs'], { cwd: path.join(here, '..', '..', 'server'), stdio: 'ignore', env: { ...process.env, PORT: '8788', DATA_FILE: path.join(OUT, `db-${Date.now()}.json`), ALLOW_SANDBOX_IAP: '1' } }));
  await waitHttp(`${API}/v1/health`);
}

const tapSlot = async (page, i, h = 0.4) => { const p = await page.evaluate(([i, h]) => { const b = window.__app.battle; const s = b.b.slotPos(i); return b.view.screenOf(s.x, s.y, h); }, [i, h]); await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(250); };
const profile = (page) => page.evaluate(() => { const p = window.__app.game.p; return { gold: p.gold, gems: p.gems, essence: p.essence, campaign: p.campaign, owned: p.owned, shards: p.shards, cards: p.cards, loadout: p.loadout, tutorial: p.tutorial.done, cosmetics: p.cosmetics, research: p.research }; });
const startLevel = async (page, id) => { await page.evaluate((id) => window.__app.startBattle(id, 'campaign'), id); await page.waitForFunction(() => !!window.__app.battle); await page.waitForTimeout(500); };
/** Plays the rest of the current battle: picks boosts through the UI, fast-forwards between them. */
async function finishBattle(page, { buy = true } = {}) {
  for (let guard = 0; guard < 40; guard++) {
    const st = await battleState(page);
    if (!st || st.phase === 'won' || st.phase === 'lost') break;
    if (st.phase === 'boost') { await page.waitForSelector('.boost'); await page.locator('.boost').first().click(); await page.waitForTimeout(200); continue; }
    if (buy) await page.evaluate(() => { const b = window.__app.battle.b; const L = b.s.ctx.loadout; let i = 0; for (let s = 0; s < b.map.slots.length; s++) if (!b.towerAt(s)) { const d = L[i++ % L.length]; if (b.s.coins >= b.buyCost(d)) b.buyTower(d, s); } if (b.s.phase === 'prep') b.startWave(); });
    await fastForward(page, ['boost', 'won', 'lost'], 60);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}
/** Test setup: a well-developed account (max weaponry research, high card levels). */
const boost = (page, power) => page.evaluate((power) => { const g = window.__app.game; g.p.research.weaponry = power; for (const t of Object.keys(g.p.cards)) g.p.cards[t].level = 9; }, power);

// =====================================================================================
async function scenarioTutorialAndPersistence(browser) {
  console.log('\n[1] first launch: tutorial level played with touch input');
  const { ctx, page } = await device(browser);
  await open(page);
  check((await page.locator('#btn-play').innerText()).includes('1-1'), 'main menu offers level 1-1', results);
  await shot(page, 'menu-en');
  await page.click('#btn-play');
  await page.waitForSelector('#btn-start-level');
  await shot(page, 'level-dialog');
  await page.click('#btn-start-level');
  await page.waitForFunction(() => !!window.__app.battle);
  await page.waitForTimeout(900);
  check(await page.locator('.tut').isVisible(), 'tutorial bubble is shown', results);
  check(await page.locator('.hand').isVisible(), 'tutorial pointer animates towards a slot', results);
  let st = await battleState(page);
  check(st.phase === 'prep' && st.wave === 0 && st.enemies === 0 && st.kills === 0, 'battle waits for the player during the tutorial', results);
  await shot(page, 'tutorial-start');

  // drag & drop placement
  const card = await cardPt(page, 'archer');
  await drag(page, card, await slotPt(page, 0));
  await drag(page, card, await slotPt(page, 1));
  st = await battleState(page);
  check(st.towers.length === 2 && st.towers.every((t) => t.def === 'archer'), 'two archers placed by drag & drop', results);
  check(st.coins === 150 - 50 - 55, `coins were charged (left ${st.coins})`, results);
  // dropping on an occupied slot and outside the board does nothing
  await drag(page, card, await slotPt(page, 0));
  await drag(page, card, { x: 20, y: 300 });
  check((await battleState(page)).towers.length === 2, 'cannot place on an occupied slot or outside the board', results);

  await page.click('#btn-start', { force: true });
  await page.waitForTimeout(300);
  check((await battleState(page)).phase === 'wave', 'wave starts from the Start button', results);
  // towers fight on their own
  await fastForward(page, ['boost', 'won', 'lost'], 60, 'b.s.enemies.length >= 1 && b.s.waveT > 2.5');
  await page.waitForTimeout(300);
  st = await battleState(page);
  check(st.enemies >= 1, 'enemies walk the road', results);
  // active ability: tap the button, then tap the enemies
  const target = await page.evaluate(() => { const b = window.__app.battle; const e = b.b.s.enemies.reduce((a, c) => (c.dist > a.dist ? c : a)); return b.view.screenOf(e.x, e.y, 0.3); });
  await page.locator('[data-ability="meteor"]').click();
  await page.touchscreen.tap(target.x, target.y);
  await page.waitForTimeout(300);
  const after = await battleState(page);
  check(after.abilities === 1, 'meteor ability used by tap-to-target', results);
  check(await page.locator('[data-ability="meteor"].cooling').count() === 1, 'ability shows its cooldown', results);
  await shot(page, 'battle-wave');
  await fastForward(page, ['boost', 'won', 'lost'], 120);
  await page.waitForSelector('.boost', { timeout: 5000 });
  st = await battleState(page);
  check(st.phase === 'boost' && st.offer.length === 3, 'three boosts offered after the wave', results);
  check(st.kills > 0, `towers killed enemies automatically (${st.kills} kills)`, results);
  await shot(page, 'boost-choice');
  const t0 = st.time;
  await page.waitForTimeout(600);
  check((await battleState(page)).time === t0, 'battle is paused while choosing', results);
  await page.locator('.boost').nth(1).click();
  await page.waitForTimeout(300);
  check((await battleState(page)).boosts === 1, 'boost picked', results);

  // merge by dragging one tower onto the other: preview -> cancel -> preview -> confirm
  await page.evaluate(() => { window.__app.battle.b.s.coins += 0; });
  st = await battleState(page);
  await drag(page, await page.evaluate(() => { const b = window.__app.battle; const s = b.b.slotPos(0); return b.view.screenOf(s.x, s.y, 0.4); }), await slotPt(page, 1));
  await page.waitForSelector('#btn-merge-confirm', { timeout: 5000 });
  await shot(page, 'merge-preview');
  check((await page.locator('.merge-opt').count()) === 1, 'merge preview shows the result', results);
  check((await page.locator('.merge-opt .stats').innerText()).includes('DPS'), 'preview lists the new stats', results);
  const coinsBefore = (await battleState(page)).coins;
  await page.click('#btn-merge-cancel');
  await page.waitForTimeout(250);
  st = await battleState(page);
  check(st.towers.length === 2 && st.coins === coinsBefore && st.merges === 0, 'cancelling the merge changes nothing', results);
  await drag(page, await page.evaluate(() => { const b = window.__app.battle; const s = b.b.slotPos(0); return b.view.screenOf(s.x, s.y, 0.4); }), await slotPt(page, 1));
  await page.waitForSelector('#btn-merge-confirm');
  await page.click('#btn-merge-confirm');
  await page.waitForTimeout(400);
  st = await battleState(page);
  check(st.towers.length === 1 && st.towers[0].tier === 2 && st.towers[0].slot === 1 && st.merges === 1, 'merge confirmed: one tier II tower on the target slot', results);
  check(st.coins === coinsBefore - 10, 'merge fee charged once', results);
  check(await page.locator('.panel').isVisible(), 'tower panel opens for the merged tower', results);
  await shot(page, 'tower-panel');
  // upgrade from the panel
  await page.evaluate(() => { window.__app.battle.b.s.coins = 400; });
  await page.waitForTimeout(300);
  await page.click('#btn-upgrade');
  await page.waitForTimeout(250);
  check((await battleState(page)).towers[0].rank === 1, 'tower upgraded from the panel', results);
  await page.locator('.panel .x').click();
  // speed toggle and pause
  await page.click('#btn-speed');
  check((await page.locator('#btn-speed').innerText()) === '×2', 'game speed toggles to x2', results);
  await page.click('#btn-speed');
  await page.click('#btn-pause');
  await page.waitForSelector('#btn-resume');
  const pausedAt = (await battleState(page)).time;
  await page.waitForTimeout(500);
  check((await battleState(page)).time === pausedAt, 'pause stops the battle', results);
  await page.click('#btn-resume');

  const before = await profile(page);
  await finishBattle(page);
  await page.waitForSelector('#result', { timeout: 8000 });
  await shot(page, 'victory');
  st = await battleState(page);
  check(st.phase === 'won', 'level 1-1 won', results);
  const p1 = await profile(page);
  check(p1.campaign['1-1']?.stars >= 1, `result recorded with ${p1.campaign['1-1']?.stars} star(s)`, results);
  check(p1.gold > before.gold && p1.gems > before.gems, `rewards granted (gold ${before.gold} -> ${p1.gold}, gems ${before.gems} -> ${p1.gems})`, results);
  check(p1.tutorial === true, 'tutorial marked as completed', results);
  // rewarded ad: double the reward (simulated ad provider in dev builds)
  await page.click('#btn-double');
  await page.waitForSelector('.adsim');
  await shot(page, 'test-ad');
  check(await page.locator('.adsim-claim').isDisabled(), 'reward cannot be claimed before the ad ends', results);
  await page.waitForSelector('.adsim-claim:not([disabled])', { timeout: 8000 });
  await page.click('.adsim-claim');
  await page.waitForTimeout(400);
  const p2 = await profile(page);
  check(p2.gold > p1.gold, `watching the ad doubled the gold (${p1.gold} -> ${p2.gold})`, results);
  check((await page.locator('#btn-double').count()) === 0, 'double reward can only be used once', results);
  await page.click('#btn-next');
  await page.waitForFunction(() => window.__app.battle?.b.s.ctx.levelId === '1-2');
  await page.waitForTimeout(500);
  check((await battleState(page)).phase === 'boost', 'next level starts with a blessing choice (no tutorial)', results);
  await page.locator('.boost').first().click();
  // leave through pause -> map
  await page.click('#btn-pause');
  await page.click('#btn-quit');
  await page.locator('.dialog .btn.primary').last().click();
  await page.waitForSelector('.levels');
  const p3 = await profile(page);
  check(p3.gold === p2.gold && !p3.campaign['1-2'], 'leaving a battle gives no rewards', results);
  check((await page.locator('.level.done').count()) === 1 && (await page.locator('.level.locked').count()) === 4, 'map shows 1 cleared, 1 open and 4 locked levels', results);
  await shot(page, 'map');

  console.log('\n[2] persistence across restarts');
  await page.reload();
  await page.waitForSelector('#btn-play');
  const p4 = await profile(page);
  check(p4.gold === p3.gold && p4.gems === p3.gems && p4.campaign['1-1'].stars === p3.campaign['1-1'].stars, 'progress survives an app restart', results);
  check((await page.locator('#btn-play').innerText()).includes('1-2'), 'menu continues from level 1-2', results);
  check(page.errors.length === 0, `no runtime errors (${page.errors.length})${page.errors.length ? ': ' + page.errors[0] : ''}`, results);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function scenarioMergesAndHybrids(browser) {
  console.log('\n[3] merge rules through the UI: forbidden pairs, hybrids with a choice, evolutions');
  const { ctx, page } = await device(browser);
  await open(page);
  await page.evaluate(() => { const g = window.__app.game; for (const l of ['1-1', '1-2', '1-3', '1-4', '1-5', '1-6']) g.p.campaign[l] = { stars: 3, clears: 1 }; g.p.tutorial.done = true; g.p.cards.ice = { level: 1, mastery: 0 }; g.p.research.alchemy = 1; g.p.loadout = ['archer', 'cannon', 'fire', 'ice']; });
  await startLevel(page, '1-3');
  await page.locator('.boost').first().click();
  await page.evaluate(() => { const b = window.__app.battle.b; b.s.coins = 5000; b.buyTower('archer', 0); b.buyTower('cannon', 1); b.buyTower('fire', 2); b.buyTower('fire', 3); b.buyTower('ice', 4); b.buyTower('ice', 5); });
  await page.waitForTimeout(400);
  const hi = (i) => page.evaluate((i) => { const b = window.__app.battle; const s = b.b.slotPos(i); return b.view.screenOf(s.x, s.y, 0.4); }, i);
  // archer onto cannon: no recipe
  await drag(page, await hi(0), await slotPt(page, 1));
  await page.waitForTimeout(300);
  let st = await battleState(page);
  check(st.towers.length === 6 && (await page.locator('#btn-merge-confirm').count()) === 0, 'incompatible towers do not merge (archer + cannon)', results);
  check((await page.locator('.toast').count()) > 0, 'the player is told why', results);
  // fire tier I onto ice tier I: recipe exists but tier is too low
  await drag(page, await hi(2), await slotPt(page, 4));
  await page.waitForTimeout(300);
  check((await battleState(page)).towers.length === 6, 'hybrid needs tier II towers', results);
  // make fire II and ice II
  await drag(page, await hi(2), await slotPt(page, 3));
  await page.click('#btn-merge-confirm');
  await page.waitForTimeout(300);
  await drag(page, await hi(4), await slotPt(page, 5));
  await page.click('#btn-merge-confirm');
  await page.waitForTimeout(300);
  await page.locator('.panel .x').click().catch(() => undefined);
  // merge mode from the panel highlights the valid partner
  await tapSlot(page, 3);
  await page.click('#btn-merge');
  await page.waitForTimeout(300);
  check(await page.locator('.mode-hint').isVisible(), 'merge mode shows a hint and highlights partners', results);
  await shot(page, 'merge-mode');
  await tapSlot(page, 5);
  await page.waitForSelector('#btn-merge-confirm');
  check((await page.locator('.merge-opt').count()) === 2, 'fire + ice offers two hybrid results', results);
  check(await page.locator('.choose').isVisible(), 'the player is asked to choose', results);
  await shot(page, 'hybrid-choice');
  await page.locator('.merge-opt').nth(1).click();
  check(await page.locator('.merge-opt').nth(1).evaluate((el) => el.classList.contains('picked')), 'second option can be selected', results);
  await page.click('#btn-merge-confirm');
  await page.waitForTimeout(400);
  st = await battleState(page);
  check(st.towers.some((t) => t.def === 'steam' && t.tier === 3), 'chosen hybrid (Steam Geyser, tier III) created', results);
  check(st.towers.length === 3, 'both source towers were consumed', results);
  // evolution choice: two archers II -> branch options
  await page.evaluate(() => { const b = window.__app.battle.b; b.sellTower(b.s.towers.find((t) => t.def === 'cannon').id); b.s.coins = 5000; const free = () => b.map.slots.findIndex((_, i) => !b.towerAt(i)); for (let i = 0; i < 3; i++) b.buyTower('archer', free()); const a = b.s.towers.filter((t) => t.def === 'archer'); b.merge(a[0].id, a[1].id, 0); const c = b.s.towers.filter((t) => t.def === 'archer' && t.tier === 1); b.merge(c[0].id, c[1].id, 0); });
  await page.waitForTimeout(400);
  st = await battleState(page);
  const [a1, a2] = st.towers.filter((t) => t.def === 'archer' && t.tier === 2);
  await drag(page, await hi(a1.slot), await slotPt(page, a2.slot));
  await page.waitForSelector('#btn-merge-confirm');
  check((await page.locator('.merge-opt').count()) === 2, 'tier III offers two evolution branches', results);
  await shot(page, 'evolution-choice');
  await page.locator('.merge-opt').nth(0).click();
  await page.click('#btn-merge-confirm');
  await page.waitForTimeout(400);
  st = await battleState(page);
  check(st.towers.some((t) => t.def === 'archer' && t.tier === 3 && t.branch === 'marksman'), 'archer evolved into the Marksman', results);
  // hybrid cannot merge with a base tower
  const steam = st.towers.find((t) => t.def === 'steam'), mk = st.towers.find((t) => t.branch === 'marksman');
  await drag(page, await hi(steam.slot), await slotPt(page, mk.slot));
  await page.waitForTimeout(300);
  check((await battleState(page)).towers.length === st.towers.length, 'hybrid + evolved tower is refused', results);
  // move a tower to a free slot by dragging
  const free = await page.evaluate(() => { const b = window.__app.battle.b; return b.map.slots.findIndex((_, i) => !b.towerAt(i)); });
  await drag(page, await hi(mk.slot), await slotPt(page, free));
  check((await battleState(page)).towers.find((t) => t.id === mk.id)?.slot === free, 'towers can be moved to a free slot', results);
  // camera: drag on empty ground pans, the board stays usable
  const c0 = await page.evaluate(() => window.__app.battle.view.center.x);
  await drag(page, { x: 195, y: 330 }, { x: 120, y: 300 });
  const c1 = await page.evaluate(() => window.__app.battle.view.center.x);
  check(c1 !== c0, 'dragging the ground pans the camera', results);
  await page.evaluate(() => { const v = window.__app.battle.view; v.zoomBy(1.5); });
  check(await page.evaluate(() => window.__app.battle.view.zoom) === 1.5, 'camera zoom is clamped and applied', results);
  await page.evaluate(() => window.__app.battle.view.resetCamera());
  await page.waitForTimeout(300);
  await shot(page, 'battle-evolved');
  check(page.errors.length === 0, `no runtime errors (${page.errors.length})${page.errors.length ? ': ' + page.errors[0] : ''}`, results);
  await ctx.close();
}

async function scenarioDefeatBossAndEndless(browser) {
  console.log('\n[4] defeat, second chance, boss level, endless mode');
  const { ctx, page } = await device(browser);
  await open(page);
  await page.evaluate(() => { const g = window.__app.game; for (const l of ['1-1', '1-2', '1-3', '1-4', '1-5']) g.p.campaign[l] = { stars: 3, clears: 1 }; g.p.tutorial.done = true; g.p.gems = 100; });
  // lose on purpose: no towers
  await startLevel(page, '1-5');
  await page.locator('.boost').first().click();
  await finishBattle(page, { buy: false });
  await page.waitForSelector('#btn-giveup', { timeout: 8000 });
  await shot(page, 'defeat');
  check((await battleState(page)).phase === 'lost', 'castle falls when nothing defends it', results);
  check(await page.locator('#btn-revive-ad').isVisible() && await page.locator('#btn-revive-gems').isVisible(), 'continue is offered for an ad or gems (never for money)', results);
  const gems = (await profile(page)).gems;
  await page.click('#btn-revive-gems');
  await page.waitForTimeout(400);
  let st = await battleState(page);
  check(st.phase !== 'lost' && st.hp > 0, 'second chance restores the castle and the battle goes on', results);
  check((await profile(page)).gems === gems - 15, 'gems were spent for the continue', results);
  await finishBattle(page, { buy: false });
  await page.waitForSelector('#result', { timeout: 8000 });
  check((await page.locator('#btn-revive-gems').count()) === 0, 'only one continue per battle', results);
  const p = await profile(page);
  check(!p.campaign['1-5'].clears || p.campaign['1-5'].clears === 1, 'a lost battle does not count as a clear', results);
  await page.click('#btn-result-map');
  await page.waitForSelector('.levels');

  // boss level
  await boost(page, 10);
  await startLevel(page, '1-6');
  await page.locator('.boost').first().click();
  await page.evaluate(() => { const b = window.__app.battle.b; b.s.wave = b.level.waves - 1; b.s.coins = 3000; });
  await page.evaluate(() => { const b = window.__app.battle.b; for (let s = 0; s < b.map.slots.length; s++) b.buyTower(['archer', 'cannon', 'fire'][s % 3], s); b.startWave(); });
  await page.waitForTimeout(700);
  check(await page.locator('.banner.boss').count() === 1, 'boss wave is announced', results);
  await fastForward(page, ['boost', 'won', 'lost'], 40, 'b.s.enemies.filter((e) => !e.boss).length >= 3 && b.s.enemies.some((e) => e.boss)');
  await page.waitForTimeout(500);
  st = await battleState(page);
  await shot(page, 'boss-fight');
  const bossInfo = await page.evaluate(() => { const b = window.__app.battle.b; return { boss: b.s.enemies.some((e) => e.boss), minions: b.s.enemies.filter((e) => !e.boss).length }; });
  check(bossInfo.boss, 'boss is on the field with his escort', results);
  await finishBattle(page);
  await page.waitForSelector('#result', { timeout: 8000 });
  st = await battleState(page);
  check(st.phase === 'won', 'boss level can be won', results);
  check((await page.locator('.unlock').count()) >= 2, 'victory unlocks a new world and endless mode', results);
  await shot(page, 'boss-victory');
  const pb = await profile(page);
  check(pb.essence >= 20, `boss dropped essence (${pb.essence})`, results);
  await page.click('#btn-result-map');
  await page.waitForSelector('.levels');

  // endless
  await page.click('#tab-menu');
  await page.click('#btn-endless');
  await page.waitForSelector('#btn-start-endless');
  await page.click('#btn-start-endless');
  await page.waitForFunction(() => window.__app.battle?.b.s.ctx.mode === 'endless');
  await page.waitForTimeout(400);
  await page.locator('.boost').first().click();
  for (let i = 0; i < 6; i++) { const s = await battleState(page); if (s.phase === 'lost' || s.wave >= 3) break; await finishBattleStep(page); }
  st = await battleState(page);
  check(st.wave >= 3, `endless mode keeps sending waves (wave ${st.wave + 1})`, results);
  await page.evaluate(() => { const b = window.__app.battle.b; for (const t of [...b.s.towers]) b.sellTower(t.id); });
  await finishBattle(page, { buy: false });
  await page.waitForSelector('#btn-giveup', { timeout: 10000 });
  await page.click('#btn-giveup');
  await page.waitForSelector('#result');
  check((await page.locator('#result h1').innerText()).length > 0, 'endless run ends with a result screen', results);
  const pe = await profile(page);
  check(pe.gold > pb.gold, 'endless run pays gold', results);
  await shot(page, 'endless-result');
  check(page.errors.length === 0, `no runtime errors (${page.errors.length})${page.errors.length ? ': ' + page.errors[0] : ''}`, results);
  await ctx.close();
}
async function finishBattleStep(page) {
  const st = await battleState(page);
  if (st.phase === 'boost') { await page.waitForSelector('.boost'); await page.locator('.boost').first().click(); await page.waitForTimeout(150); return; }
  await page.evaluate(() => { const b = window.__app.battle.b; const L = b.s.ctx.loadout; let i = 0; for (let s = 0; s < b.map.slots.length; s++) if (!b.towerAt(s)) { const d = L[i++ % L.length]; if (b.s.coins >= b.buyCost(d)) b.buyTower(d, s); } if (b.s.phase === 'prep') b.startWave(); });
  await fastForward(page, ['boost', 'won', 'lost'], 60);
  await page.waitForTimeout(150);
}

async function scenarioLifecycle(browser) {
  console.log('\n[5] app lifecycle: background / resume, process death, crash recovery');
  const { ctx, page } = await device(browser);
  await open(page);
  await page.evaluate(() => { const g = window.__app.game; g.p.campaign['1-1'] = { stars: 3, clears: 1 }; g.p.tutorial.done = true; window.__app.markDirty(true); });
  await startLevel(page, '1-2');
  await page.locator('.boost').first().click();
  await page.evaluate(() => { const b = window.__app.battle.b; b.buyTower('archer', 0); b.buyTower('archer', 2); b.startWave(); });
  await fastForward(page, ['boost', 'won', 'lost'], 8, 'b.s.time > 6');
  const hide = (hidden) => page.evaluate((hidden) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  await hide(true);
  const j1 = await page.evaluate(() => window.__app.readJournal());
  check(j1?.clean === true && !!j1.snapshot, 'going to background stores a resumable snapshot', results);
  const t1 = (await battleState(page)).time;
  await page.waitForTimeout(700);
  await hide(false);
  await page.waitForSelector('#btn-resume');
  check((await battleState(page)).time - t1 < 0.25, 'the battle does not run in the background', results);
  check((await page.evaluate(() => window.__app.readJournal())).clean === false, 'back in foreground the journal is "dirty" again', results);
  await page.click('#btn-resume');
  // process killed while in background -> next start offers to resume
  await fastForward(page, ['boost', 'won', 'lost'], 5, 'b.s.time > 9');
  const before = await battleState(page);
  await hide(true);
  await page.reload();
  await page.waitForSelector('.dialog');
  await shot(page, 'resume-dialog');
  await page.locator('.dialog .btn.primary').click();
  await page.waitForFunction(() => !!window.__app.battle);
  await page.waitForTimeout(500);
  const resumed = await battleState(page);
  check(resumed.towers.length === before.towers.length && Math.abs(resumed.time - before.time) < 0.2 && resumed.coins === before.coins && resumed.kills === before.kills, 'battle restored exactly where it was left', results);
  await page.click('#btn-resume');
  await finishBattle(page);
  await page.waitForSelector('#result', { timeout: 8000 });
  const pr = await profile(page);
  check(!!pr.campaign['1-2'], 'the resumed battle can be finished and rewarded', results);
  await page.click('#btn-result-map');
  // crash: process dies while the battle is running (no clean snapshot)
  const gold = pr.gold;
  await startLevel(page, '1-3');
  await page.locator('.boost').first().click();
  await page.evaluate(() => { const b = window.__app.battle.b; b.buyTower('archer', 0); b.startWave(); });
  await fastForward(page, ['boost', 'won', 'lost'], 5, 'b.s.time > 5');
  // A real crash runs no lifecycle handlers: disable them before killing the page.
  await page.evaluate(() => { window.__app.battle.suspend = () => undefined; });
  await page.reload();
  await page.waitForSelector('.dialog');
  await shot(page, 'crash-dialog');
  const pc = await profile(page);
  check(pc.gold === gold && !pc.campaign['1-3'], 'a crash gives no rewards and keeps earlier progress', results);
  await page.locator('.dialog .btn.primary').click();
  await page.waitForFunction(() => !!window.__app.battle);
  await page.waitForTimeout(400);
  const fresh = await battleState(page);
  check(fresh.time === 0 && fresh.towers.length === 0 && fresh.wave === 0, 'after a crash the level starts again from the beginning', results);
  // runtime error inside the battle loop is contained
  await page.locator('.boost').first().click();
  await page.evaluate(() => { window.__app.battle.b.step = () => { throw new Error('simulated battle failure'); }; window.__app.battle.b.advance = () => { throw new Error('simulated battle failure'); }; });
  await page.waitForSelector('.dialog h2', { timeout: 5000 });
  check((await page.locator('.dialog').count()) >= 1, 'a battle error stops the battle safely with a dialog', results);
  await page.locator('.dialog .btn.ghost').click();
  await page.waitForSelector('#btn-play, .levels');
  check((await profile(page)).gold === gold, 'no rewards after an aborted battle', results);
  // a damaged save is repaired from a backup
  await page.evaluate(() => { const a = window.__app; a.game.p.gold = 4242; a.markDirty(true); a.flush(true); a.game.p.gold = 4243; a.markDirty(true); a.flush(true); localStorage.setItem('rb.save', '{"broken":'); });
  await page.reload();
  await page.waitForSelector('#btn-play');
  check([4242, 4243].includes((await profile(page)).gold), 'a corrupted save is restored from a backup', results);
  await ctx.close();
}

async function scenarioMetaScreens(browser, storageState) {
  console.log('\n[6] menus, three languages, shop, sandbox purchases, ads, settings');
  const { ctx, page } = await device(browser, { storageState });
  await open(page);
  await page.evaluate(() => { const g = window.__app.game; g.p.gold = 5000; g.p.essence = 50; g.p.shards.archer = 20; for (const l of ['1-2', '1-3']) g.p.campaign[l] = { stars: 3, clears: 1 }; window.__app.markDirty(true); window.__app.refresh(); });
  const rawKey = /\b(ui|nav|tower|branch|enemy|boost|research|quest|ach|shop|acct|cloud|set|support|menu|map|prep|towers|quests|login|premium|iap|gem|cos|event|err|merge|act|fx|el|rarity|attack|world|ability|win|lose|offline|endless|offer|hint|tut|ad|save|resume|crash|privacy|backup)\.[a-z_0-9]+(\.[a-z_0-9]+)*\b/;
  const screens = ['menu', 'map', 'towers', 'research', 'quests', 'shop', 'settings'];
  for (const lang of ['en', 'ru', 'kk']) {
    await page.evaluate((lang) => { const a = window.__app; a.settings.lang = lang; a.applySettings(); a.refresh(); }, lang);
    let bad = [];
    for (const s of screens) {
      await page.evaluate((s) => window.__app.nav(s), s);
      await page.waitForTimeout(250);
      const text = await page.locator('#screen').innerText();
      const m = text.match(rawKey);
      if (m) bad.push(`${s}: ${m[0]}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) bad.push(`${s}: horizontal overflow`);
      if (lang !== 'en' || ['towers', 'research', 'quests', 'shop', 'settings'].includes(s)) await shot(page, `${s}-${lang}`);
    }
    check(bad.length === 0, `all screens render in "${lang}" without missing texts or overflow${bad.length ? ' -> ' + bad.join('; ') : ''}`, results);
  }
  await page.evaluate(() => { const a = window.__app; a.settings.lang = 'ru'; a.applySettings(); a.refresh(); });
  await page.reload();
  await page.waitForSelector('#btn-play');
  check((await page.locator('#btn-play').innerText()).includes('Играть'), 'language choice persists', results);
  await page.evaluate(() => { const a = window.__app; a.settings.lang = 'en'; a.applySettings(); a.refresh(); });

  // towers: card upgrade
  await page.click('#tab-towers');
  await page.locator('.tcard[data-tower="archer"]').click();
  await page.waitForSelector('#btn-card-upgrade');
  await shot(page, 'tower-card');
  let p = await profile(page);
  await page.click('#btn-card-upgrade');
  await page.waitForTimeout(250);
  let q = await profile(page);
  check(q.cards.archer.level === p.cards.archer.level + 1 && q.gold < p.gold && q.shards.archer < p.shards.archer, 'tower card upgraded for shards and gold', results);
  await page.locator('.modal .x').click();
  await page.locator('[data-hybrid="frostfire"]').click();
  check(await page.locator('.dialog h2').isVisible(), 'hybrid recipe book opens', results);
  await page.locator('.modal .x').click();
  // research
  await page.click('#tab-research');
  await page.locator('[data-node="weaponry"]').click();
  await page.click('#btn-research-buy');
  await page.waitForTimeout(200);
  check((await profile(page)).research.weaponry === 1, 'research purchased', results);
  await page.locator('.modal .x').click();
  await page.locator('[data-node="rapid"]').click();
  check(await page.locator('#btn-research-buy').isDisabled() && await page.locator('.locked-note').isVisible(), 'locked research explains its requirement', results);
  await page.locator('.modal .x').click();
  // quests: login reward
  await page.click('#tab-quests');
  await page.locator('[data-qtab="login"]').click();
  p = await profile(page);
  await page.click('#btn-login-claim');
  await page.waitForTimeout(300);
  await page.locator('.dialog .btn.primary').click();
  q = await profile(page);
  check(q.gold === p.gold + 150, 'daily login reward claimed', results);
  check(await page.locator('#btn-login-claim').isDisabled(), 'login reward cannot be claimed twice', results);
  await page.locator('[data-qtab="daily"]').click();
  check((await page.locator('.quest').count()) === 3, 'three daily quests are listed', results);
  await page.locator('[data-qtab="ach"]').click();
  check((await page.locator('.quest').count()) >= 8, 'achievements are listed', results);
  // shop: rewarded ad with a daily cap
  await page.click('#tab-shop');
  p = await profile(page);
  for (let i = 0; i < 3; i++) {
    await page.locator('[data-ad="free_gold"]').click();
    await page.waitForSelector('.adsim-claim:not([disabled])', { timeout: 8000 });
    await page.click('.adsim-claim');
    await page.waitForTimeout(250);
    await page.locator('.dialog .btn.primary').click();
    await page.waitForTimeout(150);
  }
  q = await profile(page);
  check(q.gold > p.gold, `free gold for ads granted (${p.gold} -> ${q.gold})`, results);
  check(await page.locator('[data-ad="free_gold"]').isDisabled(), 'ad reward respects its daily cap (3/day)', results);
  // closing an ad early gives nothing
  p = await profile(page);
  await page.locator('[data-ad="free_shards"]').click();
  await page.waitForSelector('.adsim');
  await page.click('.adsim-skip');
  await page.waitForTimeout(250);
  q = await profile(page);
  check(JSON.stringify(q.shards) === JSON.stringify(p.shards), 'closing an ad early gives no reward', results);
  // sandbox purchase
  p = await profile(page);
  await page.locator('[data-iap="gems_small"]').click();
  await page.waitForSelector('.dialog');
  await shot(page, 'sandbox-purchase');
  await page.locator('.dialog .btn.ghost').click();
  await page.waitForTimeout(250);
  check((await profile(page)).gems === p.gems, 'cancelled purchase changes nothing', results);
  await page.locator('[data-iap="gems_small"]').click();
  await page.locator('.dialog .btn.primary').click();
  await page.waitForTimeout(500);
  await page.locator('.dialog .btn.primary').click();
  q = await profile(page);
  check(q.gems === p.gems + 80, 'sandbox purchase delivered 80 gems', results);
  await page.locator('[data-iap="premium"]').click();
  await page.locator('.dialog .btn.primary').click();
  await page.waitForTimeout(500);
  await page.locator('.dialog .btn.primary').click();
  q = await profile(page);
  check(q.owned.includes('premium') && q.cosmetics.owned.includes('royal'), 'Premium purchased once; castle skin unlocked', results);
  check((await page.locator('[data-iap="premium"]').count()) === 0, 'Premium cannot be bought twice', results);
  await page.locator('[data-skin="royal"]').click();
  check((await profile(page)).cosmetics.castle === 'royal', 'castle skin equipped', results);
  // gem shop
  p = await profile(page);
  await page.locator('[data-gem="shard_chest"]').click();
  await page.waitForTimeout(250);
  await page.locator('.dialog .btn.primary').click();
  check((await profile(page)).gems === p.gems - 50, 'gem shop item bought', results);
  await shot(page, 'shop-after');
  // settings
  await page.click('#btn-settings');
  await page.locator('#set-fps [data-v="60"]').click();
  await page.locator('#set-quality [data-v="low"]').click();
  await page.locator('#set-vibration').uncheck();
  await page.locator('#set-music').fill('0.2');
  const s = await page.evaluate(() => window.__app.settings);
  check(s.fps === 60 && s.quality === 'low' && s.vibration === false && Math.abs(s.music - 0.2) < 0.01, 'settings change and apply (fps, quality, vibration, volume)', results);
  check(await page.evaluate(() => window.__app.limiter.fps) === 60, 'frame limiter follows the fps setting', results);
  // backups list + support form
  await page.click('#btn-backups');
  check((await page.locator('[data-backup]').count()) >= 1, 'local backups are listed', results);
  await page.locator('.modal .x').click();
  await page.click('#btn-support');
  await page.fill('#sup-msg', 'Test ticket from the e2e suite');
  await shot(page, 'support');
  await page.locator('.modal .x').click();
  check(page.errors.length === 0, `no runtime errors (${page.errors.length})${page.errors.length ? ': ' + page.errors[0] : ''}`, results);
  await ctx.close();
}

async function scenarioCloud(browser) {
  console.log('\n[7] accounts and cloud saves across two devices (real backend)');
  const A = await device(browser), B = await device(browser);
  const q = `?api=${encodeURIComponent(API)}`;
  await open(A.page, q);
  await A.page.evaluate(() => { const g = window.__app.game; for (const l of ['1-1', '1-2', '1-3', '1-4']) g.p.campaign[l] = { stars: 3, clears: 1 }; g.p.gold = 3333; g.p.playtime = 4000; g.p.tutorial.done = true; g.p.rev += 5; window.__app.markDirty(true); });
  const s1 = await A.page.evaluate(() => window.__app.syncCloud(true));
  check(s1 === 'uploaded', 'device A: guest progress uploaded to the cloud', results);
  check(await A.page.evaluate(() => window.__app.cloud.auth?.kind) === 'guest', 'device A plays as a guest without registering', results);
  await A.page.click('#btn-settings');
  await A.page.click('#btn-register');
  const email = `e2e${Date.now()}@example.com`;
  await A.page.fill('#in-email', email);
  await A.page.fill('#in-pass', 'password123');
  await A.page.click('#btn-acct-submit');
  await A.page.waitForFunction(() => window.__app.cloud.auth?.kind === 'account', null, { timeout: 8000 });
  check(true, 'device A: guest upgraded to an account (progress kept)', results);
  await A.page.waitForTimeout(600);
  await shot(A.page, 'account');

  await open(B.page, q);
  await B.page.click('#btn-settings');
  await B.page.click('#btn-login');
  await B.page.fill('#in-email', email);
  await B.page.fill('#in-pass', 'wrong-password');
  await B.page.click('#btn-acct-submit');
  await B.page.waitForTimeout(700);
  check(await B.page.evaluate(() => window.__app.cloud.auth?.kind) !== 'account', 'device B: wrong password is rejected', results);
  await B.page.fill('#in-pass', 'password123');
  await B.page.click('#btn-acct-submit');
  await B.page.waitForFunction(() => Object.keys(window.__app.game.p.campaign).length === 4, null, { timeout: 8000 });
  const pb = await profile(B.page);
  check(pb.gold === 3333, 'device B: signing in brings the progress from device A', results);
  // B plays on, A receives it
  await B.page.evaluate(() => { const g = window.__app.game; g.p.campaign['1-5'] = { stars: 2, clears: 1 }; g.p.gold = 4444; g.p.rev++; window.__app.markDirty(true); });
  check(await B.page.evaluate(() => window.__app.syncCloud(true)) === 'uploaded', 'device B: new progress uploaded', results);
  check(await A.page.evaluate(() => window.__app.syncCloud(true)) === 'downloaded', 'device A: downloads the newer progress', results);
  check((await profile(A.page)).gold === 4444, 'both devices now show the same progress', results);
  // conflict: both changed offline -> the further one wins, the other is kept as a backup
  await A.page.evaluate(() => { const g = window.__app.game; g.p.campaign['1-6'] = { stars: 3, clears: 1 }; g.p.campaign['2-1'] = { stars: 3, clears: 1 }; g.p.gold = 9000; g.p.rev++; window.__app.markDirty(true); });
  await B.page.evaluate(() => { const g = window.__app.game; g.p.gold = 123456; g.p.gems = 99999; g.p.rev++; window.__app.markDirty(true); });
  await A.page.evaluate(() => window.__app.syncCloud(true));
  const sc = await B.page.evaluate(() => window.__app.syncCloud(true));
  const pb2 = await profile(B.page);
  check(sc === 'conflict_took_remote' && pb2.gold === 9000 && pb2.gems !== 99999, 'conflict: the profile that is further ahead wins as a whole (no currency mixing)', results);
  const backups = await B.page.evaluate(() => window.__app.saveSvc.backups().map((b) => [b.slot, b.gold]));
  check(backups.some(([slot, gold]) => slot === 'bak.alt' && gold === 123456), 'the losing version is kept as a restorable backup', results);
  // offline: server unreachable -> game still playable
  await B.ctx.setOffline(true);
  const off = await B.page.evaluate(() => window.__app.syncCloud(true));
  check(off === 'offline' || off === 'error', `sync reports "${off}" without network`, results);
  await B.page.evaluate(() => window.__app.startBattle('1-1', 'campaign'));
  await B.page.waitForFunction(() => !!window.__app.battle);
  check(true, 'campaign battles start with no network', results);
  await B.page.evaluate(() => { const a = window.__app; a.battle.b.chooseBoost(0); });
  await B.ctx.setOffline(false);
  // account deletion
  await A.page.evaluate(() => window.__app.nav('settings'));
  await A.page.click('#btn-delete-cloud');
  await A.page.locator('.dialog .btn.primary').click();
  await A.page.waitForFunction(() => window.__app.cloud.auth === null, null, { timeout: 8000 });
  const res = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  check(res.status === 401, 'deleted cloud account can no longer sign in', results);
  check((await profile(A.page)).gold === 9000, 'local progress is kept after deleting the cloud account', results);
  await A.ctx.close(); await B.ctx.close();
}

async function scenarioPerformance(browser) {
  console.log('\n[8] rendering budget and frame pacing');
  const { ctx, page } = await device(browser);
  await open(page);
  await page.evaluate(() => { const g = window.__app.game; for (const l of ['1-1', '1-2', '1-3', '1-4', '1-5', '1-6', '2-1', '2-2', '2-3', '2-4', '2-5']) g.p.campaign[l] = { stars: 3, clears: 1 }; g.p.tutorial.done = true; for (const t of ['ice', 'poison', 'storm']) g.p.cards[t] = { level: 1, mastery: 0 }; g.p.research.loadout = 2; g.p.research.alchemy = 3; g.p.loadout = ['archer', 'cannon', 'fire', 'ice', 'poison', 'storm']; });
  await startLevel(page, '2-5');
  await page.locator('.boost').first().click();
  await page.evaluate(() => { const b = window.__app.battle.b; b.s.coins = 9000; const L = b.s.ctx.loadout; for (let s = 0; s < b.map.slots.length; s++) b.buyTower(L[s % L.length], s); b.s.wave = 4; b.s.castleMax = b.s.castleHp = 100000; b.mods.enemyHp = 60; b.mods.enemySpeed = -0.75; b.startWave(); const pool = b.level.pool; for (let i = 0; i < 30; i++) b.spawnEnemy(pool[i % pool.length], i % b.map.paths.length, 1 + i * 0.45, 3); });
  // heavy moment: the screen is full of (very tough) enemies while every tower is firing
  await fastForward(page, ['boost', 'won', 'lost'], 3, 'false');
  const stat = await page.evaluate(() => new Promise((resolve) => {
    const app = window.__app, view = app.battle.view;
    let frames = 0, maxEnemies = 0; const t0 = performance.now(); let simSteps = 0;
    const orig = app.battle.frame.bind(app.battle);
    let renderMs = 0;
    app.battle.frame = (dt) => { const a = performance.now(); orig(dt); renderMs += performance.now() - a; frames++; maxEnemies = Math.max(maxEnemies, app.battle.b.s.enemies.length); simSteps++; };
    setTimeout(() => {
      const el = (performance.now() - t0) / 1000;
      const info = view.renderer.info;
      resolve({ fps: frames / el, cpuMsPerFrame: renderMs / Math.max(1, frames), calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, maxEnemies, particles: view.particles.alive, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1, cap: app.limiter.fps });
    }, 4000);
  }));
  console.log('    ', JSON.stringify(stat));
  check(stat.cap === 30 && stat.fps <= 31.5, `default cap is 30 fps (measured ${stat.fps.toFixed(1)})`, results);
  check(stat.maxEnemies >= 15 && stat.maxEnemies <= 20, `stress scene reached the on-screen limit without exceeding it (peak ${stat.maxEnemies}, limit 20)`, results);
  check(stat.calls <= 500, `draw calls in the worst case stay within budget (${stat.calls} with 20 enemies and a full board)`, results);
  check(stat.triangles <= 120000, `triangle count stays within the mobile budget (${stat.triangles})`, results);
  check(stat.textures <= 4, `almost no textures in memory (${stat.textures})`, results);
  // pooling: geometry count must not grow while fighting
  const g0 = stat.geometries;
  await fastForward(page, ['boost', 'won', 'lost'], 15, 'false');
  await page.waitForTimeout(1200);
  const g1 = await page.evaluate(() => window.__app.battle.view.renderer.info.memory.geometries);
  check(g1 - g0 <= 12, `objects are pooled: geometry count is stable during the fight (${g0} -> ${g1})`, results);
  await page.evaluate(() => { const a = window.__app; a.settings.fps = 60; a.applySettings(); });
  const f60 = await page.evaluate(() => new Promise((resolve) => { const app = window.__app; let n = 0; const orig = app.battle.frame.bind(app.battle); app.battle.frame = (dt) => { orig(dt); n++; }; setTimeout(() => resolve(n / 3), 3000); }));
  check(f60 <= 61, `60 fps option never exceeds 60 (measured ${f60.toFixed(1)})`, results);
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify({ ...stat, fpsAt60Setting: f60, note: 'headless Chromium with software WebGL (SwiftShader) – not representative of phone GPUs' }, null, 2));
  await shot(page, 'perf-heavy');
  check(page.errors.length === 0, `no runtime errors (${page.errors.length})${page.errors.length ? ': ' + page.errors[0] : ''}`, results);
  await ctx.close();
}

// =====================================================================================
let exit = 0;
try {
  await startServers();
  const browser = await launch();
  const only = process.argv[2];
  const run = async (n, fn) => { if (!only || only.split(',').includes(String(n))) { try { return await fn(); } catch (e) { console.log(`  ✗ scenario ${n} crashed: ${e.message.split('\n')[0]}`); results.push({ ok: false, msg: `scenario ${n} crashed: ${e.message.split('\n')[0]}` }); } } };
  const state = await run(1, () => scenarioTutorialAndPersistence(browser));
  await run(3, () => scenarioMergesAndHybrids(browser));
  await run(4, () => scenarioDefeatBossAndEndless(browser));
  await run(5, () => scenarioLifecycle(browser));
  await run(6, () => scenarioMetaScreens(browser, state));
  await run(7, () => scenarioCloud(browser));
  await run(8, () => scenarioPerformance(browser));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E: ${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.msg}`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, total: results.length, results }, null, 2));
  exit = failed.length ? 1 : 0;
} catch (e) {
  console.error(e);
  exit = 2;
} finally {
  for (const p of procs) p.kill();
}
process.exit(exit);
