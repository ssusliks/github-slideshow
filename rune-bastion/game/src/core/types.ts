/**
 * Shared data contracts of the battle core.
 * Everything here is plain JSON-compatible data: game content lives in src/data,
 * the simulation in src/core never touches the DOM or the renderer.
 */

export type DamageType = 'physical' | 'fire' | 'ice' | 'poison' | 'lightning' | 'arcane' | 'light';
export const DAMAGE_TYPES: DamageType[] = ['physical', 'fire', 'ice', 'poison', 'lightning', 'arcane', 'light'];

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

export type StatusKind = 'burn' | 'poison' | 'chill' | 'freeze' | 'mark';

/** Status effect a tower applies on hit. Percent values are fractions (0.3 = 30%). */
export interface EffectSpec {
  type: 'burn' | 'poison' | 'chill' | 'freeze' | 'mark' | 'shred';
  /** burn/poison: damage per second as a fraction of the hit damage. */
  dpsPct?: number;
  /** chill: slow fraction; mark: extra damage taken; shred: armor fraction removed. */
  pct?: number;
  dur: number;
  /** poison: max stacks. */
  maxStacks?: number;
  /** freeze: proc chance per hit. */
  chance?: number;
}

export type AttackKind = 'projectile' | 'chain' | 'beam' | 'pulse';

export interface AttackSpec {
  kind: AttackKind;
  /** projectile speed, cells/sec. */
  speed?: number;
  /** splash radius in cells (projectile) . */
  splash?: number;
  /** chain: number of extra jumps and damage falloff per jump. */
  chain?: number;
  chainFalloff?: number;
  /** beam: damage ramp per consecutive hit on the same target and its cap. */
  ramp?: number;
  rampMax?: number;
  /** siege shots ignore half of the armor. */
  siege?: boolean;
  /** number of simultaneous targets (volley / prism). */
  multi?: number;
  /** pulse: attack-speed buff given to towers in range. */
  buffRate?: number;
  /** pulse: damage buff given to towers in range. */
  buffDmg?: number;
}

export interface TowerSpecials {
  critChance?: number;
  critMul?: number;
  /** status spreads to enemies within this radius when the victim dies. */
  spreadOnDeath?: number;
  /** executes non-boss enemies below this hp fraction. */
  execute?: number;
  /** on-death explosion: fraction of tower damage dealt in 1 cell. */
  deathBlast?: number;
  /** multiplier against enemies tagged undead. */
  vsUndead?: number;
}

export interface StatBlock {
  damage: number;
  /** attacks per second. */
  rate: number;
  /** cells. */
  range: number;
}

export interface BranchDef {
  id: string;
  /** multipliers applied on top of base stats. */
  mul?: Partial<StatBlock>;
  attack?: Partial<AttackSpec>;
  addEffects?: EffectSpec[];
  specials?: TowerSpecials;
  /** visual variant key understood by the renderer. */
  look: string;
}

export interface TowerDef {
  id: string;
  element: DamageType;
  /** second element of hybrids (visuals + boosts). */
  element2?: DamageType;
  rarity: Rarity;
  hybrid?: boolean;
  /** in-run coin price; hybrids are never bought. */
  cost: number;
  targets: 'all' | 'ground';
  base: StatBlock;
  attack: AttackSpec;
  effects: EffectSpec[];
  specials?: TowerSpecials;
  /** two alternative evolutions chosen when the tower reaches tier 3. */
  branches?: [BranchDef, BranchDef];
  look: { color: number; accent: number; kind: string };
  /** campaign level that unlocks the card ('' = starter). Hybrids unlock through recipes. */
  unlockLevel?: string;
}

export interface MergeRecipe {
  /** unordered pair of base tower ids. */
  a: string;
  b: string;
  results: string[];
  /** alchemy research level required. */
  alchemy: number;
}

export interface ForbiddenPair {
  a: string;
  b: string;
  /** localisation key of the explanation. */
  reason: string;
}

export type EnemyTag = 'ground' | 'flying' | 'fast' | 'armored' | 'magic' | 'elite' | 'special' | 'boss' | 'undead';

export type EnemyAbility =
  | { type: 'summon'; every: number; count: number; enemy: string }
  | { type: 'shield'; every: number; dur: number; reduce: number }
  | { type: 'haste_aura'; radius: number; pct: number }
  | { type: 'heal_aura'; radius: number; pctPerSec: number }
  | { type: 'enrage'; below: number; speedMul: number }
  | { type: 'stun_towers'; every: number; count: number; dur: number }
  | { type: 'split'; into: string; count: number }
  | { type: 'blink'; every: number; dist: number }
  | { type: 'regen'; pctPerSec: number };

export interface EnemyDef {
  id: string;
  world: number;
  tags: EnemyTag[];
  hp: number;
  /** cells per second. */
  speed: number;
  /** flat reduction of every direct hit (never below 25% of the hit). */
  armor: number;
  /** damage multipliers by type; missing = 1. Kept within 0.5..1.5 by design. */
  resist: Partial<Record<DamageType, number>>;
  bounty: number;
  /** castle damage on leak. */
  leak: number;
  /** wave budget cost. */
  threat: number;
  abilities?: EnemyAbility[];
  look: { shape: string; color: number; accent: number; size: number; extras?: string[] };
}

export interface ReactionDef {
  id: string;
  damage: DamageType;
  status: StatusKind;
  mul: number;
  /** extra: 'blast' = 35% splash in 1 cell, 'chain' = +1 chain jump. */
  extra?: 'blast' | 'chain';
}

export interface BoostDef {
  id: string;
  rarity: 'common' | 'rare' | 'epic';
  max: number;
  /** only offered when the player owns / can buy a tower matching this. */
  needs?: { element?: DamageType; tower?: string; attack?: AttackKind; hybrid?: boolean; ability?: string; reaction?: string };
  /** additive modifier deltas, see Mods. Dotted keys address element maps. */
  mods: Record<string, number>;
  /** instant effect when picked. */
  instant?: { coins?: number; heal?: number; freeTower?: boolean };
}

export interface AbilityDef {
  id: string;
  cooldown: number;
  targeted: boolean;
  /** campaign level that unlocks it. */
  unlockLevel: string;
  power: number;
  radius?: number;
  dur?: number;
}

export interface MapDef {
  id: string;
  rows: string[];
}

export interface LevelDef {
  id: string;
  world: number;
  index: number;
  map: string;
  mirror: boolean;
  waves: number;
  /** global hp multiplier of the level. */
  hpMul: number;
  budget: number;
  pool: string[];
  /** partially scripted content: wave index -> fixed groups. */
  scripted: Record<number, { e: string; n: number }[]>;
  boss?: string;
  rewardGold: number;
  unlocksTower?: string;
  unlocksAbility?: string;
}

export interface WorldDef {
  id: number;
  key: string;
  palette: { grassA: number; grassB: number; path: number; pathEdge: number; ground: number; skyTop: string; skyBottom: string; castle: number; roof: number; decor: number; decor2: number };
  decor: string[];
  boss: string;
}

/** Aggregated numeric modifiers (research + events + boosts). All additive fractions unless noted. */
export interface Mods {
  dmgAll: number;
  dmgEl: Record<DamageType, number>;
  rateAll: number;
  rangeAll: number;
  critChance: number;
  critMul: number;
  coinGain: number;
  bountyFlat: number;
  castleHp: number;
  castleHpMul: number;
  startCoins: number;
  towerCost: number;
  upgradeCost: number;
  mergeFee: number;
  burnDmg: number;
  burnDur: number;
  poisonDmg: number;
  poisonStacks: number;
  chillPct: number;
  chillDur: number;
  freezeChance: number;
  chainExtra: number;
  splash: number;
  markPct: number;
  reaction: number;
  abilityCd: number;
  abilityPower: number;
  enemyHp: number;
  enemySpeed: number;
  hybridDmg: number;
  mergeCoins: number;
  meteorEvery: number;
  thorns: number;
  executeAll: number;
  waveHeal: number;
  interest: number;
  bossDmg: number;
  rerolls: number;
  slowedDmg: number;
}

export function emptyMods(): Mods {
  const dmgEl = {} as Record<DamageType, number>;
  for (const d of DAMAGE_TYPES) dmgEl[d] = 0;
  return {
    dmgAll: 0, dmgEl, rateAll: 0, rangeAll: 0, critChance: 0, critMul: 0, coinGain: 0, bountyFlat: 0,
    castleHp: 0, castleHpMul: 0, startCoins: 0, towerCost: 0, upgradeCost: 0, mergeFee: 0,
    burnDmg: 0, burnDur: 0, poisonDmg: 0, poisonStacks: 0, chillPct: 0, chillDur: 0, freezeChance: 0,
    chainExtra: 0, splash: 0, markPct: 0, reaction: 0, abilityCd: 0, abilityPower: 0,
    enemyHp: 0, enemySpeed: 0, hybridDmg: 0, mergeCoins: 0, meteorEvery: 0, thorns: 0, executeAll: 0,
    waveHeal: 0, interest: 0, bossDmg: 0, rerolls: 0, slowedDmg: 0,
  };
}

/** Adds `delta` (flat keys or "dmgEl.fire" style keys) into `m`, scaled by `times`. */
export function addMods(m: Mods, delta: Record<string, number>, times = 1): void {
  for (const key of Object.keys(delta)) {
    const v = delta[key] * times;
    if (key.startsWith('dmgEl.')) {
      const el = key.slice(6) as DamageType;
      if (el in m.dmgEl) m.dmgEl[el] += v;
    } else if (key in m) {
      (m as unknown as Record<string, number>)[key] += v;
    } else {
      throw new Error(`Unknown modifier key: ${key}`);
    }
  }
}

/** Everything the battle needs from the account; frozen for the duration of a run. */
export interface RunContext {
  levelId: string;
  mode: 'campaign' | 'endless';
  seed: number;
  loadout: string[];
  /** card level per tower id (1..), includes mastery already converted to a multiplier. */
  cardMul: Record<string, number>;
  /** research + event modifiers. */
  baseMods: Record<string, number>;
  alchemy: number;
  abilities: string[];
  tutorial?: boolean;
}

export const MAX_TIER = 5;
export const BRANCH_TIER = 3;
export const MAX_ENEMIES_ALIVE = 20;
/** Hard ceiling for any in-run number (coins, damage) – keeps maths inside safe doubles. */
export const NUM_CAP = 1e15;
export const clampNum = (v: number, lo = 0, hi = NUM_CAP): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
