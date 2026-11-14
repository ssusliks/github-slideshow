import { TOWERS } from '../data/towers';
import { ABILITIES, LEVEL_BY_ID } from '../data/worlds';
import { BASE_LOADOUT_SIZE, CARD_MAX_LEVEL, COSMETICS, MASTERY_CAP, RESEARCH_BY_ID, STARTER_TOWERS } from '../data/meta';

export const PROFILE_VERSION = 1;

/** Hard plausibility caps: values above them can only come from a broken or edited save. */
export const CAPS = { gold: 1e10, gems: 1e7, essence: 1e7, shards: 1e6, stat: 1e12, playtime: 3.2e9 };

export interface QuestState { id: string; claimed: boolean }
export interface Profile {
  v: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  /** seconds of active play. */
  playtime: number;
  /** local change counter (monotonic) – used as a tie-breaker when resolving cloud conflicts. */
  rev: number;
  gold: number;
  gems: number;
  essence: number;
  shards: Record<string, number>;
  cards: Record<string, { level: number; mastery: number }>;
  loadout: string[];
  campaign: Record<string, { stars: number; clears: number }>;
  endless: { best: number; day: number; runs: number };
  research: Record<string, number>;
  stats: Record<string, number>;
  daily: { day: number; quests: QuestState[]; progress: Record<string, number> };
  weekly: { week: number; quests: QuestState[]; progress: Record<string, number> };
  achievements: Record<string, number>;
  login: { day: number; streak: number; claimed: boolean };
  time: { lastSeen: number; maxSeen: number; suspect: number };
  /** ids of already applied grants (idempotency ledger). */
  ledger: string[];
  /** owned non-consumable products. */
  owned: string[];
  cosmetics: { owned: string[]; castle: string };
  ads: { day: number; counts: Record<string, number>; winsSinceOffer: number };
  shop: { day: number; counts: Record<string, number> };
  tutorial: { done: boolean; seen: Record<string, boolean> };
  flags: { tamper: number; restored: number };
}

export function newProfile(id: string, now: number): Profile {
  const cards: Profile['cards'] = {};
  for (const t of STARTER_TOWERS) cards[t] = { level: 1, mastery: 0 };
  return {
    v: PROFILE_VERSION, id, createdAt: now, updatedAt: now, playtime: 0, rev: 0,
    gold: 100, gems: 20, essence: 0, shards: {}, cards, loadout: [...STARTER_TOWERS],
    campaign: {}, endless: { best: 0, day: 0, runs: 0 }, research: {}, stats: {},
    daily: { day: 0, quests: [], progress: {} }, weekly: { week: 0, quests: [], progress: {} },
    achievements: {}, login: { day: 0, streak: 0, claimed: false },
    time: { lastSeen: now, maxSeen: now, suspect: 0 }, ledger: [], owned: [],
    cosmetics: { owned: ['default'], castle: 'default' },
    ads: { day: 0, counts: {}, winsSinceOffer: 0 }, shop: { day: 0, counts: {} },
    tutorial: { done: false, seen: {} }, flags: { tamper: 0, restored: 0 },
  };
}

const num = (v: unknown, def: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const int = (v: unknown, def: number, lo: number, hi: number): number => Math.floor(num(v, def, lo, hi));
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const strArr = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-max) : []);
const numMap = (v: unknown, hi: number, allow?: (k: string) => boolean): Record<string, number> => {
  const out: Record<string, number> = {};
  const o = obj(v);
  for (const k of Object.keys(o).slice(0, 400)) if (!allow || allow(k)) out[k] = num(o[k], 0, 0, hi);
  return out;
};
const quests = (v: unknown): QuestState[] => (Array.isArray(v) ? v.filter((q) => q && typeof q.id === 'string').slice(0, 8).map((q) => ({ id: q.id, claimed: !!q.claimed })) : []);

/**
 * Turns arbitrary parsed JSON into a structurally valid profile: fills defaults, drops unknown
 * content ids and clamps every number. Returns null when the input is not a profile at all.
 * Used for local loads, backups and cloud downloads alike.
 */
export function sanitizeProfile(raw: unknown, now: number): Profile | null {
  const r = obj(raw);
  if (typeof r.id !== 'string' || !r.id || r.id.length > 80) return null;
  if (typeof r.v !== 'number' || r.v > PROFILE_VERSION) return null;
  const base = newProfile(r.id, now);
  const p: Profile = base;
  p.createdAt = num(r.createdAt, now, 0, now + 86400000);
  p.updatedAt = num(r.updatedAt, now, 0, Number.MAX_SAFE_INTEGER);
  p.playtime = num(r.playtime, 0, 0, CAPS.playtime);
  p.rev = int(r.rev, 0, 0, Number.MAX_SAFE_INTEGER);
  p.gold = int(r.gold, 0, 0, CAPS.gold);
  p.gems = int(r.gems, 0, 0, CAPS.gems);
  p.essence = int(r.essence, 0, 0, CAPS.essence);
  const isBase = (k: string) => !!TOWERS[k] && !TOWERS[k].hybrid;
  p.shards = numMap(r.shards, CAPS.shards, isBase);
  for (const k of Object.keys(p.shards)) p.shards[k] = Math.floor(p.shards[k]);
  p.cards = {};
  const rc = obj(r.cards);
  for (const k of Object.keys(rc)) if (isBase(k)) p.cards[k] = { level: int(obj(rc[k]).level, 1, 1, CARD_MAX_LEVEL), mastery: int(obj(rc[k]).mastery, 0, 0, MASTERY_CAP) };
  for (const t of STARTER_TOWERS) if (!p.cards[t]) p.cards[t] = { level: 1, mastery: 0 };
  p.research = {};
  const rr = obj(r.research);
  for (const k of Object.keys(rr)) if (RESEARCH_BY_ID[k]) p.research[k] = int(rr[k], 0, 0, RESEARCH_BY_ID[k].max);
  const maxLoadout = BASE_LOADOUT_SIZE + (p.research.loadout ?? 0);
  p.loadout = [...new Set(strArr(r.loadout, 8).filter((t) => p.cards[t]))].slice(0, maxLoadout);
  if (!p.loadout.length) p.loadout = STARTER_TOWERS.filter((t) => p.cards[t]);
  p.campaign = {};
  const cm = obj(r.campaign);
  for (const k of Object.keys(cm)) if (LEVEL_BY_ID[k]) p.campaign[k] = { stars: int(obj(cm[k]).stars, 1, 1, 3), clears: int(obj(cm[k]).clears, 1, 1, 1e6) };
  const en = obj(r.endless);
  p.endless = { best: int(en.best, 0, 0, 100000), day: int(en.day, 0, 0, 1e7), runs: int(en.runs, 0, 0, 1e6) };
  p.stats = numMap(r.stats, CAPS.stat);
  const d = obj(r.daily), w = obj(r.weekly);
  p.daily = { day: int(d.day, 0, 0, 1e7), quests: quests(d.quests), progress: numMap(d.progress, CAPS.stat) };
  p.weekly = { week: int(w.week, 0, 0, 1e7), quests: quests(w.quests), progress: numMap(w.progress, CAPS.stat) };
  p.achievements = numMap(r.achievements, 10);
  const lg = obj(r.login);
  p.login = { day: int(lg.day, 0, 0, 1e7), streak: int(lg.streak, 0, 0, 1e6), claimed: !!lg.claimed };
  const tm = obj(r.time);
  p.time = { lastSeen: num(tm.lastSeen, now, 0, Number.MAX_SAFE_INTEGER), maxSeen: num(tm.maxSeen, now, 0, Number.MAX_SAFE_INTEGER), suspect: int(tm.suspect, 0, 0, 1e6) };
  p.ledger = strArr(r.ledger, 400);
  p.owned = [...new Set(strArr(r.owned, 50))];
  const cs = obj(r.cosmetics);
  const ownedCos = [...new Set(['default', ...strArr(cs.owned, 30).filter((c) => COSMETICS.includes(c))])];
  p.cosmetics = { owned: ownedCos, castle: ownedCos.includes(cs.castle) ? cs.castle : 'default' };
  const ad = obj(r.ads), sh = obj(r.shop);
  p.ads = { day: int(ad.day, 0, 0, 1e7), counts: numMap(ad.counts, 1000), winsSinceOffer: int(ad.winsSinceOffer, 0, 0, 1000) };
  p.shop = { day: int(sh.day, 0, 0, 1e7), counts: numMap(sh.counts, 1000) };
  const tu = obj(r.tutorial);
  p.tutorial = { done: !!tu.done, seen: {} };
  for (const k of Object.keys(obj(tu.seen)).slice(0, 60)) p.tutorial.seen[k] = !!tu.seen[k];
  const fl = obj(r.flags);
  p.flags = { tamper: int(fl.tamper, 0, 0, 1e6), restored: int(fl.restored, 0, 0, 1e6) };
  return p;
}

/** Abilities are derived from campaign progress (never stored), so they cannot desync. */
export function unlockedAbilities(p: Profile): string[] {
  return Object.values(ABILITIES).filter((a) => a.unlockLevel === '' || p.campaign[a.unlockLevel]).map((a) => a.id);
}

/** Single comparable number describing how far a profile has progressed (cloud conflict resolution). */
export function progressScore(p: Profile): number {
  const cleared = Object.keys(p.campaign).length;
  const stars = Object.values(p.campaign).reduce((a, c) => a + c.stars, 0);
  const cards = Object.values(p.cards).reduce((a, c) => a + c.level + c.mastery, 0);
  const research = Object.values(p.research).reduce((a, c) => a + c, 0);
  return cleared * 1000 + stars * 50 + cards * 20 + research * 20 + Math.min(999, Math.floor(p.playtime / 600));
}
