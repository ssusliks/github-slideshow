import type { BattleState } from '../core/battle';
import { Rng, hashStr } from '../core/rng';
import type { DamageType, RunContext } from '../core/types';
import {
  ACHIEVEMENTS, AD_PLACEMENTS, BASE_LOADOUT_SIZE, BOSS_ESSENCE_FIRST, BOSS_ESSENCE_REPLAY, CARD_MAX_LEVEL, CARD_SHARDS, DAILY_QUESTS,
  DAILY_QUEST_COUNT, FIRST_CLEAR_GEMS, FIRST_CLEAR_GOLD_MUL, GEM_SHOP, IAP_PRODUCTS, IDLE_BONUS_PER_LEVEL, LEVEL_ESSENCE, LOGIN_REWARDS,
  MASTERY_CAP, MASTERY_SHARDS, OFFER_EVERY_WINS, OFFLINE_CAP_HOURS, PREMIUM_BENEFITS, QuestDef, REPLAY_GOLD_MUL, RESEARCH, RESEARCH_BY_ID,
  REVIVE_GEMS, Reward, THREE_STAR_GEMS, WEEKLY_QUESTS, WEEKLY_QUEST_COUNT, cardGold, cardMultiplier, eventsAt, masteryGold, offlineRate,
  researchCost, starsFor,
} from '../data/meta';
import { TOWERS } from '../data/towers';
import { ENDLESS, LEVELS, LEVEL_BY_ID, WORLDS } from '../data/worlds';
import { CAPS, Profile, unlockedAbilities } from './profile';

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export interface ActiveRun { runId: string; levelId: string; mode: 'campaign' | 'endless'; startedAt: number; seed: number }
export interface RunSummary {
  won: boolean; mode: 'campaign' | 'endless'; levelId: string; stars: number; firstClear: boolean;
  reward: Required<Pick<Reward, 'gold' | 'gems' | 'essence'>> & { shards: Record<string, number> };
  unlockedTower?: string; unlockedAbility?: string; unlockedWorld?: number; endlessUnlocked?: boolean;
  wave: number; bestEndless: boolean; canDouble: boolean; runId: string;
}
export interface GameDeps {
  now: () => number;
  /** called after every mutation; `critical` asks for an immediate flush + backup rotation. */
  onChange: (critical: boolean) => void;
  /** security / diagnostics sink. */
  log: (kind: string, detail: string) => void;
}

const DAY = 86400000;
const TZ = () => new Date().getTimezoneOffset() * 60000;
export const dayIndex = (ms: number) => Math.floor((ms - TZ()) / DAY);
export const weekIndex = (ms: number) => Math.floor((dayIndex(ms) + 3) / 7);
/** Clock rollbacks larger than this are treated as tampering (smaller ones are DST / NTP noise). */
const ROLLBACK_TOLERANCE = 5 * 60000;

/**
 * Account-level game rules. Every mutation of the profile goes through this class, which
 * validates inputs, keeps the reward ledger (idempotent grants) and notifies persistence.
 */
export class Game {
  activeRun: ActiveRun | null = null;
  lastSummary: RunSummary | null = null;

  constructor(public p: Profile, private deps: GameDeps) {
    this.touchTime();
    this.refreshPeriods();
  }

  // ------------------------------------------------------------------ time
  /** Wall clock guarded by a high-water mark: time never counts twice after a clock rollback. */
  effectiveNow(): number {
    return Math.max(this.deps.now(), this.p.time.maxSeen);
  }
  /** Records "now"; returns false when a suspicious clock rollback was detected. */
  touchTime(): boolean {
    const now = this.deps.now(), t = this.p.time;
    let ok = true;
    if (now < t.maxSeen - ROLLBACK_TOLERANCE) {
      // The clock went backwards. No punishment: time-based income simply waits for the mark.
      t.suspect++;
      ok = false;
      this.deps.log('time_rollback', `now=${now} max=${t.maxSeen}`);
    }
    t.maxSeen = Math.max(t.maxSeen, now);
    return ok;
  }
  addPlaytime(sec: number): void {
    this.p.playtime = Math.min(CAPS.playtime, this.p.playtime + Math.max(0, Math.min(sec, 60)));
  }
  private changed(critical = false): void {
    this.p.rev++;
    this.p.updatedAt = this.deps.now();
    this.deps.onChange(critical);
  }

  // ------------------------------------------------------------------ currencies & grants
  isPremium(): boolean {
    return this.p.owned.includes('premium');
  }
  spend(cur: 'gold' | 'gems' | 'essence', amount: number): boolean {
    if (!Number.isFinite(amount) || amount < 0) return false;
    const a = Math.ceil(amount);
    if (this.p[cur] < a) return false;
    this.p[cur] -= a;
    return true;
  }
  private add(cur: 'gold' | 'gems' | 'essence', amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.p[cur] = Math.min(CAPS[cur], this.p[cur] + Math.floor(amount));
  }
  /** Resolves "random shards" deterministically from the grant id so a retried grant is identical. */
  resolveReward(r: Reward, grantId: string): Required<Pick<Reward, 'gold' | 'gems' | 'essence'>> & { shards: Record<string, number>; cosmetic?: string } {
    const shards: Record<string, number> = { ...(r.shards ?? {}) };
    if (r.randomShards && r.randomShards > 0) {
      const ev = this.events().find((e) => e.element);
      const owned = Object.keys(this.p.cards);
      const weights = owned.map((t) => (this.p.loadout.includes(t) ? 2 : 1) * (ev && TOWERS[t].element === ev.element ? 3 : 1));
      const rng = new Rng(hashStr(grantId));
      let left = Math.round(r.randomShards);
      const chunk = Math.max(1, Math.ceil(left / 3));
      while (left > 0) {
        const t = owned[rng.weighted(weights)];
        const n = Math.min(left, chunk);
        shards[t] = (shards[t] ?? 0) + n;
        left -= n;
      }
    }
    return { gold: Math.floor(r.gold ?? 0), gems: Math.floor(r.gems ?? 0), essence: Math.floor(r.essence ?? 0), shards, cosmetic: r.cosmetic };
  }
  /**
   * Applies a reward exactly once per `grantId`. Returns false (and changes nothing) when the
   * id is already in the ledger – this is what makes ad / purchase / level rewards replay-safe.
   */
  grant(r: Reward, grantId: string, critical = true): boolean {
    if (!grantId || this.p.ledger.includes(grantId)) return false;
    const res = this.resolveReward(r, grantId);
    this.add('gold', res.gold);
    this.add('gems', res.gems);
    this.add('essence', res.essence);
    for (const t of Object.keys(res.shards)) {
      if (!TOWERS[t] || TOWERS[t].hybrid) continue;
      this.p.shards[t] = Math.min(CAPS.shards, (this.p.shards[t] ?? 0) + Math.max(0, Math.floor(res.shards[t])));
    }
    if (res.cosmetic && !this.p.cosmetics.owned.includes(res.cosmetic)) this.p.cosmetics.owned.push(res.cosmetic);
    this.p.ledger.push(grantId);
    if (this.p.ledger.length > 400) this.p.ledger.splice(0, this.p.ledger.length - 400);
    this.changed(critical);
    return true;
  }
  hasGrant(id: string): boolean {
    return this.p.ledger.includes(id);
  }

  // ------------------------------------------------------------------ stats, quests, achievements
  track(stat: string, n = 1): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const p = this.p;
    p.stats[stat] = Math.min(CAPS.stat, (p.stats[stat] ?? 0) + n);
    p.daily.progress[stat] = (p.daily.progress[stat] ?? 0) + n;
    p.weekly.progress[stat] = (p.weekly.progress[stat] ?? 0) + n;
  }
  private setBest(stat: string, v: number): void {
    if (v > (this.p.stats[stat] ?? 0)) this.p.stats[stat] = v;
  }
  private recomputeBests(): void {
    this.setBest('stars', Object.values(this.p.campaign).reduce((a, c) => a + c.stars, 0));
    this.setBest('towersUnlocked', Object.keys(this.p.cards).length);
    this.setBest('endlessBest', this.p.endless.best);
  }

  /** Rolls daily/weekly quests, login day and daily counters when the (guarded) date changes. */
  refreshPeriods(): void {
    const p = this.p, now = this.effectiveNow();
    const day = dayIndex(now), week = weekIndex(now);
    const cleared = this.clearedCount();
    const pick = (pool: QuestDef[], count: number, seed: string): { id: string; claimed: boolean }[] => {
      const rng = new Rng(hashStr(seed));
      const avail = pool.filter((q) => (q.minLevel ?? 0) <= cleared);
      return rng.shuffle(avail.slice()).slice(0, count).map((q) => ({ id: q.id, claimed: false }));
    };
    let dirty = false;
    if (p.daily.day !== day) {
      p.daily = { day, quests: pick(DAILY_QUESTS, DAILY_QUEST_COUNT, `${p.id}:d${day}`), progress: {} };
      dirty = true;
    }
    if (p.weekly.week !== week) {
      p.weekly = { week, quests: pick(WEEKLY_QUESTS, WEEKLY_QUEST_COUNT, `${p.id}:w${week}`), progress: {} };
      dirty = true;
    }
    if (p.login.day !== day) {
      p.login = { day, streak: p.login.day === day - 1 ? p.login.streak + 1 : 1, claimed: false };
      dirty = true;
    }
    if (p.ads.day !== day) { p.ads = { day, counts: {}, winsSinceOffer: p.ads.winsSinceOffer }; dirty = true; }
    if (p.shop.day !== day) { p.shop = { day, counts: {} }; dirty = true; }
    if (p.endless.day !== day) { p.endless.day = day; p.endless.runs = 0; dirty = true; }
    if (dirty) this.changed();
  }

  questList(kind: 'daily' | 'weekly'): { def: QuestDef; progress: number; claimed: boolean; done: boolean }[] {
    const st = this.p[kind], pool = kind === 'daily' ? DAILY_QUESTS : WEEKLY_QUESTS;
    return st.quests.flatMap((q) => {
      const def = pool.find((d) => d.id === q.id);
      if (!def) return [];
      const progress = Math.min(def.goal, st.progress[def.stat] ?? 0);
      return [{ def, progress, claimed: q.claimed, done: progress >= def.goal }];
    });
  }
  claimQuest(kind: 'daily' | 'weekly', id: string): Result<{ reward: ReturnType<Game['resolveReward']> }> {
    const st = this.p[kind];
    const entry = this.questList(kind).find((q) => q.def.id === id);
    const q = st.quests.find((x) => x.id === id);
    if (!entry || !q) return fail('err.unknown');
    if (q.claimed) return fail('err.claimed');
    if (!entry.done) return fail('err.not_done');
    const grantId = `quest:${kind}:${kind === 'daily' ? this.p.daily.day : this.p.weekly.week}:${id}`;
    const reward = this.resolveReward(entry.def.reward, grantId);
    q.claimed = true;
    if (!this.grant(entry.def.reward, grantId)) this.changed();
    return { ok: true, reward };
  }

  achievementList(): { def: (typeof ACHIEVEMENTS)[number]; value: number; claimed: number; next: number | null; claimable: boolean }[] {
    this.recomputeBests();
    return ACHIEVEMENTS.map((def) => {
      const value = this.p.stats[def.stat] ?? 0;
      const claimed = Math.min(def.tiers.length, this.p.achievements[def.id] ?? 0);
      const next = claimed < def.tiers.length ? def.tiers[claimed] : null;
      return { def, value, claimed, next, claimable: next !== null && value >= next };
    });
  }
  claimAchievement(id: string): Result<{ reward: ReturnType<Game['resolveReward']> }> {
    const a = this.achievementList().find((x) => x.def.id === id);
    if (!a) return fail('err.unknown');
    if (!a.claimable) return fail('err.not_done');
    const grantId = `ach:${id}:${a.claimed}`;
    const r = a.def.rewards[a.claimed];
    const reward = this.resolveReward(r, grantId);
    this.p.achievements[id] = a.claimed + 1;
    if (!this.grant(r, grantId)) this.changed();
    return { ok: true, reward };
  }
  claimableCount(): number {
    return this.questList('daily').filter((q) => q.done && !q.claimed).length + this.questList('weekly').filter((q) => q.done && !q.claimed).length +
      this.achievementList().filter((a) => a.claimable).length + (this.p.login.claimed ? 0 : 1);
  }

  loginReward(): { index: number; reward: Reward; claimed: boolean } {
    const index = (Math.max(1, this.p.login.streak) - 1) % LOGIN_REWARDS.length;
    return { index, reward: LOGIN_REWARDS[index], claimed: this.p.login.claimed };
  }
  claimLogin(): Result<{ reward: ReturnType<Game['resolveReward']> }> {
    const l = this.loginReward();
    if (l.claimed) return fail('err.claimed');
    const grantId = `login:${this.p.login.day}`;
    const reward = this.resolveReward(l.reward, grantId);
    this.p.login.claimed = true;
    if (!this.grant(l.reward, grantId)) this.changed();
    return { ok: true, reward };
  }

  // ------------------------------------------------------------------ campaign
  clearedCount(): number {
    return Object.keys(this.p.campaign).length;
  }
  isLevelUnlocked(id: string): boolean {
    const l = LEVEL_BY_ID[id];
    if (!l) return false;
    return l.index === 0 || !!this.p.campaign[LEVELS[l.index - 1].id];
  }
  worldsUnlocked(): number {
    let n = 1;
    for (const w of WORLDS) if (this.isLevelUnlocked(`${w.id}-1`)) n = w.id;
    return n;
  }
  nextLevelId(): string {
    const l = LEVELS.find((x) => !this.p.campaign[x.id]);
    return (l ?? LEVELS[LEVELS.length - 1]).id;
  }
  endlessUnlocked(): boolean {
    return !!this.p.campaign[ENDLESS.unlockLevel];
  }
  events() {
    return eventsAt(this.effectiveNow());
  }

  // ------------------------------------------------------------------ cards & loadout
  loadoutSize(): number {
    return BASE_LOADOUT_SIZE + (this.p.research.loadout ?? 0);
  }
  setLoadout(ids: string[]): Result {
    const uniq = [...new Set(ids)];
    if (!uniq.length || uniq.length > this.loadoutSize()) return fail('err.loadout_size');
    if (uniq.some((t) => !this.p.cards[t])) return fail('err.locked');
    this.p.loadout = uniq;
    this.changed();
    return { ok: true };
  }
  cardInfo(id: string) {
    const c = this.p.cards[id];
    const level = c?.level ?? 0, mastery = c?.mastery ?? 0;
    const maxed = level >= CARD_MAX_LEVEL;
    const needShards = maxed ? MASTERY_SHARDS : CARD_SHARDS[level] ?? 0;
    const needGold = maxed ? masteryGold(mastery) : cardGold(level);
    return {
      unlocked: !!c, level, mastery, maxed, needShards, needGold, shards: this.p.shards[id] ?? 0,
      mul: c ? cardMultiplier(level, mastery) : 1,
      nextMul: c ? (maxed ? cardMultiplier(level, mastery + 1) : cardMultiplier(level + 1, mastery)) : 1,
      canUpgrade: !!c && (this.p.shards[id] ?? 0) >= needShards && this.p.gold >= needGold && (!maxed || mastery < MASTERY_CAP),
    };
  }
  upgradeCard(id: string): Result {
    const info = this.cardInfo(id);
    if (!info.unlocked) return fail('err.locked');
    if (info.maxed && info.mastery >= MASTERY_CAP) return fail('err.max');
    if (info.shards < info.needShards) return fail('err.shards');
    if (!this.spend('gold', info.needGold)) return fail('err.gold');
    this.p.shards[id] = info.shards - info.needShards;
    if (info.maxed) this.p.cards[id].mastery++;
    else this.p.cards[id].level++;
    this.track('cardUpgrades');
    this.changed(true);
    return { ok: true };
  }

  // ------------------------------------------------------------------ research
  researchInfo(id: string) {
    const n = RESEARCH_BY_ID[id];
    const level = this.p.research[id] ?? 0;
    const cost = researchCost(n, level);
    let locked: string | null = null;
    if (n.requires && (this.p.research[n.requires.id] ?? 0) < n.requires.level) locked = 'research.need_node';
    else if (n.element && !Object.keys(this.p.cards).some((t) => TOWERS[t].element === n.element)) locked = 'research.need_tower';
    else if (id === 'alchemy' && !this.p.campaign['1-3']) locked = 'research.need_campaign';
    const maxed = level >= n.max;
    return { node: n, level, cost, locked, maxed, canBuy: !locked && !maxed && this.p[n.currency] >= cost };
  }
  buyResearch(id: string): Result {
    if (!RESEARCH_BY_ID[id]) return fail('err.unknown');
    const info = this.researchInfo(id);
    if (info.locked) return fail(info.locked);
    if (info.maxed) return fail('err.max');
    if (!this.spend(info.node.currency, info.cost)) return fail(info.node.currency === 'gold' ? 'err.gold' : 'err.essence');
    this.p.research[id] = info.level + 1;
    this.track('researches');
    this.changed(true);
    return { ok: true };
  }
  /** Permanent modifiers handed to a battle (research + live events). Premium adds nothing here. */
  baseMods(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of RESEARCH) {
      const lvl = this.p.research[n.id] ?? 0;
      if (!lvl || !n.mods) continue;
      for (const k of Object.keys(n.mods)) out[k] = (out[k] ?? 0) + n.mods[k] * lvl;
    }
    for (const e of this.events()) if (e.mods) for (const k of Object.keys(e.mods)) out[k] = (out[k] ?? 0) + e.mods[k];
    return out;
  }
  alchemyLevel(): number {
    return this.p.research.alchemy ?? 0;
  }

  // ------------------------------------------------------------------ runs
  buildContext(levelId: string, mode: 'campaign' | 'endless', seed: number): RunContext {
    const cardMul: Record<string, number> = {};
    for (const t of Object.keys(this.p.cards)) cardMul[t] = cardMultiplier(this.p.cards[t].level, this.p.cards[t].mastery);
    const baseMods = this.baseMods();
    if (mode === 'endless') baseMods.__worlds = this.worldsUnlocked();
    return {
      levelId, mode, seed, loadout: this.p.loadout.filter((t) => this.p.cards[t]), cardMul, baseMods,
      alchemy: this.alchemyLevel(), abilities: unlockedAbilities(this.p),
      tutorial: mode === 'campaign' && levelId === '1-1' && !this.p.tutorial.done,
    };
  }
  beginRun(levelId: string, mode: 'campaign' | 'endless', runId: string): Result<{ ctx: RunContext; run: ActiveRun }> {
    if (mode === 'campaign' && !this.isLevelUnlocked(levelId)) return fail('err.locked');
    if (mode === 'endless' && !this.endlessUnlocked()) return fail('err.locked');
    const seed = hashStr(runId);
    const run: ActiveRun = { runId, levelId: mode === 'endless' ? 'endless' : levelId, mode, startedAt: this.deps.now(), seed };
    this.activeRun = run;
    this.lastSummary = null;
    return { ok: true, ctx: this.buildContext(run.levelId, mode, seed), run };
  }
  abandonRun(): void {
    this.activeRun = null;
  }

  /**
   * Converts a finished battle into account rewards. Sanity-checks the result first:
   * an implausible battle (wrong level, zero time, no kills on a win) is rejected, logged and
   * leaves the profile untouched. Rewards are keyed by run id, so a repeated call is a no-op.
   */
  finishRun(state: BattleState): Result<{ summary: RunSummary }> {
    const run = this.activeRun, p = this.p;
    if (!run) return fail('err.no_run');
    if (state.ctx.seed !== run.seed || state.ctx.mode !== run.mode || state.ctx.levelId !== run.levelId) {
      this.deps.log('run_mismatch', `${run.runId}`);
      return fail('err.run_mismatch');
    }
    const won = state.phase === 'won';
    if (state.phase !== 'won' && state.phase !== 'lost') return fail('err.not_finished');
    const grantId = `run:${run.runId}`;
    const st = state.stats;
    if (won && (state.time < 15 || st.kills < 3 || state.castleHp <= 0)) {
      this.deps.log('run_implausible', `t=${state.time} k=${st.kills}`);
      this.activeRun = null;
      return fail('err.run_rejected');
    }
    if (this.hasGrant(grantId)) return this.lastSummary ? { ok: true, summary: this.lastSummary } : fail('err.claimed');

    // Lifetime counters (quests / achievements) count for wins and losses alike.
    this.track('kills', Math.min(st.kills, 5000));
    this.track('merges', Math.min(st.merges, 500));
    this.track('hybrids', Math.min(st.hybrids, 100));
    this.track('abilities', Math.min(st.abilities, 500));
    this.track('boosts', Math.min(st.boosts, 500));
    this.track('bosses', Math.min(st.bosses, 100));
    this.setBest('maxTier', Math.min(5, st.maxTier));

    const goldMul = (1 + (this.isPremium() ? PREMIUM_BENEFITS.goldBonus : 0)) * this.events().reduce((m, e) => m * (e.goldMul ?? 1), 1);
    const shardMul = this.events().reduce((m, e) => m * (e.shardMul ?? 1), 1);
    const reward: Reward = {};
    const summary: RunSummary = {
      won, mode: run.mode, levelId: run.levelId, stars: 0, firstClear: false, reward: { gold: 0, gems: 0, essence: 0, shards: {} },
      wave: state.wave, bestEndless: false, canDouble: false, runId: run.runId,
    };
    if (run.mode === 'campaign') {
      const lvl = LEVEL_BY_ID[run.levelId];
      if (won) {
        const stars = starsFor(state.castleHp / state.castleMax);
        const prev = p.campaign[lvl.id];
        const first = !prev;
        summary.stars = stars;
        summary.firstClear = first;
        reward.gold = Math.round(lvl.rewardGold * (first ? FIRST_CLEAR_GOLD_MUL : REPLAY_GOLD_MUL) * goldMul) + Math.floor(Math.min(state.coins, 2000) * 0.05);
        reward.randomShards = Math.round((3 + stars + (lvl.boss ? 4 : 0)) * shardMul);
        reward.gems = (first ? FIRST_CLEAR_GEMS : 0) + (stars === 3 && (prev?.stars ?? 0) < 3 ? THREE_STAR_GEMS : 0);
        reward.essence = lvl.boss ? (first ? BOSS_ESSENCE_FIRST : BOSS_ESSENCE_REPLAY) : first ? LEVEL_ESSENCE : 0;
        p.campaign[lvl.id] = { stars: Math.max(stars, prev?.stars ?? 0), clears: (prev?.clears ?? 0) + 1 };
        this.track('wins');
        if (stars === 3) this.track('threeStars');
        if (first) {
          if (lvl.unlocksTower && !p.cards[lvl.unlocksTower]) { p.cards[lvl.unlocksTower] = { level: 1, mastery: 0 }; summary.unlockedTower = lvl.unlocksTower; if (p.loadout.length < this.loadoutSize()) p.loadout.push(lvl.unlocksTower); }
          if (lvl.unlocksAbility) summary.unlockedAbility = lvl.unlocksAbility;
          const next = LEVELS[lvl.index + 1];
          if (next && next.world !== lvl.world) summary.unlockedWorld = next.world;
          if (lvl.id === ENDLESS.unlockLevel) summary.endlessUnlocked = true;
        }
        if (lvl.id === '1-1') p.tutorial.done = true;
        p.ads.winsSinceOffer++;
        summary.canDouble = true;
      } else {
        // Consolation: a little gold for the waves survived, nothing else.
        reward.gold = Math.round(lvl.rewardGold * 0.1 * Math.min(state.wave, lvl.waves) * goldMul);
      }
    } else {
      const waves = Math.max(0, Math.min(state.wave, 10000));
      const full = p.endless.runs < ENDLESS.fullRewardRunsPerDay;
      const factor = full ? 1 : ENDLESS.reducedRewardFactor;
      // Sub-linear in waves and throttled per day so endless never out-earns the campaign.
      reward.gold = Math.round((40 * Math.sqrt(waves) + 8 * waves) * factor * goldMul);
      reward.essence = Math.floor((waves / 5) * 2 * factor);
      reward.randomShards = Math.floor(Math.min(12, waves / 3) * factor);
      p.endless.runs++;
      this.track('endlessWaves', waves);
      if (waves > p.endless.best) { p.endless.best = waves; summary.bestEndless = true; }
      summary.canDouble = waves >= 3 && full;
    }
    this.recomputeBests();
    summary.reward = this.resolveReward(reward, grantId);
    this.grant(reward, grantId, true);
    this.pendingDouble = summary.canDouble ? { runId: run.runId, reward: { gold: summary.reward.gold, shards: summary.reward.shards } } : null;
    this.lastSummary = summary;
    this.activeRun = null;
    this.refreshPeriods();
    return { ok: true, summary };
  }
  private pendingDouble: { runId: string; reward: Reward } | null = null;
  /** Rewarded-ad bonus: grants the gold and shards of the last run a second time (once). */
  doubleLastRun(): Result<{ reward: Reward }> {
    const d = this.pendingDouble;
    if (!d) return fail('err.unavailable');
    this.pendingDouble = null;
    if (!this.grant(d.reward, `run2:${d.runId}`)) return fail('err.claimed');
    if (this.lastSummary) this.lastSummary.canDouble = false;
    return { ok: true, reward: d.reward };
  }
  canPayRevive(): boolean {
    return this.p.gems >= REVIVE_GEMS;
  }
  payRevive(): Result {
    if (!this.spend('gems', REVIVE_GEMS)) return fail('err.gems');
    this.changed(true);
    return { ok: true };
  }

  // ------------------------------------------------------------------ offline income
  goldPerHour(): number {
    return Math.round(offlineRate(this.clearedCount()) * (1 + IDLE_BONUS_PER_LEVEL * (this.p.research.idle ?? 0)) * (1 + (this.isPremium() ? PREMIUM_BENEFITS.goldBonus : 0)));
  }
  /**
   * Gold accumulated while away. Elapsed time is measured from `lastSeen` to the guarded clock,
   * capped at 8 hours. After a clock rollback `lastSeen` sits in the "future", so nothing accrues
   * until real time catches up – tampering gains nothing, honest players lose nothing.
   */
  pendingOffline(): { gold: number; seconds: number; capped: boolean } {
    const now = this.deps.now();
    const elapsed = Math.max(0, now - this.p.time.lastSeen);
    const cap = OFFLINE_CAP_HOURS * 3600000;
    const used = Math.min(elapsed, cap);
    return { gold: Math.floor((used / 3600000) * this.goldPerHour()), seconds: Math.floor(used / 1000), capped: elapsed >= cap };
  }
  claimOffline(): Result<{ gold: number; grantId: string }> {
    const pend = this.pendingOffline();
    const grantId = `offline:${this.p.time.lastSeen}`;
    this.p.time.lastSeen = Math.max(this.deps.now(), this.p.time.maxSeen);
    if (pend.gold <= 0) { this.changed(); return fail('err.nothing'); }
    this.grant({ gold: pend.gold }, grantId);
    this.lastOffline = { gold: pend.gold, grantId };
    return { ok: true, gold: pend.gold, grantId };
  }
  private lastOffline: { gold: number; grantId: string } | null = null;
  doubleOffline(): Result<{ gold: number }> {
    const l = this.lastOffline;
    if (!l) return fail('err.unavailable');
    this.lastOffline = null;
    if (!this.grant({ gold: l.gold }, `${l.grantId}:x2`)) return fail('err.claimed');
    return { ok: true, gold: l.gold };
  }
  /** Keeps the idle timer from counting time spent actively playing. */
  markSeen(): void {
    if (this.touchTime()) this.p.time.lastSeen = Math.max(this.p.time.lastSeen, this.deps.now());
  }

  // ------------------------------------------------------------------ ads
  adsLeft(placement: string): number {
    const def = AD_PLACEMENTS[placement];
    if (!def) return 0;
    return Math.max(0, def.daily - (this.p.ads.counts[placement] ?? 0));
  }
  /** Counts a completed ad view against the daily cap and applies the placement's own reward. */
  completeAd(placement: string, token: string): Result<{ reward?: ReturnType<Game['resolveReward']> }> {
    const def = AD_PLACEMENTS[placement];
    if (!def) return fail('err.unknown');
    if (this.adsLeft(placement) <= 0) return fail('err.ad_limit');
    this.p.ads.counts[placement] = (this.p.ads.counts[placement] ?? 0) + 1;
    const grantId = `ad:${placement}:${token}`;
    let reward: Reward | undefined = def.reward;
    if (def.goldHours) reward = { ...(reward ?? {}), gold: this.goldPerHour() * def.goldHours };
    if (placement === 'offer_chest') this.p.ads.winsSinceOffer = 0;
    if (!reward) { this.changed(); return { ok: true }; }
    const resolved = this.resolveReward(reward, grantId);
    if (!this.grant(reward, grantId)) return fail('err.claimed');
    return { ok: true, reward: resolved };
  }
  /** Should the optional chest offer be shown after this win? Never for Premium, never above the cap. */
  shouldOffer(): boolean {
    return !this.isPremium() && this.p.ads.winsSinceOffer >= OFFER_EVERY_WINS && this.adsLeft('offer_chest') > 0;
  }
  declineOffer(): void {
    this.p.ads.winsSinceOffer = 0;
    this.changed();
  }

  // ------------------------------------------------------------------ shop
  gemItemInfo(id: string) {
    const item = GEM_SHOP.find((i) => i.id === id)!;
    const bought = this.p.shop.counts[id] ?? 0;
    const owned = !!item.cosmetic && this.p.cosmetics.owned.includes(item.cosmetic);
    const left = item.dailyLimit ? Math.max(0, item.dailyLimit - bought) : Infinity;
    return { item, owned, left, gold: item.goldHours ? this.goldPerHour() * item.goldHours : 0, canBuy: !owned && left > 0 && this.p.gems >= item.cost };
  }
  buyGemItem(id: string, nonce: string): Result<{ reward: ReturnType<Game['resolveReward']> }> {
    if (!GEM_SHOP.some((i) => i.id === id)) return fail('err.unknown');
    const info = this.gemItemInfo(id);
    if (info.owned) return fail('err.owned');
    if (info.left <= 0) return fail('err.limit');
    if (!this.spend('gems', info.item.cost)) return fail('err.gems');
    this.p.shop.counts[id] = (this.p.shop.counts[id] ?? 0) + 1;
    const reward: Reward = { ...(info.item.reward ?? {}) };
    if (info.item.goldHours) reward.gold = info.gold;
    if (info.item.cosmetic) reward.cosmetic = info.item.cosmetic;
    const grantId = `gem:${id}:${nonce}`;
    const resolved = this.resolveReward(reward, grantId);
    this.grant(reward, grantId);
    return { ok: true, reward: resolved };
  }
  /**
   * Delivers a verified store purchase. `transactionId` is the store's unique id, which makes
   * re-delivery (restore, retry after crash, duplicated callbacks) grant nothing twice.
   */
  applyPurchase(productId: string, transactionId: string): Result<{ granted: boolean }> {
    const prod = IAP_PRODUCTS.find((x) => x.id === productId);
    if (!prod) return fail('err.unknown');
    if (!transactionId) return fail('err.tx');
    if (prod.type === 'nonconsumable') {
      if (this.p.owned.includes(productId)) return { ok: true, granted: false };
      this.p.owned.push(productId);
      const granted = this.grant(prod.reward, `iap:${productId}`);
      if (!granted) this.changed(true);
      return { ok: true, granted: true };
    }
    return { ok: true, granted: this.grant(prod.reward, `iap:${transactionId}`) };
  }
  equipCastle(id: string): Result {
    if (!this.p.cosmetics.owned.includes(id)) return fail('err.locked');
    this.p.cosmetics.castle = id;
    this.changed();
    return { ok: true };
  }
  markTutorial(key: string): void {
    if (this.p.tutorial.seen[key]) return;
    this.p.tutorial.seen[key] = true;
    this.changed();
  }
  elementOf(tower: string): DamageType {
    return TOWERS[tower].element;
  }
}
