import { describe, expect, it } from 'vitest';
import { Battle } from '../src/core/battle';
import { computeTower } from '../src/core/stats';
import { RunContext, emptyMods } from '../src/core/types';
import { BOOSTS } from '../src/data/boosts';
import { BASE_TOWER_IDS, HYBRID_TOWER_IDS, RECIPES, SELL_REFUND, TOWERS } from '../src/data/towers';
import { LEVELS, LEVEL_BY_ID } from '../src/data/worlds';
import { BotPolicy, expectedContext, runBot } from './bot';
import { LevelLog, LoadoutStyle, simulateAccount } from './progression';

/**
 * Balance simulations. A scripted player ("bot") plays thousands of battles through the real
 * rules; the assertions encode the design targets so a bad balance change fails CI.
 * Run `npm run balance` to see the full report.
 */
const SEEDS = [1, 2, 3];
const STYLES: LoadoutStyle[] = ['dealers', 'newest', 'elements'];
const report: string[] = [];
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Battle context of a simulated account at the moment it first reaches `levelId`, with the
 * loadout replaced. All tower cards are set to the account's average level so towers the
 * simulated player happened not to use are compared fairly.
 */
const ctxCache = new Map<string, RunContext>();
function ctxFor(levelId: string, loadout: string[], seed: number): RunContext {
  let base = ctxCache.get(levelId);
  if (!base) {
    const { game } = simulateAccount(1, { hybrids: true }, 12, LEVEL_BY_ID[levelId].index, 'dealers');
    const lv = game.p.loadout.map((t) => game.p.cards[t].level);
    const avg = Math.round(lv.reduce((a, b) => a + b, 0) / lv.length);
    for (const t of BASE_TOWER_IDS) game.p.cards[t] = { level: avg, mastery: 0 };
    base = { ...game.buildContext(levelId, 'campaign', 1), tutorial: false, alchemy: Math.max(1, game.alchemyLevel()) };
    ctxCache.set(levelId, base);
  }
  return { ...base, seed, loadout };
}

/** Largest enemy-health multiplier (relative to the level) a strategy still beats in >= half the seeds. */
function strength(levelId: string, loadout: string[], policy: BotPolicy, seeds = [11, 22, 33, 44]): number {
  const wins = (mul: number) => seeds.filter((s) => { const c = ctxFor(levelId, loadout, s); return runBot({ ...c, baseMods: { ...c.baseMods, enemyHp: mul - 1 } }, policy).won; }).length;
  let lo = 0.05, hi = 12;
  if (wins(lo) < seeds.length / 2) return 0;
  for (let i = 0; i < 9; i++) { const mid = Math.sqrt(lo * hi); if (wins(mid) >= seeds.length / 2) lo = mid; else hi = mid; }
  return lo;
}

describe('campaign progression (simulated accounts)', () => {
  const runs: { style: LoadoutStyle; seed: number; log: LevelLog[]; stuck: string | null }[] = [];
  it('every play style finishes the whole campaign', () => {
    for (const style of STYLES) for (const seed of SEEDS) {
      const r = simulateAccount(seed, { hybrids: true }, 12, undefined, style);
      runs.push({ style, seed, log: r.log, stuck: r.stuck });
      expect(r.stuck, `${style} seed ${seed}`).toBeNull();
      expect(r.log.length).toBe(LEVELS.length);
    }
  });
  it('no level is a wall: few retries, no impossible spikes', () => {
    const rows: string[] = [];
    let total = 0, n = 0, worst = 0;
    for (const l of LEVELS) {
      const cells = runs.map((r) => r.log[l.index]);
      const att = cells.map((c) => c.attempts);
      const avg = att.reduce((a, b) => a + b, 0) / att.length;
      total += avg; n++; worst = Math.max(worst, ...att);
      rows.push(`${l.id.padEnd(4)} attempts avg ${avg.toFixed(2)} max ${Math.max(...att)}  castle ${pct(cells.reduce((a, c) => a + c.hpPct, 0) / cells.length).padStart(4)}  battle ${(cells.reduce((a, c) => a + c.time, 0) / cells.length).toFixed(0).padStart(3)}s`);
      expect(avg, `average attempts on ${l.id}`).toBeLessThanOrEqual(l.boss ? 3.5 : 2.6);
    }
    report.push('PROGRESSION (3 play styles x 3 accounts)', ...rows, `average attempts per level: ${(total / n).toFixed(2)}, worst single case: ${worst}`);
    expect(total / n).toBeLessThanOrEqual(1.5);
    expect(worst).toBeLessThanOrEqual(8);
  });
  it('the first world is welcoming and bosses are the hardest part of each world', () => {
    const firstTry = (id: string) => runs.filter((r) => r.log[LEVEL_BY_ID[id].index].attempts === 1).length / runs.length;
    for (const id of ['1-1', '1-2', '1-3', '1-4', '1-5']) expect(firstTry(id), id).toBe(1);
    for (const w of [1, 2, 3, 4]) {
      const hp = (id: string) => runs.reduce((a, r) => a + r.log[LEVEL_BY_ID[id].index].hpPct, 0) / runs.length;
      const others = [1, 2, 3, 4, 5].map((i) => hp(`${w}-${i}`)).reduce((a, b) => a + b, 0) / 5;
      expect(hp(`${w}-6`), `boss of world ${w}`).toBeLessThan(others);
    }
  });
  it('battles last 2-4 minutes on average (simulation time + pauses for choices)', () => {
    // Real time = simulated time + the preparation countdown + reading/choosing a boost per wave.
    const real = (l: (typeof LEVELS)[number], sim: number) => sim + 10 + 6 * l.waves;
    const per = LEVELS.map((l) => real(l, runs.reduce((a, r) => a + r.log[l.index].time, 0) / runs.length));
    const avg = per.reduce((a, b) => a + b, 0) / per.length;
    report.push(`BATTLE LENGTH at x1 speed: average ${(avg / 60).toFixed(1)} min, shortest ${(Math.min(...per) / 60).toFixed(1)} min, longest ${(Math.max(...per) / 60).toFixed(1)} min`);
    expect(avg).toBeGreaterThanOrEqual(120);
    expect(avg).toBeLessThanOrEqual(240);
    expect(Math.min(...per)).toBeGreaterThanOrEqual(90);
    expect(Math.max(...per)).toBeLessThanOrEqual(300);
  });
  it('the campaign is not finished in a single sitting and does not take months', () => {
    const days = runs.map((r) => r.log[r.log.length - 1].day);
    report.push(`CAMPAIGN LENGTH: ${Math.min(...days)}-${Math.max(...days)} days at six battles a day`);
    expect(Math.min(...days)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...days)).toBeLessThanOrEqual(30);
  });
});

describe('tower balance', () => {
  const LEVEL = '2-5';
  const solo: Record<string, number> = {};
  it('no base tower is useless or dominant on its own', () => {
    for (const id of BASE_TOWER_IDS) solo[id] = strength(LEVEL, [id], { merge: true });
    const dealers = BASE_TOWER_IDS.filter((t) => !['ice', 'sun'].includes(t));
    const vals = dealers.map((t) => solo[t]);
    report.push(`SOLO STRENGTH on ${LEVEL} (enemy health a mono-tower defence still beats): ${BASE_TOWER_IDS.map((t) => `${t} ${solo[t].toFixed(2)}`).join(', ')}`);
    for (const t of dealers) expect(solo[t], `${t} alone`).toBeGreaterThan(0.3);
    expect(Math.max(...vals) / Math.min(...vals), 'strongest vs weakest damage tower').toBeLessThanOrEqual(2.5);
  });
  it('support towers earn their slot in a team', () => {
    // Direct comparison over many seeds at 2x enemy health: average castle health with and without the support tower.
    const score = (levelId: string, loadout: string[]) => {
      let sum = 0;
      for (let s = 1; s <= 10; s++) { const c = ctxFor(levelId, loadout, s * 13); sum += runBot({ ...c, baseMods: { ...c.baseMods, enemyHp: 1 } }, {}).hpPct; }
      return sum / 10;
    };
    const rows: string[] = [];
    for (const lvl of ['3-3', '4-2']) {
      const a = score(lvl, ['archer']), ai = score(lvl, ['archer', 'ice']), as = score(lvl, ['archer', 'storm']), ass = score(lvl, ['archer', 'storm', 'sun']);
      rows.push(`${lvl}: archers ${pct(a)} -> +ice ${pct(ai)}; archer+storm ${pct(as)} -> +sun ${pct(ass)}`);
      expect(ai, `ice on ${lvl}`).toBeGreaterThan(a);
      expect(ass, `sun on ${lvl}`).toBeGreaterThan(as);
    }
    report.push(`SUPPORT VALUE (average castle health at 2x enemy health): ${rows.join(' | ')}`);
  });
  it('focused mixed teams match or beat a mono team; mono stays viable; no single answer for every world', () => {
    const teams: Record<string, string[]> = { archers: ['archer'], cannons: ['cannon'], 'archer+ice': ['archer', 'ice'], 'archer+storm': ['archer', 'storm'], 'cannon+fire+ice': ['cannon', 'fire', 'ice'], 'storm+poison': ['storm', 'poison'], 'arcane+sun': ['arcane', 'sun'] };
    for (const lvl of ['2-5', '3-2', '4-4']) {
      const res = Object.fromEntries(Object.entries(teams).map(([k, v]) => [k, strength(lvl, v, { hybrids: true }, [11, 22, 33])]));
      const sorted = Object.entries(res).sort((a, b) => b[1] - a[1]);
      report.push(`TEAMS on ${lvl}: ${sorted.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
      const mono = Math.max(res.archers, res.cannons);
      const mixed = Math.max(...Object.entries(res).filter(([k]) => k.includes('+')).map(([, v]) => v));
      expect(mixed, `best mixed team on ${lvl}`).toBeGreaterThanOrEqual(mono * 0.9);
      expect(res.archers, `archers alone on ${lvl}`).toBeGreaterThan(0.3);
      // several different teams must be able to clear the level as designed (strength >= 1)
      expect(sorted.filter(([, v]) => v >= 0.8).length, `viable teams on ${lvl}`).toBeGreaterThanOrEqual(4);
      expect(sorted[0][1] / sorted[3][1], `top team vs 4th team on ${lvl}`).toBeLessThanOrEqual(2.6);
    }
  });
  it('hybrids are worth making but not mandatory or overpowered', () => {
    // Same towers, same coins: the only difference is whether the player fuses hybrids.
    const score = (loadout: string[], hybrids: boolean) => {
      let hp = 0, made = 0;
      for (let s = 1; s <= 10; s++) { const c = ctxFor('3-5', loadout, s * 17); const r = runBot({ ...c, baseMods: { ...c.baseMods, enemyHp: 0.4 } }, { hybrids }); hp += r.hpPct; made += r.battle.s.stats.hybrids; }
      return { hp: hp / 10, made: made / 10 };
    };
    const rows: string[] = [];
    for (const lo of [['cannon', 'fire'], ['fire', 'ice'], ['archer', 'poison']]) {
      const off = score(lo, false), on = score(lo, true);
      rows.push(`${lo.join('+')} ${pct(off.hp)} -> ${pct(on.hp)} (${on.made.toFixed(1)} hybrids per battle)`);
      expect(on.made, `${lo.join('+')} hybrids made`).toBeGreaterThan(0.5);
      expect(on.hp, `${lo.join('+')} with hybrids`).toBeGreaterThan(off.hp - 0.25);
    }
    report.push(`HYBRIDS on 3-5 (average castle health at 1.4x enemy health, without -> with): ${rows.join(' | ')}`);
    // per-tower sanity: a tier-3 hybrid is comparable to the tier-3 evolutions of its parents
    // (area attacks are credited for the extra targets they usually reach)
    const eff = (id: string, br: string | null) => {
      const c = computeTower(id, 3, 0, br, 1, emptyMods()), a = c.attack;
      let area = 1;
      if (a.kind === 'chain') for (let i = 1; i <= Math.min(4, a.chain ?? 0); i++) area += 0.5 * Math.pow(a.chainFalloff ?? 0.75, i);
      if (a.kind === 'pulse') area = 2.5;
      if (a.splash) area += a.splash;
      return c.dps * area;
    };
    for (const r of RECIPES) for (const res of r.results) {
      const h = eff(res, null);
      const ref = Math.max(...[r.a, r.b].flatMap((p) => TOWERS[p].branches!.map((b) => eff(p, b.id))));
      expect(h / ref, `${res} vs parents`).toBeGreaterThan(0.35);
      expect(h / ref, `${res} vs parents`).toBeLessThan(2.2);
    }
    expect(HYBRID_TOWER_IDS.length).toBe(9);
  });
  it('both evolution branches of every tower are playable', () => {
    for (const id of ['archer', 'cannon', 'fire', 'storm', 'poison', 'arcane']) {
      const a = strength(LEVEL, [id], { branch: 0 }, [5, 6]), b = strength(LEVEL, [id], { branch: 1 }, [5, 6]);
      expect(Math.max(a, b) / Math.max(0.01, Math.min(a, b)), `${id} branches ${a.toFixed(2)} / ${b.toFixed(2)}`).toBeLessThanOrEqual(3);
    }
  });
});

describe('roguelike boosts', () => {
  it('luck matters but does not decide the battle', () => {
    const lo = ['archer', 'cannon', 'fire', 'ice'];
    const smart = strength('2-3', lo, { boosts: 'smart' }), worst = strength('2-3', lo, { boosts: 'worst' }), first = strength('2-3', lo, { boosts: 'first' });
    report.push(`BOOST DEPENDENCE on 2-3: best picks ${smart.toFixed(2)}, random picks ${first.toFixed(2)}, worst picks ${worst.toFixed(2)}`);
    expect(worst).toBeGreaterThan(0.45);
    expect(smart / worst).toBeLessThan(2.4);
  });
  it('no single boost multiplies power beyond reason', () => {
    for (const b of BOOSTS) {
      const base = expectedContext('2-3', 5, { tutorial: true });
      const battle = new Battle(base);
      battle.buyTower('archer', 0);
      const before = battle.towerStats(battle.s.towers[0]).dps;
      battle.s.phase = 'boost'; battle.s.offer = [b.id];
      battle.chooseBoost(0);
      const after = battle.towerStats(battle.s.towers[0]).dps;
      expect(after / before, b.id).toBeLessThanOrEqual(1.65);
      expect(after / before, b.id).toBeGreaterThanOrEqual(0.99);
    }
  });
});

describe('economy exploits', () => {
  it('buying and selling in a loop loses coins', () => {
    const b = new Battle(expectedContext('1-3', 1, { tutorial: true }));
    const start = b.s.coins;
    for (let i = 0; i < 20 && b.buyTower('archer', 0).ok; i++) b.sellTower(b.s.towers[0].id);
    expect(b.s.coins).toBeLessThan(start);
    expect(SELL_REFUND).toBeLessThan(1);
  });
  it('merging then selling never returns more than was paid', () => {
    const b = new Battle(expectedContext('1-3', 1, { tutorial: true, baseMods: { startCoins: 2000 } }));
    const start = b.s.coins;
    for (let s = 0; s < 4; s++) b.buyTower('archer', s);
    b.merge(b.s.towers[0].id, b.s.towers[1].id, 0);
    b.merge(b.s.towers[0].id, b.s.towers[1].id, 0);
    b.merge(b.s.towers[0].id, b.s.towers[1].id, 0);
    expect(b.s.towers.length).toBe(1);
    b.sellTower(b.s.towers[0].id);
    expect(b.s.coins).toBeLessThan(start);
  });
  it('the "merge master" and "recruit" boosts cannot be turned into an infinite coin loop', () => {
    const b = new Battle(expectedContext('1-3', 1, { tutorial: true }));
    for (const id of ['mergemaster', 'recruit', 'discount', 'discount', 'discount']) { b.s.phase = 'boost'; b.s.offer = [id]; b.chooseBoost(0); }
    b.s.phase = 'prep';
    const start = b.s.coins;
    for (let i = 0; i < 30; i++) {
      if (!b.buyTower('archer', 0).ok || !b.buyTower('archer', 1).ok) break;
      b.merge(b.s.towers[0].id, b.s.towers[1].id, 0);
      b.sellTower(b.s.towers[0].id);
    }
    expect(b.s.coins).toBeLessThanOrEqual(start);
  });
  it('replaying an old level pays less than progressing', () => {
    const l = LEVELS[5], next = LEVELS[6];
    expect(l.rewardGold * 0.6).toBeLessThan(next.rewardGold * 2);
  });
});

describe('report', () => {
  it('prints the balance report', () => {
    console.log('\n===== BALANCE REPORT =====\n' + report.join('\n') + '\n==========================');
    expect(report.length).toBeGreaterThan(5);
  });
});
