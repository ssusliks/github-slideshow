import type { BoostDef } from '../core/types';

/**
 * Roguelike boosts offered after each wave (pick 1 of 3). They only live for the current run.
 * `needs` keeps offers relevant: a boost is never offered when the player cannot benefit from it.
 */
export const BOOSTS: BoostDef[] = [
  // ---- common ----
  { id: 'sharp', rarity: 'common', max: 5, mods: { dmgAll: 0.12 } },
  { id: 'swift', rarity: 'common', max: 5, mods: { rateAll: 0.1 } },
  { id: 'farsight', rarity: 'common', max: 3, mods: { rangeAll: 0.1 } },
  { id: 'purse', rarity: 'common', max: 3, mods: {}, instant: { coins: 90 } },
  { id: 'bounty', rarity: 'common', max: 4, mods: { coinGain: 0.2 } },
  { id: 'masonry', rarity: 'common', max: 3, mods: { castleHp: 5 }, instant: { heal: 5 } },
  { id: 'discount', rarity: 'common', max: 3, mods: { towerCost: -0.12, upgradeCost: -0.12 } },
  { id: 'el_physical', rarity: 'common', max: 4, needs: { element: 'physical' }, mods: { 'dmgEl.physical': 0.22 } },
  { id: 'el_fire', rarity: 'common', max: 4, needs: { element: 'fire' }, mods: { 'dmgEl.fire': 0.22 } },
  { id: 'el_ice', rarity: 'common', max: 4, needs: { element: 'ice' }, mods: { 'dmgEl.ice': 0.3 } },
  { id: 'el_poison', rarity: 'common', max: 4, needs: { element: 'poison' }, mods: { 'dmgEl.poison': 0.25 } },
  { id: 'el_lightning', rarity: 'common', max: 4, needs: { element: 'lightning' }, mods: { 'dmgEl.lightning': 0.22 } },
  { id: 'el_arcane', rarity: 'common', max: 4, needs: { element: 'arcane' }, mods: { 'dmgEl.arcane': 0.22 } },
  { id: 'el_light', rarity: 'common', max: 4, needs: { element: 'light' }, mods: { 'dmgEl.light': 0.3 } },
  // ---- rare ----
  { id: 'crit', rarity: 'rare', max: 3, mods: { critChance: 0.1, critMul: 0.25 } },
  { id: 'longburn', rarity: 'rare', max: 2, needs: { element: 'fire' }, mods: { burnDmg: 0.4, burnDur: 0.4 } },
  { id: 'deepfreeze', rarity: 'rare', max: 2, needs: { element: 'ice' }, mods: { chillPct: 0.1, chillDur: 0.4, freezeChance: 0.05 } },
  { id: 'virulent', rarity: 'rare', max: 2, needs: { element: 'poison' }, mods: { poisonDmg: 0.35, poisonStacks: 2 } },
  { id: 'forked', rarity: 'rare', max: 2, needs: { attack: 'chain' }, mods: { chainExtra: 2 } },
  { id: 'bigboom', rarity: 'rare', max: 2, needs: { attack: 'projectile', tower: 'cannon' }, mods: { splash: 0.3, 'dmgEl.physical': 0.1 } },
  { id: 'exposed', rarity: 'rare', max: 2, needs: { element: 'arcane' }, mods: { markPct: 0.12 } },
  { id: 'catalyst', rarity: 'rare', max: 3, needs: { reaction: 'any' }, mods: { reaction: 0.5 } },
  { id: 'coldsnap', rarity: 'rare', max: 2, needs: { element: 'ice' }, mods: { slowedDmg: 0.2 } },
  { id: 'warhorn', rarity: 'rare', max: 2, needs: { ability: 'any' }, mods: { abilityCd: 0.2, abilityPower: 0.3 } },
  { id: 'interest', rarity: 'rare', max: 2, mods: { interest: 0.1 } },
  { id: 'mender', rarity: 'rare', max: 2, mods: { waveHeal: 2 } },
  { id: 'giantslayer', rarity: 'rare', max: 2, mods: { bossDmg: 0.3 } },
  { id: 'recruit', rarity: 'rare', max: 2, mods: {}, instant: { freeTower: true } },
  // ---- epic: strategy-changing ----
  { id: 'glasscannon', rarity: 'epic', max: 1, mods: { dmgAll: 0.6, castleHpMul: -0.5 } },
  { id: 'greed', rarity: 'epic', max: 1, mods: { coinGain: 0.6, enemyHp: 0.15 } },
  { id: 'mergemaster', rarity: 'epic', max: 1, mods: { mergeFee: -1, mergeCoins: 30 } },
  { id: 'alchemist', rarity: 'epic', max: 1, needs: { hybrid: true }, mods: { hybridDmg: 0.45 } },
  { id: 'starfall', rarity: 'epic', max: 1, mods: { meteorEvery: 14 } },
  { id: 'thorns', rarity: 'epic', max: 1, mods: { thorns: 1 } },
  { id: 'reaper', rarity: 'epic', max: 1, mods: { executeAll: 0.08 } },
  { id: 'timewarp', rarity: 'epic', max: 1, mods: { enemySpeed: -0.15, rateAll: 0.1 } },
  { id: 'overclock', rarity: 'epic', max: 1, mods: { rateAll: 0.35, rangeAll: -0.1 } },
];

export const BOOST_BY_ID: Record<string, BoostDef> = Object.fromEntries(BOOSTS.map((b) => [b.id, b]));
export const BOOST_WEIGHTS = { common: 60, rare: 30, epic: 10 };
export const REROLL_COST = 30;
