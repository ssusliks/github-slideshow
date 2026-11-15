import { describe, expect, it } from 'vitest';
import { Battle } from '../src/core/battle';
import { parseMap } from '../src/core/map';
import { checkMerge } from '../src/core/merge';
import { Rng } from '../src/core/rng';
import { computeTower, rankMul } from '../src/core/stats';
import { BRANCH_TIER, MAX_ENEMIES_ALIVE, MAX_TIER, RunContext, emptyMods } from '../src/core/types';
import { buildWave } from '../src/core/waves';
import { BOOSTS, BOOST_BY_ID } from '../src/data/boosts';
import { BOSS_IDS, ENEMIES } from '../src/data/enemies';
import { BASE_TOWER_IDS, FORBIDDEN, HYBRID_TOWER_IDS, RECIPES, TOWERS } from '../src/data/towers';
import { LEVELS, MAPS, WORLDS } from '../src/data/worlds';

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  levelId: '1-3', mode: 'campaign', seed: 7, loadout: ['archer', 'cannon', 'fire', 'ice', 'poison'], cardMul: {}, baseMods: { startCoins: 5000 },
  alchemy: 3, abilities: ['meteor', 'freeze', 'overcharge', 'heal'], tutorial: true, ...over,
});
/** Builds a tower of the wanted tier on the board by buying and merging. */
function make(b: Battle, def: string, tier: number, branch = 0): number {
  const need = 2 ** (tier - 1);
  const ids: number[] = [];
  const free = () => b.map.slots.findIndex((_, i) => !b.towerAt(i));
  let level: number[] = [];
  for (let i = 0; i < need; i++) {
    b.s.coins = 1e6;
    expect(b.buyTower(def, free()).ok).toBe(true);
    level.push(b.s.towers[b.s.towers.length - 1].id);
    // merge eagerly so the board never runs out of slots
    let merged = true;
    while (merged) {
      merged = false;
      for (let x = 0; x < level.length && !merged; x++) for (let y = x + 1; y < level.length && !merged; y++) {
        const A = b.tower(level[x])!, B = b.tower(level[y])!;
        if (A.tier === B.tier && A.tier < tier) {
          const chk = b.mergeCheck(A.id, B.id);
          expect(chk.ok).toBe(true);
          expect(b.merge(A.id, B.id, chk.ok ? Math.min(branch, chk.options.length - 1) : 0).ok).toBe(true);
          const res = b.s.towers[b.s.towers.length - 1].id;
          level = level.filter((id) => id !== A.id && id !== B.id).concat(res);
          merged = true;
        }
      }
    }
  }
  ids.push(...level);
  expect(ids.length).toBe(1);
  return ids[0];
}

describe('maps and levels', () => {
  it('every map (and its mirror) has valid routes, slots near the road and a castle', () => {
    for (const m of Object.values(MAPS)) for (const mirror of [false, true]) {
      const g = parseMap(m, mirror);
      expect(g.slots.length).toBeGreaterThanOrEqual(8);
      expect(g.paths.length).toBe(g.spawns.length);
      for (const p of g.paths) expect(p.len).toBeGreaterThan(8);
      for (const s of g.slots) {
        const near = g.paths.some((p) => p.pts.some((q) => Math.hypot(q.x - s.x, q.y - s.y) <= 1.5));
        expect(near, `slot ${s.x},${s.y} of ${m.id}`).toBe(true);
      }
    }
  });
  it('campaign table is consistent', () => {
    expect(LEVELS.length).toBe(WORLDS.length * 6);
    for (const l of LEVELS) {
      expect(MAPS[l.map]).toBeTruthy();
      expect(l.waves).toBeGreaterThanOrEqual(3);
      expect(l.waves).toBeLessThanOrEqual(5);
      for (const e of l.pool) expect(ENEMIES[e], e).toBeTruthy();
      if (l.boss) expect(BOSS_IDS).toContain(l.boss);
      if (l.unlocksTower) expect(TOWERS[l.unlocksTower]).toBeTruthy();
    }
    expect(LEVELS.filter((l) => l.boss).length).toBe(WORLDS.length);
  });
  it('waves are deterministic per seed, respect the head-count cap and contain the scripted groups', () => {
    for (const l of LEVELS) for (let w = 0; w < l.waves; w++) {
      const a = buildWave(l, w, new Rng(42), 1), b = buildWave(l, w, new Rng(42), 1);
      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
      expect(a.length).toBeLessThanOrEqual(24);
      for (const g of l.scripted[w] ?? []) expect(a.filter((s) => s.e === g.e).length).toBeGreaterThanOrEqual(g.n);
      if (l.boss && w === l.waves - 1) expect(a.filter((s) => s.e === l.boss).length).toBe(1);
      for (let i = 1; i < a.length; i++) expect(a[i].t).toBeGreaterThanOrEqual(a[i - 1].t);
    }
  });
});

describe('tower data', () => {
  it('has 8 base towers with two branches each and consistent stats', () => {
    expect(BASE_TOWER_IDS.length).toBe(8);
    for (const id of BASE_TOWER_IDS) {
      const d = TOWERS[id];
      expect(d.branches?.length, id).toBe(2);
      expect(d.cost).toBeGreaterThan(0);
      for (let tier = 1; tier <= MAX_TIER; tier++) for (const br of [null, d.branches![0].id, d.branches![1].id]) {
        const c = computeTower(id, tier, 0, br, 1, emptyMods());
        expect(c.damage).toBeGreaterThan(0);
        expect(c.rate).toBeGreaterThan(0);
        expect(c.range).toBeGreaterThan(1);
        expect(Number.isFinite(c.dps)).toBe(true);
      }
    }
  });
  it('higher tiers are always stronger and merging beats two separate towers', () => {
    for (const id of [...BASE_TOWER_IDS, ...HYBRID_TOWER_IDS]) for (let t = 1; t < MAX_TIER; t++) {
      const a = computeTower(id, t, 0, null, 1, emptyMods()), b = computeTower(id, t + 1, 0, null, 1, emptyMods());
      expect(b.dps).toBeGreaterThan(a.dps * 2);
    }
  });
  it('rank growth is monotonic, bounded and never overflows', () => {
    let prev = 0;
    for (let r = 0; r <= 999; r++) { const m = rankMul(r); expect(m).toBeGreaterThan(prev); prev = m; }
    expect(rankMul(999)).toBeLessThan(6);
    const big = emptyMods(); big.dmgAll = 1e300;
    const c = computeTower('archer', 5, 999, 'marksman', 1e300, big);
    expect(Number.isFinite(c.damage)).toBe(true);
    expect(c.damage).toBeLessThanOrEqual(1e15);
  });
  it('recipes reference valid towers and never collide with forbidden pairs', () => {
    for (const r of RECIPES) {
      expect(TOWERS[r.a] && !TOWERS[r.a].hybrid).toBe(true);
      expect(TOWERS[r.b] && !TOWERS[r.b].hybrid).toBe(true);
      for (const res of r.results) expect(TOWERS[res]?.hybrid, res).toBe(true);
      expect(FORBIDDEN.some((f) => (f.a === r.a && f.b === r.b) || (f.a === r.b && f.b === r.a))).toBe(false);
    }
    // every hybrid is reachable through some recipe
    for (const h of HYBRID_TOWER_IDS) expect(RECIPES.some((r) => r.results.includes(h)), h).toBe(true);
  });
});

describe('merge rules', () => {
  const T = (def: string, tier: number, branch: string | null = null, rank = 0) => ({ def, tier, branch, rank });
  it('identical towers of the same tier merge into the next tier', () => {
    const r = checkMerge(T('archer', 1), T('archer', 1), 0);
    expect(r.ok && r.options).toEqual([{ def: 'archer', tier: 2, branch: null, rank: 0, fee: 10, kind: 'same' }]);
  });
  it('reaching the branch tier offers both evolutions', () => {
    for (const id of BASE_TOWER_IDS) {
      const r = checkMerge(T(id, BRANCH_TIER - 1), T(id, BRANCH_TIER - 1), 0);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.options.map((o) => o.branch)).toEqual(TOWERS[id].branches!.map((b) => b.id));
    }
  });
  it('rejects different tiers, different branches and max tier', () => {
    expect(checkMerge(T('archer', 1), T('archer', 2), 3)).toEqual({ ok: false, reason: 'merge.err.tier' });
    expect(checkMerge(T('archer', 3, 'marksman'), T('archer', 3, 'volley'), 3)).toEqual({ ok: false, reason: 'merge.err.branch' });
    expect(checkMerge(T('archer', MAX_TIER, 'volley'), T('archer', MAX_TIER, 'volley'), 3)).toEqual({ ok: false, reason: 'merge.err.max' });
  });
  it('keeps the higher rank', () => {
    const r = checkMerge(T('fire', 1, null, 2), T('fire', 1, null, 4), 0);
    expect(r.ok && r.options[0].rank).toBe(4);
  });
  it('every recipe works at tier 2 with enough alchemy and lists all results', () => {
    for (const rc of RECIPES) {
      const r = checkMerge(T(rc.a, 2), T(rc.b, 2), 3), rev = checkMerge(T(rc.b, 2), T(rc.a, 2), 3);
      expect(r.ok, `${rc.a}+${rc.b}`).toBe(true);
      expect(rev).toEqual(r);
      if (r.ok) { expect(r.options.map((o) => o.def)).toEqual(rc.results); expect(r.options.every((o) => o.tier === 3 && o.kind === 'hybrid')).toBe(true); }
    }
    const fi = checkMerge(T('fire', 2), T('ice', 2), 1);
    expect(fi.ok && fi.options.length).toBe(2);
  });
  it('every pair of different base towers without a recipe is refused', () => {
    let refused = 0;
    for (const a of BASE_TOWER_IDS) for (const b of BASE_TOWER_IDS) {
      if (a === b) continue;
      const has = RECIPES.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      const r = checkMerge(T(a, 2), T(b, 2), 3);
      expect(r.ok, `${a}+${b}`).toBe(has);
      if (!has) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
  it('explains forbidden pairs, wrong tiers, locked alchemy, rarity and hybrid mixing', () => {
    expect(checkMerge(T('sun', 2), T('poison', 2), 3)).toEqual({ ok: false, reason: 'merge.forbid.sun_poison' });
    expect(checkMerge(T('fire', 1), T('ice', 1), 3)).toEqual({ ok: false, reason: 'merge.err.hybrid_tier' });
    expect(checkMerge(T('fire', 3, 'inferno'), T('ice', 3, 'glacier'), 3)).toEqual({ ok: false, reason: 'merge.err.hybrid_tier' });
    expect(checkMerge(T('fire', 2), T('ice', 3, 'glacier'), 3)).toEqual({ ok: false, reason: 'merge.err.tier' });
    expect(checkMerge(T('fire', 2), T('ice', 2), 0)).toEqual({ ok: false, reason: 'merge.err.alchemy' });
    expect(checkMerge(T('storm', 2), T('arcane', 2), 2)).toEqual({ ok: false, reason: 'merge.err.alchemy' });
    expect(checkMerge(T('frostfire', 3), T('fire', 3, 'inferno'), 3)).toEqual({ ok: false, reason: 'merge.err.hybrid_mix' });
    expect(checkMerge(T('archer', 2), T('cannon', 2), 3)).toEqual({ ok: false, reason: 'merge.err.no_recipe' });
    expect(checkMerge(T('nope', 1), T('archer', 1), 3)).toEqual({ ok: false, reason: 'merge.err.unknown' });
  });
  it('hybrids merge with identical hybrids', () => {
    const r = checkMerge(T('steam', 3), T('steam', 3), 0);
    expect(r.ok && r.options[0]).toMatchObject({ def: 'steam', tier: 4, kind: 'same' });
  });
});

describe('battle actions', () => {
  it('validates placement: unknown tower, not in loadout, bad slot, occupied, no coins', () => {
    const b = new Battle(ctx({ baseMods: {} }));
    expect(b.buyTower('storm', 0)).toEqual({ ok: false, reason: 'act.err.tower' });
    expect(b.buyTower('frostfire', 0)).toEqual({ ok: false, reason: 'act.err.tower' });
    expect(b.buyTower('archer', -1)).toEqual({ ok: false, reason: 'act.err.slot' });
    expect(b.buyTower('archer', 99)).toEqual({ ok: false, reason: 'act.err.slot' });
    expect(b.buyTower('archer', 1.5)).toEqual({ ok: false, reason: 'act.err.slot' });
    expect(b.buyTower('archer', 0).ok).toBe(true);
    expect(b.buyTower('archer', 0)).toEqual({ ok: false, reason: 'act.err.occupied' });
    b.s.coins = 3;
    expect(b.buyTower('archer', 1)).toEqual({ ok: false, reason: 'act.err.coins' });
    expect(b.s.towers.length).toBe(1);
  });
  it('a failed merge leaves both towers and the coins untouched', () => {
    const b = new Battle(ctx());
    b.buyTower('archer', 0); b.buyTower('cannon', 1);
    const snap = JSON.stringify(b.s.towers), coins = b.s.coins;
    const [a, c] = b.s.towers;
    expect(b.merge(a.id, c.id, 0).ok).toBe(false);
    expect(b.merge(a.id, a.id, 0).ok).toBe(false);
    expect(b.merge(a.id, 9999, 0).ok).toBe(false);
    expect(JSON.stringify(b.s.towers)).toBe(snap);
    expect(b.s.coins).toBe(coins);
    // valid pair but an invalid option index / not enough coins is also a no-op
    b.buyTower('archer', 2);
    const d = b.s.towers[2];
    const snap2 = JSON.stringify(b.s.towers);
    expect(b.merge(a.id, d.id, 5)).toEqual({ ok: false, reason: 'merge.err.option' });
    b.s.coins = 0;
    expect(b.merge(a.id, d.id, 0)).toEqual({ ok: false, reason: 'act.err.coins' });
    expect(JSON.stringify(b.s.towers)).toBe(snap2);
  });
  it('a successful merge is atomic: result on the target slot, source slot freed, fee paid once', () => {
    const b = new Battle(ctx());
    b.buyTower('fire', 0); b.buyTower('fire', 3);
    const [a, c] = b.s.towers;
    const coins = b.s.coins, spent = a.spent + c.spent;
    expect(b.merge(a.id, c.id, 0).ok).toBe(true);
    expect(b.s.towers.length).toBe(1);
    const r = b.s.towers[0];
    expect(r).toMatchObject({ def: 'fire', tier: 2, slot: 3 });
    expect(b.towerAt(0)).toBeUndefined();
    expect(b.s.coins).toBe(coins - 10);
    expect(r.spent).toBe(spent + 10);
    expect(b.s.stats.merges).toBe(1);
  });
  it('builds every base tower up to tier 5 through both branches', () => {
    for (const id of BASE_TOWER_IDS) for (const br of [0, 1]) {
      const b = new Battle(ctx({ loadout: [id] }));
      const t = b.tower(make(b, id, 5, br))!;
      expect(t.tier).toBe(5);
      expect(t.branch).toBe(TOWERS[id].branches![br].id);
      expect(b.mergeCheck(t.id, t.id).ok).toBe(false);
    }
  });
  it('creates every hybrid in a real battle and lets the player pick between results', () => {
    for (const rc of RECIPES) rc.results.forEach((res, i) => {
      const b = new Battle(ctx({ loadout: [rc.a, rc.b] }));
      const a = make(b, rc.a, 2), c = make(b, rc.b, 2);
      const chk = b.mergeCheck(a, c);
      expect(chk.ok).toBe(true);
      expect(b.merge(a, c, i).ok).toBe(true);
      const t = b.s.towers[0];
      expect(t).toMatchObject({ def: res, tier: 3, branch: null });
      expect(b.s.stats.hybrids).toBe(1);
      expect(b.towerStats(t).damage).toBeGreaterThan(0);
    });
  });
  it('upgrades cost coins, stop at the rank cap below the top tier and stay finite beyond it', () => {
    const b = new Battle(ctx());
    b.buyTower('archer', 0);
    const t = b.s.towers[0];
    const d0 = b.towerStats(t).damage;
    for (let i = 0; i < 5; i++) { b.s.coins = 1e9; expect(b.upgradeTower(t.id).ok).toBe(true); }
    expect(b.towerStats(t).damage).toBeCloseTo(d0 * 1.75, 5);
    expect(b.upgradeTower(t.id)).toEqual({ ok: false, reason: 'act.err.maxrank' });
    const top = new Battle(ctx({ loadout: ['archer'] }));
    const id = make(top, 'archer', 5);
    for (let i = 0; i < 200; i++) { top.s.coins = 1e15; top.upgradeTower(id); }
    const tt = top.tower(id)!;
    expect(tt.rank).toBeGreaterThan(50);
    expect(Number.isFinite(top.upgradeCost(tt))).toBe(true);
    expect(top.upgradeCost(tt)).toBeLessThanOrEqual(1e12);
    expect(Number.isFinite(top.towerStats(tt).damage)).toBe(true);
  });
  it('sell refunds part of the investment and frees the slot; move needs a free slot', () => {
    const b = new Battle(ctx());
    b.buyTower('archer', 0); b.buyTower('cannon', 1);
    const [a, c] = b.s.towers;
    expect(b.moveTower(a.id, 1)).toEqual({ ok: false, reason: 'act.err.occupied' });
    expect(b.moveTower(a.id, 4).ok).toBe(true);
    expect(b.towerAt(4)?.id).toBe(a.id);
    const coins = b.s.coins;
    expect(b.sellTower(c.id).ok).toBe(true);
    expect(b.s.coins).toBe(coins + Math.floor(c.spent * 0.6));
    expect(b.towerAt(1)).toBeUndefined();
  });
});

describe('combat', () => {
  /** One tower (placed on the slot covering the road start) against one very tough enemy. */
  function duel(tower: string, enemy: string, tier = 2, time = 20, branch = 0, hpMul = 1.5): { b: Battle; dealt: number } {
    const b = new Battle(ctx({ loadout: [tower] }));
    const id = make(b, tower, tier, branch);
    b.startWave();
    b.s.queue = [];
    const e = (b as any).spawnEnemy(enemy, 0, 0, hpMul);
    e.hp = e.maxHp = 1e7;
    // walk the enemy next to the tower so every test starts in range
    const slot = b.slotPos(b.tower(id)!.slot), path = b.map.paths[0];
    let best = 0, bd = Infinity;
    for (let d = 0; d < path.len; d += 0.25) { const i = path.cum.findIndex((c) => c >= d); const pt = path.pts[Math.max(0, i)]; const dd = Math.hypot(pt.x - slot.x, pt.y - slot.y); if (dd < bd) { bd = dd; best = d; } }
    e.dist = Math.max(0, best - 1);
    for (let i = 0; i < time * 30 && b.s.enemies.length; i++) b.step();
    return { b, dealt: b.tower(id)?.dealt ?? 0 };
  }
  it('every tower (all tiers/branches/hybrids) damages a ground enemy; cannons ignore flyers', () => {
    for (const id of BASE_TOWER_IDS) for (const br of [0, 1]) expect(duel(id, 'goblin', 3, 8, br).dealt, id).toBeGreaterThan(0);
    for (const rc of RECIPES) rc.results.forEach((res, i) => {
      const b = new Battle(ctx({ loadout: [rc.a, rc.b] }));
      b.merge(make(b, rc.a, 2), make(b, rc.b, 2), i);
      b.startWave(); b.s.queue = [];
      const g = (b as any).spawnEnemy('goblin', 0, 0, 1); g.hp = g.maxHp = 1e7;
      for (let k = 0; k < 900 && b.s.towers[0].dealt === 0; k++) b.step();
      expect(b.s.towers[0].dealt, res).toBeGreaterThan(0);
    });
    expect(duel('cannon', 'bat', 2, 8).dealt).toBe(0);
    expect(duel('archer', 'bat', 2, 8).dealt).toBeGreaterThan(0);
  });
  it('applies element statuses: burn, chill slow, poison stacks, mark, freeze', () => {
    const f = duel('fire', 'ogre', 2, 2).b.s.enemies[0];
    expect(f.burnT).toBeGreaterThan(0);
    const i = duel('ice', 'ogre', 2, 2).b.s.enemies[0];
    expect(i.chillPct).toBeGreaterThan(0.2);
    const p = duel('poison', 'ogre', 2, 4).b.s.enemies[0];
    expect(p.poisonStacks).toBeGreaterThan(1);
    expect(p.shredT).toBeGreaterThan(0);
    const a = duel('arcane', 'ogre', 2, 2).b.s.enemies[0];
    expect(a.markT).toBeGreaterThan(0);
  });
  it('chilled enemies really move slower', () => {
    const walk = (tower: string) => { const b = duel(tower, 'ogre', 1, 3).b; return b.s.enemies[0].dist; };
    expect(walk('ice')).toBeLessThan(walk('archer') - 0.3);
  });
  it('resistances and vulnerabilities scale damage moderately', () => {
    const fireVsImp = duel('fire', 'imp', 2, 6).dealt, fireVsGoblin = duel('fire', 'goblin', 2, 6).dealt;
    expect(fireVsImp).toBeLessThan(fireVsGoblin);
    for (const e of Object.values(ENEMIES)) for (const v of Object.values(e.resist)) { expect(v).toBeGreaterThanOrEqual(0.4); expect(v).toBeLessThanOrEqual(1.5); }
  });
  it('element synergy: a second tower exploits the status applied by the first', () => {
    const run = (towers: string[]) => {
      const b = new Battle(ctx({ loadout: towers, seed: 5 }));
      const ids = towers.map((t) => make(b, t, 2));
      b.startWave(); b.s.queue = [];
      const o = (b as any).spawnEnemy('ogre', 0, 0, 1); o.hp = o.maxHp = 1e7; o.armor = 0;
      for (let k = 0; k < 1500; k++) b.step();
      return { dealt: b.tower(ids[0])!.dealt, reactions: b.s.stats.reactions };
    };
    const solo = run(['archer']), combo = run(['archer', 'ice']);
    expect(combo.reactions).toBeGreaterThan(0);
    expect(combo.dealt).toBeGreaterThan(solo.dealt * 1.15);
  });
  it('aura towers speed up their neighbours', () => {
    const run = (withSun: boolean) => {
      const b = new Battle(ctx({ loadout: ['archer', 'sun'] }));
      b.buyTower('archer', 0);
      const a = b.s.towers[0];
      if (withSun) {
        const p = b.slotPos(0);
        const near = b.map.slots.map((s, i) => ({ i, d: Math.hypot(s.x - p.x, s.y - p.y) })).filter((x) => x.i !== 0).sort((x, y) => x.d - y.d)[0];
        b.buyTower('sun', near.i);
        expect(b.auraOf(a.id).rate).toBeGreaterThan(0);
      }
      b.startWave(); b.s.queue = [];
      const e = (b as any).spawnEnemy('ogre', 0, 0, 1); e.hp = e.maxHp = 1e7; e.armor = 0;
      for (let i = 0; i < 30 * 40; i++) b.step();
      return a.dealt;
    };
    expect(run(true)).toBeGreaterThan(run(false) * 1.2);
  });
  it('armor punishes weak hits, siege and shred counter it', () => {
    const arrow = duel('archer', 'ogre', 1, 3).dealt / computeTower('archer', 1, 0, null, 1, emptyMods()).dps;
    const shell = duel('cannon', 'ogre', 1, 3).dealt / computeTower('cannon', 1, 0, null, 1, emptyMods()).dps;
    const acid = duel('poison', 'ogre', 1, 3).b.s.enemies[0];
    expect(shell).toBeGreaterThan(arrow * 1.3);
    expect(acid.shredPct).toBeGreaterThan(0);
  });
  it('never exceeds the on-screen enemy limit, even with summoners and splitters', () => {
    const b = new Battle(ctx({ levelId: '4-6', loadout: ['archer'] }));
    b.startWave();
    let max = 0;
    for (let i = 0; i < 30 * 90 && b.s.phase !== 'lost'; i++) { b.step(); max = Math.max(max, b.s.enemies.length); }
    expect(max).toBeGreaterThan(5);
    expect(max).toBeLessThanOrEqual(MAX_ENEMIES_ALIVE);
  });
  it('leaks damage the castle and losing all hp ends the run; revive works once', () => {
    const b = new Battle(ctx({ baseMods: {}, levelId: '2-5' }));
    const run = () => { for (let i = 0; i < 30 * 400 && b.s.phase !== 'lost'; i++) { if (b.s.phase === 'boost') b.chooseBoost(0); if (b.s.phase === 'prep') b.startWave(); b.step(); } };
    run();
    expect(b.s.phase).toBe('lost');
    expect(b.s.castleHp).toBe(0);
    expect(b.revive().ok).toBe(true);
    expect(b.s.castleHp).toBeGreaterThan(0);
    expect(b.s.phase).toBe('wave');
    run();
    expect(b.s.phase).toBe('lost');
    expect(b.revive()).toEqual({ ok: false, reason: 'act.err.revived' });
  });
});

describe('bosses', () => {
  const fight = (boss: string, levelId: string) => {
    const b = new Battle(ctx({ levelId, loadout: ['archer', 'fire'] }));
    b.collect = true;
    for (let s = 0; s < b.map.slots.length; s++) { b.s.coins = 1e6; b.buyTower(s % 2 ? 'archer' : 'fire', s); }
    b.startWave(); b.s.queue = [];
    (b as any).spawnEnemy(boss, 0, 1, 3);
    const kinds = new Set<string>();
    let maxEnemies = 1, stunned = false, shielded = false;
    for (let i = 0; i < 30 * 60 && b.s.enemies.some((e) => e.boss); i++) {
      b.step();
      for (const ev of b.events) if (ev.t === 'enemyAbility') kinds.add(ev.kind);
      b.events.length = 0;
      maxEnemies = Math.max(maxEnemies, b.s.enemies.length);
      stunned ||= b.s.towers.some((t) => t.stun > 0);
      shielded ||= b.s.enemies.some((e) => e.shieldT > 0);
    }
    return { kinds, maxEnemies, stunned, shielded };
  };
  it('each boss has at least two distinct mechanics', () => {
    for (const id of BOSS_IDS) expect(new Set(ENEMIES[id].abilities!.map((a) => a.type)).size, id).toBeGreaterThanOrEqual(2);
  });
  it('Grumbak summons minions', () => { const r = fight('boss_grumbak', '1-6'); expect(r.kinds.has('summon')).toBe(true); expect(r.maxEnemies).toBeGreaterThan(1); });
  it('Hrimgar raises a shield and stuns towers', () => { const r = fight('boss_hrimgar', '2-6'); expect(r.shielded).toBe(true); expect(r.stunned).toBe(true); });
  it('Ignarok enrages and stuns towers', () => { const r = fight('boss_ignarok', '3-6'); expect(r.stunned).toBe(true); expect(r.kinds.has('enrage') || r.kinds.has('summon')).toBe(true); });
  it('Morvane summons, shields and blinks', () => { const r = fight('boss_morvane', '4-6'); expect(r.kinds.has('summon')).toBe(true); expect(r.shielded || r.kinds.has('blink')).toBe(true); });
  it('boss levels spawn exactly one boss in the last wave', () => {
    for (const l of LEVELS.filter((x) => x.boss)) {
      const b = new Battle(ctx({ levelId: l.id }));
      b.s.wave = l.waves - 1;
      b.startWave();
      expect(b.s.queue.filter((q) => q.e === l.boss).length).toBe(1);
    }
  });
});

describe('boosts', () => {
  it('all boost modifiers address real stats', () => {
    for (const b of BOOSTS) {
      const battle = new Battle(ctx());
      battle.s.phase = 'boost'; battle.s.offer = [b.id];
      expect(battle.chooseBoost(0).ok, b.id).toBe(true);
    }
  });
  it('offers three distinct applicable boosts and never an unusable one', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const b = new Battle(ctx({ seed, tutorial: false, loadout: ['archer', 'cannon'], alchemy: 0, abilities: [] }));
      expect(b.s.phase).toBe('boost');
      const offer = b.s.offer!;
      expect(offer.length).toBe(3);
      expect(new Set(offer).size).toBe(3);
      for (const id of offer) {
        const n = BOOST_BY_ID[id].needs;
        if (n?.element) expect(['physical']).toContain(n.element);
        expect(n?.hybrid).toBeFalsy();
        expect(n?.ability).toBeFalsy();
        expect(n?.attack === 'chain').toBe(false);
      }
    }
  });
  it('respects stack limits and applies modifiers', () => {
    const b = new Battle(ctx());
    b.buyTower('archer', 0);
    const t = b.s.towers[0], d0 = b.towerStats(t).damage;
    for (let i = 0; i < 9; i++) { b.s.phase = 'boost'; b.s.offer = (b as any).rollBoosts(); if (b.s.offer!.includes('glasscannon')) { b.chooseBoost(b.s.offer!.indexOf('glasscannon')); break; } b.s.offer = ['sharp']; if ((b.s.boosts.sharp ?? 0) < 5) b.chooseBoost(0); }
    expect(b.towerStats(t).damage).toBeGreaterThan(d0);
    for (let i = 0; i < 400; i++) { const offer: string[] = (b as any).rollBoosts(); for (const id of offer) expect((b.s.boosts[id] ?? 0) < BOOST_BY_ID[id].max, id).toBe(true); }
  });
  it('the starting blessing pauses the run until a choice is made; reroll costs coins', () => {
    const b = new Battle(ctx({ tutorial: false }));
    const t0 = b.s.time;
    for (let i = 0; i < 100; i++) b.step();
    expect(b.s.time).toBe(t0);
    const before = b.s.offer!.slice(), coins = b.s.coins;
    expect(b.rerollBoosts().ok).toBe(true);
    expect(b.s.coins).toBe(coins - 30);
    expect(b.s.offer).not.toEqual(before);
    expect(b.chooseBoost(1).ok).toBe(true);
    expect(b.s.phase).toBe('prep');
    expect(b.chooseBoost(0).ok).toBe(false);
  });
});

describe('abilities', () => {
  it('have cooldowns, validate state and produce their effect', () => {
    const b = new Battle(ctx());
    b.startWave();
    for (let i = 0; i < 150; i++) b.step();
    const e = b.s.enemies[0];
    const hp = e.hp;
    expect(b.useAbility('meteor', e.x, e.y).ok).toBe(true);
    expect(e.hp).toBeLessThan(hp);
    expect(b.useAbility('meteor', e.x, e.y)).toEqual({ ok: false, reason: 'act.err.cooldown' });
    expect(b.useAbility('meteor', NaN, 0).ok).toBe(false);
    expect(b.useAbility('freeze').ok).toBe(true);
    expect(b.s.enemies.every((x) => x.freezeT > 0)).toBe(true);
    expect(b.useAbility('heal')).toEqual({ ok: false, reason: 'act.err.fullhp' });
    b.s.castleHp = 5;
    expect(b.useAbility('heal').ok).toBe(true);
    expect(b.s.castleHp).toBeGreaterThan(5);
    expect(b.useAbility('overcharge').ok).toBe(true);
    expect(b.s.overT).toBeGreaterThan(0);
    expect(b.useAbility('nope').ok).toBe(false);
    const locked = new Battle(ctx({ abilities: ['meteor'] }));
    expect(locked.useAbility('freeze')).toEqual({ ok: false, reason: 'act.err.ability' });
  });
});

describe('determinism and suspend/resume', () => {
  it('a serialised battle continues exactly like the original', () => {
    const play = (b: Battle, steps: number) => { for (let i = 0; i < steps; i++) { if (b.s.phase === 'boost') b.chooseBoost(0); if (b.s.phase === 'prep') b.startWave(); b.step(); } };
    const a = new Battle(ctx({ tutorial: false, baseMods: { startCoins: 400 } }));
    a.chooseBoost(0);
    for (let s = 0; s < 5; s++) a.buyTower(['archer', 'fire', 'ice', 'poison', 'cannon'][s], s);
    play(a, 700);
    const snap = JSON.parse(JSON.stringify(a.serialize()));
    const b = new Battle(snap.ctx, snap);
    play(a, 900); play(b, 900);
    expect(b.s.time).toBeCloseTo(a.s.time, 6);
    expect(b.s.coins).toBe(a.s.coins);
    expect(b.s.castleHp).toBe(a.s.castleHp);
    expect(b.s.stats.kills).toBe(a.s.stats.kills);
    expect(b.s.wave).toBe(a.s.wave);
    expect(b.s.enemies.map((e) => [e.def, Math.round(e.hp), Math.round(e.dist * 100)])).toEqual(a.s.enemies.map((e) => [e.def, Math.round(e.hp), Math.round(e.dist * 100)]));
  });
  it('endless mode keeps escalating and spawns bosses periodically', () => {
    const b = new Battle(ctx({ mode: 'endless', levelId: 'endless', tutorial: false, baseMods: { startCoins: 5000, dmgAll: 30 } }));
    let bosses = 0;
    for (let i = 0; i < 30 * 600 && b.s.wave < 6 && b.s.phase !== 'lost'; i++) {
      if (b.s.phase === 'boost') b.chooseBoost(0);
      if (b.s.phase === 'prep') { for (let s = 0; s < b.map.slots.length; s++) if (!b.towerAt(s)) b.buyTower('archer', s); b.startWave(); if (b.s.queue.some((q) => ENEMIES[q.e].tags.includes('boss'))) bosses++; }
      b.step();
    }
    expect(b.s.wave).toBeGreaterThanOrEqual(6);
    expect(bosses).toBeGreaterThanOrEqual(1);
    expect(b.s.phase).not.toBe('won');
  });
});
