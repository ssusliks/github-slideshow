import type { ForbiddenPair, MergeRecipe, Rarity, ReactionDef, TowerDef } from '../core/types';

/**
 * Tower content. Balancing happens here only – the simulation reads these tables generically.
 * Adding a tower = adding an entry (plus i18n strings and, optionally, a renderer "kind").
 */

/** Stat multiplier per tier (index = tier). Two tier-N towers are slightly weaker than one tier N+1. */
export const TIER_MUL = [0, 1, 2.2, 4.8, 10.5, 23];
/** Merge fee in coins when merging INTO tier N (index = resulting tier). */
export const MERGE_FEE = [0, 0, 10, 25, 60, 140];
export const RANK_BONUS = 0.15;
export const MAX_RANK_BELOW_TOP = 5;
export const SELL_REFUND = 0.6;

export const TOWERS: Record<string, TowerDef> = {
  archer: {
    id: 'archer', element: 'physical', rarity: 'common', cost: 50, targets: 'all',
    base: { damage: 10, rate: 1.25, range: 2.6 },
    attack: { kind: 'projectile', speed: 14 },
    effects: [],
    branches: [
      { id: 'marksman', look: 'marksman', mul: { damage: 1.7, range: 1.35, rate: 0.7 }, specials: { critChance: 0.25, critMul: 2.5 } },
      { id: 'volley', look: 'volley', mul: { damage: 0.8, rate: 1.15 }, attack: { multi: 3 } },
    ],
    look: { color: 0x8d6e4b, accent: 0x3fa34d, kind: 'archer' },
    unlockLevel: '',
  },
  cannon: {
    id: 'cannon', element: 'physical', rarity: 'common', cost: 70, targets: 'ground',
    base: { damage: 20, rate: 0.5, range: 2.4 },
    attack: { kind: 'projectile', speed: 8, splash: 1.1, siege: true },
    effects: [],
    branches: [
      { id: 'mortar', look: 'mortar', mul: { range: 1.4, damage: 1.15 }, attack: { splash: 1.6 } },
      { id: 'shrapnel', look: 'shrapnel', mul: { rate: 1.35 }, addEffects: [{ type: 'shred', pct: 0.5, dur: 4 }] },
    ],
    look: { color: 0x6b6f7a, accent: 0x2f3136, kind: 'cannon' },
    unlockLevel: '',
  },
  fire: {
    id: 'fire', element: 'fire', rarity: 'rare', cost: 70, targets: 'all',
    base: { damage: 8, rate: 1.0, range: 2.3 },
    attack: { kind: 'projectile', speed: 11 },
    effects: [{ type: 'burn', dpsPct: 0.5, dur: 3 }],
    branches: [
      { id: 'inferno', look: 'inferno', mul: { damage: 1.2 }, attack: { splash: 0.9 } },
      { id: 'phoenix', look: 'phoenix', mul: { rate: 1.25 }, addEffects: [{ type: 'burn', dpsPct: 0.4, dur: 2 }], specials: { spreadOnDeath: 1.4 } },
    ],
    look: { color: 0xc8452c, accent: 0xffb23e, kind: 'fire' },
    unlockLevel: '',
  },
  ice: {
    id: 'ice', element: 'ice', rarity: 'rare', cost: 60, targets: 'all',
    base: { damage: 5, rate: 0.9, range: 2.2 },
    attack: { kind: 'projectile', speed: 11 },
    effects: [{ type: 'chill', pct: 0.3, dur: 2.5 }],
    branches: [
      { id: 'glacier', look: 'glacier', mul: { damage: 1.5 }, addEffects: [{ type: 'freeze', chance: 0.18, dur: 1.2 }] },
      { id: 'blizzard', look: 'blizzard', mul: { damage: 0.8, rate: 0.8 }, attack: { kind: 'pulse' } },
    ],
    look: { color: 0x5fb6e6, accent: 0xe4f6ff, kind: 'ice' },
    unlockLevel: '1-2',
  },
  poison: {
    id: 'poison', element: 'poison', rarity: 'rare', cost: 65, targets: 'all',
    base: { damage: 4, rate: 0.8, range: 2.3 },
    attack: { kind: 'projectile', speed: 10 },
    effects: [{ type: 'poison', dpsPct: 0.4, dur: 6, maxStacks: 4 }, { type: 'shred', pct: 0.25, dur: 6 }],
    branches: [
      { id: 'plague', look: 'plague', mul: { rate: 1.2 }, specials: { spreadOnDeath: 1.5 } },
      { id: 'acid', look: 'acid', mul: { damage: 1.6 }, addEffects: [{ type: 'shred', pct: 0.7, dur: 6 }] },
    ],
    look: { color: 0x5a9e3a, accent: 0xb6f25c, kind: 'poison' },
    unlockLevel: '1-4',
  },
  storm: {
    id: 'storm', element: 'lightning', rarity: 'epic', cost: 85, targets: 'all',
    base: { damage: 9, rate: 0.8, range: 2.5 },
    attack: { kind: 'chain', chain: 3, chainFalloff: 0.75 },
    effects: [],
    branches: [
      { id: 'tempest', look: 'tempest', mul: { rate: 1.1 }, attack: { chain: 6, chainFalloff: 0.85 } },
      { id: 'thunder', look: 'thunder', mul: { damage: 1.7 }, attack: { chain: 2 }, addEffects: [{ type: 'freeze', chance: 0.12, dur: 0.6 }] },
    ],
    look: { color: 0x6a5acd, accent: 0xf7e94a, kind: 'storm' },
    unlockLevel: '2-1',
  },
  arcane: {
    id: 'arcane', element: 'arcane', rarity: 'epic', cost: 90, targets: 'all',
    base: { damage: 3.2, rate: 4, range: 2.6 },
    attack: { kind: 'beam', ramp: 0.12, rampMax: 1.2 },
    effects: [{ type: 'mark', pct: 0.15, dur: 3 }],
    branches: [
      { id: 'prism', look: 'prism', mul: { damage: 0.75 }, attack: { multi: 3 } },
      { id: 'void', look: 'void', mul: { damage: 1.15 }, attack: { rampMax: 2.2 }, specials: { execute: 0.12 } },
    ],
    look: { color: 0x9b4de0, accent: 0xff7df2, kind: 'arcane' },
    unlockLevel: '2-4',
  },
  sun: {
    id: 'sun', element: 'light', rarity: 'legendary', cost: 100, targets: 'all',
    base: { damage: 7, rate: 0.5, range: 1.9 },
    attack: { kind: 'pulse', buffRate: 0.15 },
    effects: [],
    specials: { vsUndead: 1.5 },
    branches: [
      { id: 'dawn', look: 'dawn', mul: { range: 1.15 }, attack: { buffRate: 0.2, buffDmg: 0.15 } },
      { id: 'radiance', look: 'radiance', mul: { damage: 2.6 }, addEffects: [{ type: 'chill', pct: 0.15, dur: 1.5 }] },
    ],
    look: { color: 0xe9b93a, accent: 0xfff6c2, kind: 'sun' },
    unlockLevel: '3-2',
  },

  // ---------------- Hybrids (only obtainable through merge recipes) ----------------
  frostfire: {
    id: 'frostfire', hybrid: true, element: 'fire', element2: 'ice', rarity: 'epic', cost: 0, targets: 'all',
    base: { damage: 9, rate: 1.05, range: 2.5 },
    attack: { kind: 'projectile', speed: 12 },
    effects: [{ type: 'burn', dpsPct: 0.5, dur: 3 }, { type: 'chill', pct: 0.3, dur: 2.5 }],
    look: { color: 0xb04cc0, accent: 0x7de3ff, kind: 'frostfire' },
  },
  steam: {
    id: 'steam', hybrid: true, element: 'fire', element2: 'ice', rarity: 'epic', cost: 0, targets: 'ground',
    base: { damage: 7, rate: 0.75, range: 1.9 },
    attack: { kind: 'pulse' },
    effects: [{ type: 'chill', pct: 0.25, dur: 1.5 }, { type: 'burn', dpsPct: 0.3, dur: 2 }],
    look: { color: 0xa7b7c4, accent: 0xff9a5c, kind: 'steam' },
  },
  venom: {
    id: 'venom', hybrid: true, element: 'physical', element2: 'poison', rarity: 'epic', cost: 0, targets: 'all',
    base: { damage: 15, rate: 0.9, range: 3.1 },
    attack: { kind: 'projectile', speed: 16 },
    effects: [{ type: 'poison', dpsPct: 0.3, dur: 6, maxStacks: 5 }, { type: 'shred', pct: 0.3, dur: 6 }],
    specials: { critChance: 0.1, critMul: 2 },
    look: { color: 0x4f7d3a, accent: 0xc9ff6b, kind: 'venom' },
  },
  meteor: {
    id: 'meteor', hybrid: true, element: 'fire', element2: 'physical', rarity: 'epic', cost: 0, targets: 'ground',
    base: { damage: 20, rate: 0.5, range: 2.7 },
    attack: { kind: 'projectile', speed: 8, splash: 1.4, siege: true },
    effects: [{ type: 'burn', dpsPct: 0.35, dur: 3 }],
    look: { color: 0x7a3b2e, accent: 0xff7b2e, kind: 'meteor' },
  },
  frostcannon: {
    id: 'frostcannon', hybrid: true, element: 'ice', element2: 'physical', rarity: 'epic', cost: 0, targets: 'ground',
    base: { damage: 16, rate: 0.5, range: 2.5 },
    attack: { kind: 'projectile', speed: 8, splash: 1.3, siege: true },
    effects: [{ type: 'chill', pct: 0.35, dur: 2.5 }, { type: 'freeze', chance: 0.1, dur: 1 }],
    look: { color: 0x54708f, accent: 0xbfeaff, kind: 'frostcannon' },
  },
  stormglacier: {
    id: 'stormglacier', hybrid: true, element: 'lightning', element2: 'ice', rarity: 'legendary', cost: 0, targets: 'all',
    base: { damage: 9, rate: 0.85, range: 2.5 },
    attack: { kind: 'chain', chain: 4, chainFalloff: 0.8 },
    effects: [{ type: 'chill', pct: 0.25, dur: 2 }, { type: 'freeze', chance: 0.08, dur: 0.8 }],
    look: { color: 0x4d7fd6, accent: 0xf2fbff, kind: 'stormglacier' },
  },
  plaguefire: {
    id: 'plaguefire', hybrid: true, element: 'poison', element2: 'fire', rarity: 'epic', cost: 0, targets: 'all',
    base: { damage: 6, rate: 1.0, range: 2.4 },
    attack: { kind: 'projectile', speed: 11, splash: 0.7 },
    effects: [{ type: 'poison', dpsPct: 0.4, dur: 6, maxStacks: 4 }, { type: 'burn', dpsPct: 0.5, dur: 3 }],
    specials: { deathBlast: 1.2 },
    look: { color: 0x7d8f2a, accent: 0xff8a3c, kind: 'plaguefire' },
  },
  runestorm: {
    id: 'runestorm', hybrid: true, element: 'lightning', element2: 'arcane', rarity: 'legendary', cost: 0, targets: 'all',
    base: { damage: 8.5, rate: 0.95, range: 2.7 },
    attack: { kind: 'chain', chain: 4, chainFalloff: 0.85 },
    effects: [{ type: 'mark', pct: 0.2, dur: 3.5 }],
    look: { color: 0x7b3fe0, accent: 0xfff36b, kind: 'runestorm' },
  },
  solarprism: {
    id: 'solarprism', hybrid: true, element: 'light', element2: 'arcane', rarity: 'legendary', cost: 0, targets: 'all',
    base: { damage: 3.4, rate: 4, range: 2.6 },
    attack: { kind: 'beam', ramp: 0.12, rampMax: 1.6, multi: 2, buffRate: 0.12 },
    effects: [{ type: 'mark', pct: 0.15, dur: 3 }],
    specials: { vsUndead: 1.4 },
    look: { color: 0xf0c34a, accent: 0xff9cf5, kind: 'solarprism' },
  },
};

export const BASE_TOWER_IDS = Object.values(TOWERS).filter((t) => !t.hybrid).map((t) => t.id);
export const HYBRID_TOWER_IDS = Object.values(TOWERS).filter((t) => t.hybrid).map((t) => t.id);

/**
 * Hybrid recipes: two DIFFERENT base towers of the same tier (>= HYBRID_MIN_TIER) become
 * one hybrid of tier+1. When a recipe lists several results the player picks one.
 */
export const HYBRID_MIN_TIER = 2;
export const RECIPES: MergeRecipe[] = [
  { a: 'fire', b: 'ice', results: ['frostfire', 'steam'], alchemy: 1 },
  { a: 'archer', b: 'poison', results: ['venom'], alchemy: 1 },
  { a: 'cannon', b: 'fire', results: ['meteor'], alchemy: 1 },
  { a: 'cannon', b: 'ice', results: ['frostcannon'], alchemy: 1 },
  { a: 'fire', b: 'poison', results: ['plaguefire'], alchemy: 2 },
  { a: 'ice', b: 'storm', results: ['stormglacier'], alchemy: 2 },
  { a: 'storm', b: 'arcane', results: ['runestorm'], alchemy: 3 },
  { a: 'sun', b: 'arcane', results: ['solarprism'], alchemy: 3 },
];

/** Explicitly forbidden pairs – shown to the player with a reason instead of the generic "no recipe". */
export const FORBIDDEN: ForbiddenPair[] = [
  { a: 'sun', b: 'poison', reason: 'merge.forbid.sun_poison' },
  { a: 'storm', b: 'cannon', reason: 'merge.forbid.storm_cannon' },
  { a: 'fire', b: 'storm', reason: 'merge.forbid.fire_storm' },
];

/** Highest ingredient rarity allowed per alchemy research level. */
export const ALCHEMY_RARITY: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Elemental reactions: a hit of `damage` type against a target with `status` is multiplied. */
export const REACTIONS: ReactionDef[] = [
  { id: 'shatter', damage: 'physical', status: 'freeze', mul: 1.8 },
  { id: 'brittle', damage: 'physical', status: 'chill', mul: 1.3 },
  { id: 'thermal', damage: 'fire', status: 'chill', mul: 1.25 },
  { id: 'ignite', damage: 'fire', status: 'poison', mul: 1.3 },
  { id: 'conduct', damage: 'lightning', status: 'chill', mul: 1.3, extra: 'chain' },
  { id: 'overload', damage: 'lightning', status: 'burn', mul: 1.15, extra: 'blast' },
  { id: 'toxicfrost', damage: 'poison', status: 'chill', mul: 1.25 },
  { id: 'focus', damage: 'arcane', status: 'burn', mul: 1.2 },
  { id: 'purge', damage: 'light', status: 'mark', mul: 1.3 },
];
