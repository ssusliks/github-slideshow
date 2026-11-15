import { ENEMIES } from '../data/enemies';
import { ENDLESS, LEVELS, WORLD_POOLS, WORLDS } from '../data/worlds';
import type { Rng } from './rng';
import type { LevelDef } from './types';

export interface SpawnEntry { t: number; e: string; path: number; hpMul: number }

/** Balance knobs. */
export const WAVE_HP_STEP = 0.22;
export const WAVE_BUDGET_STEP = 0.35;
export const MAX_WAVE_COUNT = 22;
/**
 * Total seconds of spawning per level, split between its waves: levels with few waves get longer
 * waves and vice versa, which keeps every level inside the 2-4 minute target.
 */
export const LEVEL_SPAWN_TIME = 78;
export const ENDLESS_WAVE_WINDOW = 18;
/** Maps with two entrances split the defence, so their waves are a little lighter. */
export const MULTI_PATH_BUDGET = 0.8;

/**
 * Builds the spawn list of one wave: scripted groups from the level table first,
 * then a seeded random fill from the level's enemy pool up to the wave budget.
 */
export function buildWave(level: LevelDef, w: number, rng: Rng, nPaths: number): SpawnEntry[] {
  const hp = level.hpMul * (1 + WAVE_HP_STEP * Math.min(w, 8));
  let budget = level.budget * (1 + WAVE_BUDGET_STEP * Math.min(w, 6));
  const isBossWave = !!level.boss && (level.waves === Infinity || w === level.waves - 1);
  if (isBossWave) budget *= 0.55;
  if (nPaths > 1) budget *= MULTI_PATH_BUDGET;
  const groups: { e: string; n: number }[] = [];
  let count = 0;
  for (const g of level.scripted[w] ?? []) {
    groups.push({ ...g });
    budget -= ENEMIES[g.e].threat * g.n;
    count += g.n;
  }
  const minThreat = Math.min(...level.pool.map((id) => ENEMIES[id].threat));
  let guard = 0;
  while (budget >= minThreat && count < MAX_WAVE_COUNT && guard++ < 40) {
    const cands = level.pool.filter((id) => ENEMIES[id].threat <= budget);
    if (!cands.length) break;
    // Cheaper enemies are more common; a type that already has a group is less likely to repeat.
    const weights = cands.map((id) => (1 / Math.sqrt(ENEMIES[id].threat)) * (groups.some((g) => g.e === id) ? 0.5 : 1));
    const e = cands[rng.weighted(weights)];
    const th = ENEMIES[e].threat;
    const want = th <= 1.5 ? 2 + rng.int(4) : th <= 3 ? 1 + rng.int(2) : 1;
    const n = Math.max(1, Math.min(want, Math.floor(budget / th), MAX_WAVE_COUNT - count));
    groups.push({ e, n });
    budget -= th * n;
    count += n;
  }
  // Budget that did not fit into the head-count cap becomes extra toughness instead of more bodies.
  const spare = Math.max(0, budget) / Math.max(1, level.budget);
  const hpAdj = hp * (1 + Math.min(1.5, spare));
  rng.shuffle(groups);
  const window = Number.isFinite(level.waves) ? LEVEL_SPAWN_TIME / level.waves : ENDLESS_WAVE_WINDOW;
  const step = Math.min(1.6, Math.max(0.45, window / Math.max(1, count + groups.length)));
  const out: SpawnEntry[] = [];
  let t = 0.5;
  const bossAt = Math.floor(groups.length / 3);
  groups.forEach((g, gi) => {
    if (isBossWave && gi === bossAt) {
      out.push({ t, e: level.boss!, path: rng.int(nPaths), hpMul: level.hpMul });
      t += step * 2;
    }
    const path = rng.int(nPaths);
    for (let i = 0; i < g.n; i++) {
      out.push({ t, e: g.e, path, hpMul: hpAdj });
      t += step;
    }
    t += step;
  });
  if (isBossWave && !out.some((s) => s.e === level.boss)) out.push({ t, e: level.boss!, path: rng.int(nPaths), hpMul: level.hpMul });
  return out;
}

/** Synthesises the level definition used by a given endless wave (0-based). */
export function endlessLevel(wave: number, worldsUnlocked: number, map: string, mirror: boolean): LevelDef {
  const cycle = Math.floor(wave / ENDLESS.bossEvery);
  const world = WORLDS[cycle % Math.max(1, Math.min(worldsUnlocked, WORLDS.length))];
  const isBoss = (wave + 1) % ENDLESS.bossEvery === 0;
  return {
    id: 'endless', world: world.id, index: wave, map, mirror, waves: Infinity,
    hpMul: ENDLESS.baseHpMul * Math.pow(ENDLESS.hpGrowth, wave),
    budget: Math.min(30, ENDLESS.budgetBase + ENDLESS.budgetPerWave * wave),
    pool: WORLD_POOLS[world.id],
    scripted: {},
    boss: isBoss ? world.boss : undefined,
    rewardGold: 0,
  };
}

export function levelIndexOf(id: string): number {
  return LEVELS.findIndex((l) => l.id === id);
}
