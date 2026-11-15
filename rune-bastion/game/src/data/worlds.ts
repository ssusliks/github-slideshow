import type { AbilityDef, LevelDef, MapDef, WorldDef } from '../core/types';

/**
 * Worlds, maps and the campaign table.
 * Map legend: S/T spawn points, C castle, # road, o tower slot, . grass.
 * Roads must form a single 4-connected route from every spawn to the castle (validated by tests).
 */
export const MAPS: Record<string, MapDef> = {
  A: { id: 'A', rows: ['..S....', '.o#o...', '..###o.', '.o..#..', '..o.#o.', '.####..', '.#o.o..', '.#.o...', '.####C.', '..o....'] },
  B: { id: 'B', rows: ['....S..', '.o..#o.', '.####..', '.#o.o..', '.#####.', '..o.o#.', '.#####.', '.#o.o..', '.###C..', '.......'] },
  C: { id: 'C', rows: ['.S...T.', '.#o.o#.', '.#...#.', '.##o##.', '..#.#..', '.o###o.', '..o#o..', '...#...', '..o#o..', '...C...'] },
  D: { id: 'D', rows: ['S......', '#####o.', '.o..#..', '.o.o#o.', '.####..', '.#o.o..', '.####o.', '..o.#..', '...o#C.', '.......'] },
  E: { id: 'E', rows: ['......S', '..o.o.#', '.######', '.#o.o..', '.#.o...', '.#####.', '..o.o#.', '....o#.', '....C#o', '.......'] },
  F: { id: 'F', rows: ['S.....T', '#.o.o.#', '##...##', '.#o.o#.', '.##.##.', '..#o#..', '.o###o.', '...#...', '..o#o..', '...C...'] },
};

export const WORLDS: WorldDef[] = [
  { id: 1, key: 'greenvale', boss: 'boss_grumbak', decor: ['tree', 'bush', 'rock', 'flower'],
    palette: { grassA: 0x7ec850, grassB: 0x72bd47, path: 0xd9b77a, pathEdge: 0xb8935a, ground: 0x5fa53a, skyTop: '#7fd0ff', skyBottom: '#d8f6c9', castle: 0xe8e2d0, roof: 0x3b6fd1, decor: 0x2f8f3a, decor2: 0x8a8f99 } },
  { id: 2, key: 'frostpeak', boss: 'boss_hrimgar', decor: ['pine', 'icerock', 'crystal', 'snowman'],
    palette: { grassA: 0xeaf4fb, grassB: 0xdcecf7, path: 0xa9c4d9, pathEdge: 0x7d9db8, ground: 0xc9dfee, skyTop: '#5f8fd6', skyBottom: '#e6f3ff', castle: 0xd4e3ee, roof: 0x7a4bd1, decor: 0x3d7a6a, decor2: 0x9fd8f5 } },
  { id: 3, key: 'emberwastes', boss: 'boss_ignarok', decor: ['deadtree', 'lavarock', 'ember', 'bones'],
    palette: { grassA: 0x6b4a3d, grassB: 0x624236, path: 0x3a2c2a, pathEdge: 0xff6a1f, ground: 0x4a322a, skyTop: '#3a1420', skyBottom: '#ff8a3c', castle: 0xb9a79a, roof: 0xb8321a, decor: 0x2a2020, decor2: 0xff6a1f } },
  { id: 4, key: 'shadowmire', boss: 'boss_morvane', decor: ['mushroom', 'deadtree', 'grave', 'crystal'],
    palette: { grassA: 0x4a5a6a, grassB: 0x435262, path: 0x6f6a8a, pathEdge: 0x4a456a, ground: 0x36424f, skyTop: '#161228', skyBottom: '#5a4f8a', castle: 0xa9a4c4, roof: 0x3fbf8a, decor: 0x7d4fd1, decor2: 0x7dff9a } },
];

/** Enemy pool order per world: grunt, fast, armored, flying, special, magic, elite. */
const POOLS: Record<number, string[]> = {
  1: ['goblin', 'wolf', 'ogre', 'bat', 'slime', 'shaman', 'champion'],
  2: ['frostling', 'snowwolf', 'icegolem', 'wyvern', 'wisp', 'icewitch', 'yeti'],
  3: ['imp', 'hellhound', 'magmabrute', 'drake', 'lavaspawn', 'pyromancer', 'warlord'],
  4: ['skeleton', 'ghoul', 'boneknight', 'wraith', 'shade', 'necromancer', 'abomination'],
};
export const WORLD_POOLS = POOLS;

const MAP_ORDER: Record<number, [string, boolean][]> = {
  1: [['A', false], ['B', false], ['D', false], ['E', false], ['B', true], ['A', true]],
  2: [['D', true], ['C', false], ['E', true], ['B', false], ['F', false], ['D', false]],
  3: [['E', false], ['F', false], ['A', true], ['C', false], ['B', true], ['E', true]],
  4: [['C', false], ['D', true], ['F', false], ['E', false], ['A', false], ['B', false]],
};
const WAVES = [3, 3, 4, 4, 5, 5];
/** How many pool entries are available at each level of a world (new enemy types appear gradually). */
const POOL_SIZE = [2, 3, 4, 5, 6, 7];

export const LEVELS_PER_WORLD = 6;
/**
 * Balance knobs (tuned with tests/balance.test.ts).
 * Coins inside a battle do not grow along the campaign, so enemy health may only grow as fast
 * as the player's permanent power (cards, research, new towers, abilities) – roughly x7 overall.
 */
export const HP_GROWTH = 1.085;
export const HP_BASE = 2.2;
export const BASE_BUDGET = 9;

const UNLOCK_TOWER: Record<string, string> = { '1-2': 'ice', '1-4': 'poison', '2-1': 'storm', '2-4': 'arcane', '3-2': 'sun' };
const UNLOCK_ABILITY: Record<string, string> = { '1-3': 'freeze', '1-6': 'overcharge', '2-3': 'heal' };

function buildLevels(): LevelDef[] {
  const out: LevelDef[] = [];
  for (const w of WORLDS) {
    for (let i = 0; i < LEVELS_PER_WORLD; i++) {
      const index = (w.id - 1) * LEVELS_PER_WORLD + i;
      const id = `${w.id}-${i + 1}`;
      const pool = POOLS[w.id].slice(0, POOL_SIZE[i]);
      const [map, mirror] = MAP_ORDER[w.id][i];
      const scripted: LevelDef['scripted'] = {};
      // The newest enemy type of the level always shows up as a scripted group in wave 2,
      // the heaviest available one closes the last wave.
      const newest = pool[pool.length - 1];
      scripted[1] = [{ e: newest, n: newest === POOLS[w.id][6] ? 1 : newest === POOLS[w.id][2] ? 2 : 3 }];
      if (i >= 2) scripted[WAVES[i] - 1] = [{ e: POOLS[w.id][2], n: 2 + Math.floor(i / 2) }];
      const isBoss = i === LEVELS_PER_WORLD - 1;
      out.push({
        id, world: w.id, index, map, mirror, waves: WAVES[i],
        hpMul: index === 0 ? 1 : HP_BASE * Math.pow(HP_GROWTH, index),
        budget: BASE_BUDGET + 0.5 * index,
        pool, scripted,
        boss: isBoss ? w.boss : undefined,
        rewardGold: 60 + 22 * index,
        unlocksTower: UNLOCK_TOWER[id],
        unlocksAbility: UNLOCK_ABILITY[id],
      });
    }
  }
  return out;
}

export const LEVELS: LevelDef[] = buildLevels();
export const LEVEL_BY_ID: Record<string, LevelDef> = Object.fromEntries(LEVELS.map((l) => [l.id, l]));

export const ABILITIES: Record<string, AbilityDef> = {
  meteor: { id: 'meteor', cooldown: 24, targeted: true, unlockLevel: '', power: 60, radius: 1.5 },
  freeze: { id: 'freeze', cooldown: 34, targeted: false, unlockLevel: '1-3', power: 0, dur: 3 },
  overcharge: { id: 'overcharge', cooldown: 40, targeted: false, unlockLevel: '1-6', power: 1.0, dur: 6 },
  heal: { id: 'heal', cooldown: 55, targeted: false, unlockLevel: '2-3', power: 0.3 },
};
export const ABILITY_ORDER = ['meteor', 'freeze', 'overcharge', 'heal'];

/** Endless mode parameters – separate from the campaign economy. */
export const ENDLESS = {
  unlockLevel: '1-6',
  hpGrowth: 1.12,
  baseHpMul: 1.6,
  budgetBase: 10,
  budgetPerWave: 1.6,
  bossEvery: 5,
  fullRewardRunsPerDay: 3,
  reducedRewardFactor: 0.25,
};
