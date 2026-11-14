import type { DamageType } from '../core/types';

/** Account-level (permanent) progression tables: cards, research, quests, achievements, shop, events. */

export interface Reward {
  gold?: number; gems?: number; essence?: number;
  /** shards for specific towers. */
  shards?: Record<string, number>;
  /** shards distributed among unlocked towers. */
  randomShards?: number;
  cosmetic?: string;
}

// ---------------------------------------------------------------- tower cards
export const CARD_MAX_LEVEL = 10;
export const CARD_BONUS = 0.08;
/** shards needed to go from level L to L+1 (index = L). */
export const CARD_SHARDS = [0, 5, 10, 18, 30, 45, 65, 90, 120, 160];
export const cardGold = (level: number) => Math.round(70 * Math.pow(level, 1.7));
export const MASTERY_SHARDS = 100;
export const masteryGold = (m: number) => Math.round(4000 * (1 + 0.25 * Math.min(m, 400)));
export const MASTERY_CAP = 9999;
/** Card multiplier: linear to the level cap, then a slow logarithmic "mastery" tail (no overflow, no runaway). */
export function cardMultiplier(level: number, mastery: number): number {
  const l = Math.min(CARD_MAX_LEVEL, Math.max(1, level));
  return 1 + CARD_BONUS * (l - 1) + 0.5 * Math.log1p(Math.min(MASTERY_CAP, Math.max(0, mastery)) * 0.1);
}
export const STARTER_TOWERS = ['archer', 'cannon', 'fire'];
export const BASE_LOADOUT_SIZE = 4;

// ---------------------------------------------------------------- research tree
export interface ResearchNode {
  id: string;
  max: number;
  currency: 'gold' | 'essence';
  baseCost: number;
  growth: number;
  requires?: { id: string; level: number };
  /** mods added per level (see core Mods). */
  mods?: Record<string, number>;
  /** element whose tower must be unlocked to research (element masteries). */
  element?: DamageType;
  /** grid position in the tree UI. */
  col: number; row: number;
  icon: string;
}
export const RESEARCH: ResearchNode[] = [
  { id: 'weaponry', max: 10, currency: 'gold', baseCost: 120, growth: 1.55, mods: { dmgAll: 0.03 }, col: 1, row: 0, icon: '⚔️' },
  { id: 'rapid', max: 5, currency: 'gold', baseCost: 300, growth: 1.8, requires: { id: 'weaponry', level: 3 }, mods: { rateAll: 0.02 }, col: 0, row: 1, icon: '💨' },
  { id: 'optics', max: 5, currency: 'gold', baseCost: 250, growth: 1.8, requires: { id: 'weaponry', level: 2 }, mods: { rangeAll: 0.02 }, col: 2, row: 1, icon: '🔭' },
  { id: 'fortify', max: 10, currency: 'gold', baseCost: 100, growth: 1.5, mods: { castleHp: 2 }, col: 4, row: 0, icon: '🏰' },
  { id: 'treasury', max: 8, currency: 'gold', baseCost: 110, growth: 1.55, mods: { startCoins: 15 }, col: 3, row: 1, icon: '💰' },
  { id: 'bounty', max: 5, currency: 'gold', baseCost: 350, growth: 1.8, requires: { id: 'treasury', level: 2 }, mods: { coinGain: 0.04 }, col: 3, row: 2, icon: '🪙' },
  { id: 'engineer', max: 3, currency: 'gold', baseCost: 600, growth: 2.2, requires: { id: 'treasury', level: 3 }, mods: { mergeFee: -0.15, upgradeCost: -0.05 }, col: 4, row: 2, icon: '🔧' },
  { id: 'alchemy', max: 3, currency: 'essence', baseCost: 10, growth: 3, requires: { id: 'weaponry', level: 1 }, col: 1, row: 2, icon: '⚗️' },
  { id: 'tactics', max: 5, currency: 'gold', baseCost: 280, growth: 1.8, mods: { abilityCd: 0.05 }, col: 5, row: 1, icon: '⏳' },
  { id: 'arsenal', max: 5, currency: 'gold', baseCost: 400, growth: 1.8, requires: { id: 'tactics', level: 2 }, mods: { abilityPower: 0.1 }, col: 5, row: 2, icon: '☄️' },
  { id: 'loadout', max: 2, currency: 'gold', baseCost: 1500, growth: 4, requires: { id: 'weaponry', level: 2 }, col: 0, row: 2, icon: '🎒' },
  { id: 'fortune', max: 2, currency: 'essence', baseCost: 25, growth: 3, requires: { id: 'alchemy', level: 1 }, mods: { rerolls: 1 }, col: 2, row: 2, icon: '🎲' },
  { id: 'idle', max: 10, currency: 'gold', baseCost: 200, growth: 1.6, col: 4, row: 1, icon: '🌙' },
  { id: 'm_physical', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'physical', mods: { 'dmgEl.physical': 0.04 }, col: 0, row: 3, icon: '🏹' },
  { id: 'm_fire', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'fire', mods: { 'dmgEl.fire': 0.04 }, col: 1, row: 3, icon: '🔥' },
  { id: 'm_ice', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'ice', mods: { 'dmgEl.ice': 0.04 }, col: 2, row: 3, icon: '❄️' },
  { id: 'm_poison', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'poison', mods: { 'dmgEl.poison': 0.04 }, col: 3, row: 3, icon: '☠️' },
  { id: 'm_lightning', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'lightning', mods: { 'dmgEl.lightning': 0.04 }, col: 4, row: 3, icon: '⚡' },
  { id: 'm_arcane', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'arcane', mods: { 'dmgEl.arcane': 0.04 }, col: 5, row: 3, icon: '🔮' },
  { id: 'm_light', max: 10, currency: 'essence', baseCost: 6, growth: 1.45, element: 'light', mods: { 'dmgEl.light': 0.04 }, col: 5, row: 0, icon: '☀️' },
];
export const RESEARCH_BY_ID: Record<string, ResearchNode> = Object.fromEntries(RESEARCH.map((r) => [r.id, r]));
export const researchCost = (n: ResearchNode, level: number) => Math.round(n.baseCost * Math.pow(n.growth, level));
export const IDLE_BONUS_PER_LEVEL = 0.1;

// ---------------------------------------------------------------- rewards & offline
export const OFFLINE_CAP_HOURS = 8;
export const offlineRate = (cleared: number) => 20 + 9 * cleared;
export const FIRST_CLEAR_GOLD_MUL = 2;
export const REPLAY_GOLD_MUL = 0.6;
export const FIRST_CLEAR_GEMS = 5;
export const THREE_STAR_GEMS = 5;
export const BOSS_ESSENCE_FIRST = 20;
export const BOSS_ESSENCE_REPLAY = 3;
export const LEVEL_ESSENCE = 2;
export const REVIVE_GEMS = 15;
export const starsFor = (hpPct: number) => (hpPct >= 0.9 ? 3 : hpPct >= 0.5 ? 2 : 1);

// ---------------------------------------------------------------- quests
export interface QuestDef { id: string; stat: string; goal: number; reward: Reward; minLevel?: number }
export const DAILY_QUESTS: QuestDef[] = [
  { id: 'd_kills', stat: 'kills', goal: 80, reward: { gold: 150 } },
  { id: 'd_wins', stat: 'wins', goal: 3, reward: { gold: 200, randomShards: 6 } },
  { id: 'd_merges', stat: 'merges', goal: 10, reward: { gold: 120, randomShards: 5 } },
  { id: 'd_abilities', stat: 'abilities', goal: 6, reward: { gold: 120 } },
  { id: 'd_stars', stat: 'threeStars', goal: 1, reward: { gems: 5 } },
  { id: 'd_boosts', stat: 'boosts', goal: 8, reward: { gold: 140 } },
  { id: 'd_hybrid', stat: 'hybrids', goal: 2, reward: { randomShards: 10 }, minLevel: 4 },
  { id: 'd_endless', stat: 'endlessWaves', goal: 8, reward: { essence: 4, gold: 100 }, minLevel: 6 },
  { id: 'd_upgrade', stat: 'cardUpgrades', goal: 1, reward: { gold: 160 } },
];
export const WEEKLY_QUESTS: QuestDef[] = [
  { id: 'w_wins', stat: 'wins', goal: 15, reward: { gems: 25, gold: 600 } },
  { id: 'w_kills', stat: 'kills', goal: 700, reward: { gems: 15, randomShards: 20 } },
  { id: 'w_merges', stat: 'merges', goal: 60, reward: { gems: 15, essence: 10 } },
  { id: 'w_bosses', stat: 'bosses', goal: 3, reward: { gems: 20, essence: 15 }, minLevel: 6 },
  { id: 'w_endless', stat: 'endlessWaves', goal: 40, reward: { gems: 20, essence: 12 }, minLevel: 6 },
  { id: 'w_research', stat: 'researches', goal: 5, reward: { gems: 15, gold: 500 } },
];
export const DAILY_QUEST_COUNT = 3;
export const WEEKLY_QUEST_COUNT = 3;

// ---------------------------------------------------------------- achievements
export interface AchievementDef { id: string; stat: string; tiers: number[]; rewards: Reward[]; best?: boolean }
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'a_kills', stat: 'kills', tiers: [100, 1000, 10000], rewards: [{ gems: 10 }, { gems: 25 }, { gems: 60 }] },
  { id: 'a_wins', stat: 'wins', tiers: [5, 25, 100], rewards: [{ gems: 10 }, { gems: 25 }, { gems: 60 }] },
  { id: 'a_merges', stat: 'merges', tiers: [20, 200, 1000], rewards: [{ gems: 10 }, { gems: 25 }, { gems: 60 }] },
  { id: 'a_hybrids', stat: 'hybrids', tiers: [1, 10, 50], rewards: [{ gems: 10 }, { gems: 20 }, { gems: 50 }] },
  { id: 'a_bosses', stat: 'bosses', tiers: [1, 5, 20], rewards: [{ gems: 15, essence: 10 }, { gems: 30, essence: 20 }, { gems: 60, essence: 40 }] },
  { id: 'a_stars', stat: 'stars', tiers: [10, 40, 72], rewards: [{ gems: 15 }, { gems: 40 }, { gems: 80, cosmetic: 'golden' }], best: true },
  { id: 'a_endless', stat: 'endlessBest', tiers: [5, 15, 30], rewards: [{ gems: 15 }, { gems: 30, cosmetic: 'crystal' }, { gems: 80 }], best: true },
  { id: 'a_tier', stat: 'maxTier', tiers: [3, 4, 5], rewards: [{ gems: 5 }, { gems: 15 }, { gems: 40 }], best: true },
  { id: 'a_collection', stat: 'towersUnlocked', tiers: [5, 8], rewards: [{ gems: 20 }, { gems: 50 }], best: true },
  { id: 'a_research', stat: 'researches', tiers: [10, 40, 80], rewards: [{ gems: 15 }, { gems: 40 }, { gems: 80 }] },
];

// ---------------------------------------------------------------- login calendar
export const LOGIN_REWARDS: Reward[] = [
  { gold: 150 }, { randomShards: 10 }, { gems: 10 }, { gold: 350 }, { essence: 10 }, { randomShards: 20 }, { gems: 30 },
];

// ---------------------------------------------------------------- shop
export interface IapProduct { id: string; type: 'consumable' | 'nonconsumable'; price: string; reward: Reward; once?: boolean; premium?: boolean }
/** Real-money products. Prices shown here are fallbacks; stores provide localised prices at runtime. */
export const IAP_PRODUCTS: IapProduct[] = [
  { id: 'gems_small', type: 'consumable', price: '$0.99', reward: { gems: 80 } },
  { id: 'gems_medium', type: 'consumable', price: '$4.99', reward: { gems: 500 } },
  { id: 'gems_large', type: 'consumable', price: '$9.99', reward: { gems: 1200 } },
  { id: 'starter_pack', type: 'nonconsumable', price: '$2.99', reward: { gems: 300, gold: 2000, randomShards: 30 }, once: true },
  { id: 'premium', type: 'nonconsumable', price: '$5.99', reward: { gems: 100, cosmetic: 'royal' }, once: true, premium: true },
];
export const PREMIUM_BENEFITS = { goldBonus: 0.2, skipAds: true, noOffers: true };

export interface GemItem { id: string; cost: number; reward?: Reward; cosmetic?: string; goldHours?: number; dailyLimit?: number }
export const GEM_SHOP: GemItem[] = [
  { id: 'gold_pack', cost: 60, goldHours: 6, dailyLimit: 5 },
  { id: 'shard_chest', cost: 50, reward: { randomShards: 25 }, dailyLimit: 5 },
  { id: 'essence_vial', cost: 70, reward: { essence: 15 }, dailyLimit: 3 },
  { id: 'skin_obsidian', cost: 300, cosmetic: 'obsidian' },
  { id: 'skin_golden', cost: 600, cosmetic: 'golden' },
  { id: 'skin_crystal', cost: 600, cosmetic: 'crystal' },
];
export const COSMETICS = ['default', 'obsidian', 'golden', 'crystal', 'royal'];

/** Rewarded-ad placements and their daily caps. All of them are optional for the player. */
export const AD_PLACEMENTS: Record<string, { daily: number; reward?: Reward; goldHours?: number }> = {
  double_reward: { daily: 10 },
  revive: { daily: 8 },
  offline_x2: { daily: 4 },
  reroll: { daily: 6 },
  free_gold: { daily: 3, goldHours: 2 },
  free_shards: { daily: 2, reward: { randomShards: 8 } },
  offer_chest: { daily: 3, reward: { randomShards: 6, gems: 3 } },
};
/** Optional offer between levels: shown at most every N wins and within the daily cap above. */
export const OFFER_EVERY_WINS = 3;

// ---------------------------------------------------------------- timed events
export interface EventDef { id: string; days: number[]; mods?: Record<string, number>; goldMul?: number; shardMul?: number; element?: DamageType }
const ELEMENT_ROTATION: DamageType[] = ['fire', 'ice', 'physical', 'poison', 'lightning', 'arcane', 'light'];
/** Events are derived from the calendar so they also work offline; day 0 = Sunday. */
export function eventsAt(nowMs: number): (EventDef & { endsAt: number })[] {
  const d = new Date(nowMs);
  const day = d.getDay();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const week = Math.floor((dayStart / 86400000 + 4) / 7);
  const out: (EventDef & { endsAt: number })[] = [];
  if (day === 6 || day === 0) {
    out.push({ id: 'goldrush', days: [6, 0], goldMul: 1.5, endsAt: dayStart + (day === 6 ? 2 : 1) * 86400000 });
  } else {
    const el = ELEMENT_ROTATION[week % ELEMENT_ROTATION.length];
    out.push({ id: `week_${el}`, days: [1, 2, 3, 4, 5], element: el, mods: { [`dmgEl.${el}`]: 0.15 }, shardMul: 1.5, endsAt: dayStart + (6 - day) * 86400000 });
  }
  return out;
}

/** Battle pass is not part of v1; the season shape is fixed here so saves stay compatible later. */
export interface BattlePassSeason { id: string; startsAt: number; endsAt: number; tiers: { xp: number; free: Reward; premium?: Reward }[] }
export const BATTLE_PASS_ENABLED = false;
