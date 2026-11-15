import { BOOSTS, BOOST_BY_ID, BOOST_WEIGHTS, REROLL_COST } from '../data/boosts';
import { ENEMIES } from '../data/enemies';
import { REACTIONS, SELL_REFUND, TIER_MUL, TOWERS } from '../data/towers';
import { ABILITIES, LEVEL_BY_ID, MAPS } from '../data/worlds';
import { GameMap, PathLine, Pt, parseMap, pathPoint } from './map';
import { MergeCheck, MergeOption, checkMerge } from './merge';
import { Rng, hashStr } from './rng';
import { TowerComputed, computeTower, maxRank } from './stats';
import type { BoostDef, DamageType, EffectSpec, EnemyDef, LevelDef, Mods, RunContext, StatusKind } from './types';
import { MAX_ENEMIES_ALIVE, addMods, clampNum, emptyMods } from './types';
import { SpawnEntry, buildWave, endlessLevel } from './waves';

export const TICK = 1 / 30;
export const START_COINS = 150;
export const BASE_CASTLE_HP = 20;
export const PREP_TIME = 10;
export const BREATHER = 2.5;

export interface TowerState {
  id: number; def: string; slot: number; tier: number; rank: number; branch: string | null;
  cd: number; stun: number; targetId: number; ramp: number; spent: number; dealt: number;
}
export interface EnemyState {
  id: number; def: string; hp: number; maxHp: number; armor: number; path: number; fly: boolean; boss: boolean;
  dist: number; x: number; y: number; dead: boolean;
  burnT: number; burnDps: number; burnSrc: number; poisonT: number; poisonDps: number; poisonStacks: number; poisonSrc: number;
  chillT: number; chillPct: number; freezeT: number; freezeImm: number; markT: number; markPct: number;
  shredT: number; shredPct: number; shieldT: number; shieldReduce: number;
  ab: number[]; enraged: boolean; haste: number; spread: number; blast: number; blastSrc: number;
}
export interface ProjState {
  id: number; tower: number; x: number; y: number; target: number; lx: number; ly: number; speed: number;
  dmg: number; el: DamageType; crit: boolean; splash: number; siege: boolean; effects: EffectSpec[];
  spread: number; blast: number; execute: number; vsUndead: number; ground: boolean; look: string;
}
export type Phase = 'prep' | 'wave' | 'boost' | 'won' | 'lost';
export interface BattleStats {
  kills: number; bosses: number; leaks: number; merges: number; hybrids: number; upgrades: number; placed: number;
  abilities: number; boosts: number; reactions: number; coinsEarned: number; dmgByDef: Record<string, number>; maxTier: number;
}
export interface BattleState {
  ctx: RunContext; time: number; phase: Phase; wave: number; phaseT: number; waveT: number;
  coins: number; castleHp: number; castleMax: number;
  queue: SpawnEntry[]; qi: number;
  enemies: EnemyState[]; towers: TowerState[]; projs: ProjState[];
  boosts: Record<string, number>; offer: string[] | null; rerolled: number; freeTowers: number;
  abilities: { id: string; cd: number }[]; overT: number;
  bought: Record<string, number>; shots: number; nextId: number; revived: boolean;
  rngW: number; rngM: number; stats: BattleStats; endlessMap?: { map: string; mirror: boolean; worlds: number };
}
export interface BattleEvent { t: string; [k: string]: any }
export type ActionResult = { ok: true } | { ok: false; reason: string };
const OK: ActionResult = { ok: true };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

interface HitSrc {
  tower: number; direct: boolean; siege?: boolean; crit?: boolean; effects?: EffectSpec[];
  execute?: number; vsUndead?: number; spread?: number; blast?: number; noReact?: boolean;
}

const tmp: Pt = { x: 0, y: 0 };

/**
 * Deterministic, renderer-agnostic battle simulation.
 * All mutations go through validated action methods; `state` is plain data and can be
 * serialised at any moment (suspend/resume) and restored with `new Battle(ctx, state)`.
 */
export class Battle {
  s: BattleState;
  map: GameMap;
  mods: Mods = emptyMods();
  level: LevelDef;
  events: BattleEvent[] = [];
  /** Renderer/audio set this to true; headless simulations keep it off. */
  collect = false;
  private rngW: Rng;
  private rngM: Rng;
  private cache = new Map<number, TowerComputed>();
  private buffRate = new Map<number, number>();
  private buffDmg = new Map<number, number>();
  private auraDirty = true;
  private pending: { def: string; path: number; dist: number; hpMul: number; fly: boolean }[] = [];
  private anyDead = false;
  private acc = 0;
  private chainBonus = 0;

  constructor(ctx: RunContext, saved?: BattleState) {
    if (saved) {
      this.s = saved;
    } else {
      const seed = ctx.seed >>> 0;
      this.s = {
        ctx, time: 0, phase: 'prep', wave: 0, phaseT: ctx.tutorial ? Infinity : PREP_TIME, waveT: 0,
        coins: 0, castleHp: 0, castleMax: 0, queue: [], qi: 0, enemies: [], towers: [], projs: [],
        boosts: {}, offer: null, rerolled: 0, freeTowers: 0,
        abilities: ctx.abilities.filter((a) => ABILITIES[a]).map((id) => ({ id, cd: 0 })), overT: 0,
        bought: {}, shots: 0, nextId: 1, revived: false,
        rngW: hashStr(`w${seed}:${ctx.levelId}`), rngM: hashStr(`m${seed}`),
        stats: { kills: 0, bosses: 0, leaks: 0, merges: 0, hybrids: 0, upgrades: 0, placed: 0, abilities: 0, boosts: 0, reactions: 0, coinsEarned: 0, dmgByDef: {}, maxTier: 1 },
      };
    }
    const s = this.s;
    this.rngW = new Rng(s.rngW);
    this.rngM = new Rng(s.rngM);
    if (s.ctx.mode === 'endless') {
      if (!s.endlessMap) {
        const ids = Object.keys(MAPS);
        const r = new Rng(hashStr(`e${s.ctx.seed}`));
        s.endlessMap = { map: r.pick(ids), mirror: r.chance(0.5), worlds: Math.max(1, Math.round(s.ctx.baseMods.__worlds ?? 1)) };
      }
      this.level = endlessLevel(s.wave, s.endlessMap.worlds, s.endlessMap.map, s.endlessMap.mirror);
    } else {
      const lvl = LEVEL_BY_ID[s.ctx.levelId];
      if (!lvl) throw new Error(`Unknown level ${s.ctx.levelId}`);
      this.level = lvl;
    }
    this.map = parseMap(MAPS[this.level.map], this.level.mirror);
    this.recomputeMods();
    if (!saved) {
      s.coins = Math.round(START_COINS + this.mods.startCoins);
      s.castleHp = s.castleMax;
      // The run opens with a "blessing": the first roguelike pick happens before wave 1.
      if (!s.ctx.tutorial) this.openBoostOffer();
    }
  }

  // ------------------------------------------------------------------ persistence
  serialize(): BattleState {
    this.s.rngW = this.rngW.state;
    this.s.rngM = this.rngM.state;
    return JSON.parse(JSON.stringify(this.s, (_k, v) => (v === Infinity ? '__inf' : v)), (_k, v) => (v === '__inf' ? Infinity : v));
  }

  // ------------------------------------------------------------------ modifiers
  private recomputeMods(): void {
    const m = emptyMods();
    const base: Record<string, number> = {};
    for (const k of Object.keys(this.s.ctx.baseMods)) if (!k.startsWith('__')) base[k] = this.s.ctx.baseMods[k];
    addMods(m, base);
    for (const id of Object.keys(this.s.boosts)) {
      const def = BOOST_BY_ID[id];
      if (def) addMods(m, def.mods, this.s.boosts[id]);
    }
    this.mods = m;
    const max = Math.max(1, Math.round((BASE_CASTLE_HP + m.castleHp) * Math.max(0.1, 1 + m.castleHpMul)));
    this.s.castleMax = max;
    if (this.s.castleHp > max) this.s.castleHp = max;
    this.cache.clear();
    this.auraDirty = true;
  }

  // ------------------------------------------------------------------ queries
  towerStats(t: TowerState): TowerComputed {
    let c = this.cache.get(t.id);
    if (!c) {
      c = computeTower(t.def, t.tier, t.rank, t.branch, this.s.ctx.cardMul[t.def] ?? 1, this.mods);
      this.cache.set(t.id, c);
    }
    return c;
  }
  /** Stats a hypothetical tower would have in this run (merge previews). */
  previewStats(def: string, tier: number, rank: number, branch: string | null): TowerComputed {
    const src = TOWERS[def].hybrid ? 1 : this.s.ctx.cardMul[def] ?? 1;
    return computeTower(def, tier, rank, branch, src, this.mods);
  }
  towerAt(slot: number): TowerState | undefined {
    return this.s.towers.find((t) => t.slot === slot);
  }
  tower(id: number): TowerState | undefined {
    return this.s.towers.find((t) => t.id === id);
  }
  slotPos(slot: number): Pt {
    return this.map.slots[slot];
  }
  buyCost(def: string): number {
    const d = TOWERS[def];
    if (this.s.freeTowers > 0) return 0;
    const n = this.s.bought[def] ?? 0;
    return Math.max(1, Math.round(d.cost * Math.max(0.3, 1 + this.mods.towerCost) * Math.pow(1.12, n)));
  }
  upgradeCost(t: TowerState): number {
    const base = TOWERS[t.def].cost || 80;
    return Math.round(clampNum(base * 0.5 * Math.pow(TIER_MUL[t.tier], 0.8) * Math.pow(1.45, Math.min(t.rank, 60)) * Math.max(0.3, 1 + this.mods.upgradeCost), 1, 1e12));
  }
  canUpgrade(t: TowerState): boolean {
    return t.rank < maxRank(t.tier);
  }
  sellValue(t: TowerState): number {
    return Math.floor(t.spent * SELL_REFUND);
  }
  totalWaves(): number {
    return this.level.waves;
  }
  /** 0..1 progress of the current wave (spawned + killed share). */
  waveProgress(): number {
    const s = this.s;
    if (s.phase !== 'wave' || !s.queue.length) return s.phase === 'wave' ? 1 : 0;
    const alive = s.enemies.length;
    return Math.max(0, Math.min(1, (s.qi - alive * 0.5) / s.queue.length));
  }
  private pathOf(e: EnemyState): PathLine {
    return e.fly ? this.map.flyPaths[e.path] : this.map.paths[e.path];
  }
  private hasStatus(e: EnemyState, st: StatusKind): boolean {
    switch (st) {
      case 'burn': return e.burnT > 0;
      case 'poison': return e.poisonT > 0;
      case 'chill': return e.chillT > 0;
      case 'freeze': return e.freezeT > 0;
      case 'mark': return e.markT > 0;
    }
  }
  private emit(ev: BattleEvent): void {
    if (this.collect) this.events.push(ev);
  }

  // ------------------------------------------------------------------ player actions
  buyTower(def: string, slot: number): ActionResult {
    const s = this.s;
    if (s.phase === 'won' || s.phase === 'lost') return fail('act.err.over');
    const d = TOWERS[def];
    if (!d || d.hybrid || !s.ctx.loadout.includes(def)) return fail('act.err.tower');
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.map.slots.length) return fail('act.err.slot');
    if (this.towerAt(slot)) return fail('act.err.occupied');
    const cost = this.buyCost(def);
    if (s.coins < cost) return fail('act.err.coins');
    s.coins -= cost;
    if (s.freeTowers > 0) s.freeTowers--;
    else s.bought[def] = (s.bought[def] ?? 0) + 1;
    const t: TowerState = { id: s.nextId++, def, slot, tier: 1, rank: 0, branch: null, cd: 0.3, stun: 0, targetId: 0, ramp: 0, spent: Math.max(cost, Math.round(d.cost * 0.5)), dealt: 0 };
    s.towers.push(t);
    s.stats.placed++;
    this.auraDirty = true;
    this.emit({ t: 'place', tower: t.id, slot });
    return OK;
  }

  moveTower(id: number, slot: number): ActionResult {
    const t = this.tower(id);
    if (!t) return fail('act.err.tower');
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.map.slots.length) return fail('act.err.slot');
    if (this.towerAt(slot)) return fail('act.err.occupied');
    t.slot = slot;
    t.cd = Math.max(t.cd, 0.5);
    t.targetId = 0;
    t.ramp = 0;
    this.auraDirty = true;
    this.emit({ t: 'place', tower: t.id, slot });
    return OK;
  }

  upgradeTower(id: number): ActionResult {
    const s = this.s, t = this.tower(id);
    if (!t) return fail('act.err.tower');
    if (!this.canUpgrade(t)) return fail('act.err.maxrank');
    const cost = this.upgradeCost(t);
    if (s.coins < cost) return fail('act.err.coins');
    s.coins -= cost;
    t.rank++;
    t.spent += cost;
    s.stats.upgrades++;
    this.cache.delete(t.id);
    this.emit({ t: 'upgrade', tower: t.id });
    return OK;
  }

  sellTower(id: number): ActionResult {
    const s = this.s, t = this.tower(id);
    if (!t) return fail('act.err.tower');
    s.coins = clampNum(s.coins + this.sellValue(t));
    s.towers = s.towers.filter((x) => x !== t);
    this.cache.delete(t.id);
    this.auraDirty = true;
    this.emit({ t: 'sell', tower: t.id, slot: t.slot });
    return OK;
  }

  /** Compatibility check + all possible results; never mutates. */
  mergeCheck(aId: number, bId: number): MergeCheck {
    const a = this.tower(aId), b = this.tower(bId);
    if (!a || !b || a === b) return { ok: false, reason: 'merge.err.unknown' };
    const feeMul = Math.max(0, 1 + this.mods.mergeFee);
    const res = checkMerge(a, b, this.s.ctx.alchemy, feeMul);
    if (!res.ok) return res;
    // The result always takes the target's slot, so "free placement" reduces to the slot being valid.
    if (b.slot < 0 || b.slot >= this.map.slots.length) return { ok: false, reason: 'act.err.slot' };
    return res;
  }

  /**
   * Atomic merge of tower `aId` into tower `bId` (the result stands on b's slot).
   * Everything is validated before the first mutation, so a failure leaves both towers untouched.
   */
  merge(aId: number, bId: number, optionIndex: number): ActionResult {
    const s = this.s;
    if (s.phase === 'won' || s.phase === 'lost') return fail('act.err.over');
    const check = this.mergeCheck(aId, bId);
    if (!check.ok) return fail(check.reason);
    const opt: MergeOption | undefined = check.options[optionIndex];
    if (!opt) return fail('merge.err.option');
    if (s.coins < opt.fee) return fail('act.err.coins');
    const a = this.tower(aId)!, b = this.tower(bId)!;
    const result: TowerState = {
      id: s.nextId, def: opt.def, slot: b.slot, tier: opt.tier, rank: opt.rank, branch: opt.branch,
      cd: 0.4, stun: 0, targetId: 0, ramp: 0, spent: a.spent + b.spent + opt.fee, dealt: a.dealt + b.dealt,
    };
    // ---- commit ----
    s.nextId++;
    s.coins = clampNum(s.coins - opt.fee + this.mods.mergeCoins);
    s.towers = s.towers.filter((x) => x !== a && x !== b);
    s.towers.push(result);
    s.stats.merges++;
    if (opt.kind === 'hybrid') s.stats.hybrids++;
    s.stats.maxTier = Math.max(s.stats.maxTier, opt.tier);
    this.cache.delete(a.id);
    this.cache.delete(b.id);
    this.auraDirty = true;
    this.emit({ t: 'merge', tower: result.id, slot: result.slot, from: a.slot, hybrid: opt.kind === 'hybrid', tier: opt.tier });
    return OK;
  }

  startWave(): ActionResult {
    if (this.s.phase !== 'prep') return fail('act.err.phase');
    this.beginWave();
    return OK;
  }

  useAbility(id: string, x = 0, y = 0): ActionResult {
    const s = this.s;
    const st = s.abilities.find((a) => a.id === id), def = ABILITIES[id];
    if (!st || !def) return fail('act.err.ability');
    if (s.phase !== 'wave' && s.phase !== 'prep') return fail('act.err.phase');
    if (st.cd > 0) return fail('act.err.cooldown');
    const power = 1 + this.mods.abilityPower;
    if (id === 'meteor') {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('act.err.target');
      const dmg = def.power * this.level.hpMul * power;
      this.emit({ t: 'ability', id, x, y, r: def.radius });
      this.areaDamage(x, y, def.radius!, dmg, 'fire', { tower: 0, direct: true, effects: [{ type: 'burn', dpsPct: 0.3, dur: 3 }] }, false);
    } else if (id === 'freeze') {
      for (const e of s.enemies) if (!e.dead) { e.freezeT = Math.max(e.freezeT, def.dur! * power * (e.boss ? 0.4 : 1)); e.freezeImm = 0; }
      this.emit({ t: 'ability', id });
    } else if (id === 'overcharge') {
      s.overT = def.dur! * power;
      this.emit({ t: 'ability', id });
    } else if (id === 'heal') {
      if (s.castleHp >= s.castleMax) return fail('act.err.fullhp');
      s.castleHp = Math.min(s.castleMax, s.castleHp + Math.ceil(s.castleMax * def.power * power));
      this.emit({ t: 'ability', id });
    }
    st.cd = def.cooldown * Math.max(0.4, 1 - this.mods.abilityCd);
    s.stats.abilities++;
    if (this.anyDead) { s.enemies = s.enemies.filter((e) => !e.dead); this.anyDead = false; }
    return OK;
  }

  chooseBoost(index: number): ActionResult {
    const s = this.s;
    if (s.phase !== 'boost' || !s.offer) return fail('act.err.phase');
    const id = s.offer[index];
    const def = BOOST_BY_ID[id];
    if (!def) return fail('act.err.boost');
    s.boosts[id] = (s.boosts[id] ?? 0) + 1;
    s.stats.boosts++;
    this.recomputeMods();
    if (def.instant?.coins) this.addCoins(def.instant.coins, false);
    if (def.instant?.heal) s.castleHp = Math.min(s.castleMax, s.castleHp + def.instant.heal);
    if (def.instant?.freeTower) s.freeTowers++;
    s.offer = null;
    s.phase = 'prep';
    s.phaseT = s.wave === 0 && s.time === 0 ? (s.ctx.tutorial ? Infinity : PREP_TIME) : BREATHER;
    this.emit({ t: 'boost', id });
    return OK;
  }

  rerollCost(): number {
    const free = Math.round(this.mods.rerolls);
    return this.s.rerolled < free ? 0 : REROLL_COST + 20 * (this.s.rerolled - free);
  }
  /** `free` = paid for by a rewarded ad instead of coins. */
  rerollBoosts(free = false): ActionResult {
    const s = this.s;
    if (s.phase !== 'boost') return fail('act.err.phase');
    if (!free) {
      const cost = this.rerollCost();
      if (s.coins < cost) return fail('act.err.coins');
      s.coins -= cost;
      s.rerolled++;
    }
    s.offer = this.rollBoosts(s.offer ?? []);
    return OK;
  }

  /** Second chance after a defeat (granted by a rewarded ad or gems – never by real money directly). */
  revive(): ActionResult {
    const s = this.s;
    if (s.phase !== 'lost') return fail('act.err.phase');
    if (s.revived) return fail('act.err.revived');
    s.revived = true;
    s.castleHp = Math.ceil(s.castleMax * 0.5);
    for (const e of s.enemies) if (!e.boss) e.dead = true;
    for (const e of s.enemies) if (e.boss) e.dist = Math.max(0, e.dist - 4);
    s.enemies = s.enemies.filter((e) => !e.dead);
    s.projs = [];
    s.phase = 'wave';
    this.emit({ t: 'revive' });
    return OK;
  }

  // ------------------------------------------------------------------ boosts
  private boostApplicable(b: BoostDef): boolean {
    const s = this.s;
    if ((s.boosts[b.id] ?? 0) >= b.max) return false;
    const n = b.needs;
    if (n) {
      const owned = s.towers.map((t) => TOWERS[t.def]);
      const avail = owned.concat(s.ctx.loadout.map((id) => TOWERS[id]));
      if (n.element && !avail.some((d) => d.element === n.element || d.element2 === n.element)) return false;
      if (n.tower && !avail.some((d) => d.id === n.tower)) return false;
      if (n.attack && !avail.some((d) => d.attack.kind === n.attack)) return false;
      if (n.hybrid && !(owned.some((d) => d.hybrid) || (s.ctx.alchemy > 0 && s.ctx.loadout.length > 1))) return false;
      if (n.ability && !s.abilities.length) return false;
      if (n.reaction) {
        // Reactions need at least one status-applying element and a matching damage source.
        const els = new Set<string>();
        for (const d of avail) { els.add(d.element); if (d.element2) els.add(d.element2); }
        const statusBy: Record<string, string> = { burn: 'fire', poison: 'poison', chill: 'ice', freeze: 'ice', mark: 'arcane' };
        if (!REACTIONS.some((r) => els.has(r.damage) && els.has(statusBy[r.status]))) return false;
      }
    }
    if (b.id === 'masonry' && false) return false;
    if (b.id === 'mergemaster' && this.map.slots.length < 2) return false;
    return true;
  }

  /** Is the boost directly useful for something already standing on the field? */
  private boostHitsField(b: BoostDef): boolean {
    const n = b.needs;
    if (!n) return true;
    const owned = this.s.towers.map((t) => TOWERS[t.def]);
    if (n.element) return owned.some((d) => d.element === n.element || d.element2 === n.element);
    if (n.tower) return owned.some((d) => d.id === n.tower);
    if (n.attack) return owned.some((d) => d.attack.kind === n.attack);
    if (n.hybrid) return owned.some((d) => d.hybrid);
    return true;
  }

  private rollBoosts(exclude: string[] = []): string[] {
    const s = this.s;
    let pool = BOOSTS.filter((b) => this.boostApplicable(b));
    const fresh = pool.filter((b) => !exclude.includes(b.id));
    if (fresh.length >= 3) pool = fresh;
    // Later waves shift the odds towards rarer boosts.
    const tilt = Math.min(1, s.wave * 0.12);
    const weight = (b: BoostDef) => BOOST_WEIGHTS[b.rarity] * (b.rarity === 'common' ? 1 - tilt * 0.5 : 1 + tilt);
    const picks: string[] = [];
    const rest = pool.slice();
    while (picks.length < 3 && rest.length) {
      const i = this.rngM.weighted(rest.map(weight));
      if (i < 0) break;
      picks.push(rest[i].id);
      rest.splice(i, 1);
    }
    // Guarantee: at least one option works for the current board (or is universally useful).
    if (picks.length && !picks.some((id) => this.boostHitsField(BOOST_BY_ID[id]))) {
      const useful = pool.filter((b) => this.boostHitsField(b) && !picks.includes(b.id));
      if (useful.length) picks[picks.length - 1] = useful[this.rngM.weighted(useful.map(weight))].id;
    }
    return picks;
  }

  private openBoostOffer(): void {
    const offer = this.rollBoosts();
    if (!offer.length) return;
    this.s.offer = offer;
    this.s.phase = 'boost';
    this.emit({ t: 'offer' });
  }

  // ------------------------------------------------------------------ waves
  private beginWave(): void {
    const s = this.s;
    if (s.ctx.mode === 'endless') {
      this.level = endlessLevel(s.wave, s.endlessMap!.worlds, s.endlessMap!.map, s.endlessMap!.mirror);
      s.queue = buildWave(this.level, 0, this.rngW, this.map.paths.length);
    } else {
      s.queue = buildWave(this.level, s.wave, this.rngW, this.map.paths.length);
    }
    s.qi = 0;
    s.waveT = 0;
    s.phase = 'wave';
    this.emit({ t: 'wave', n: s.wave, boss: s.queue.some((q) => ENEMIES[q.e].tags.includes('boss')) });
  }

  /**
   * Health scales with the level multiplier; flat armor only with its square root, because the
   * player's damage PER HIT grows far slower than total damage (which also grows through tower count).
   */
  private spawnEnemy(defId: string, path: number, dist: number, hpMul: number, flyOverride?: boolean): EnemyState | null {
    const s = this.s, def = ENEMIES[defId];
    if (!def || s.enemies.length >= MAX_ENEMIES_ALIVE) return null;
    const boss = def.tags.includes('boss');
    const hp = clampNum(Math.round(def.hp * hpMul * (1 + this.mods.enemyHp)), 1);
    const e: EnemyState = {
      id: s.nextId++, def: defId, hp, maxHp: hp, armor: def.armor * Math.sqrt(hpMul), path, fly: flyOverride ?? def.tags.includes('flying'), boss,
      dist, x: 0, y: 0, dead: false,
      burnT: 0, burnDps: 0, burnSrc: 0, poisonT: 0, poisonDps: 0, poisonStacks: 0, poisonSrc: 0,
      chillT: 0, chillPct: 0, freezeT: 0, freezeImm: 0, markT: 0, markPct: 0, shredT: 0, shredPct: 0, shieldT: 0, shieldReduce: 0,
      ab: (def.abilities ?? []).map((a) => ('every' in a ? a.every * 0.6 : 0)), enraged: false, haste: 0, spread: 0, blast: 0, blastSrc: 0,
    };
    pathPoint(this.pathOf(e), e.dist, tmp);
    e.x = tmp.x; e.y = tmp.y;
    s.enemies.push(e);
    this.emit({ t: 'spawn', id: e.id, def: defId, boss });
    return e;
  }

  private addCoins(n: number, scaled = true): void {
    const v = Math.round(n * (scaled ? Math.max(0, 1 + this.mods.coinGain) : 1));
    this.s.coins = clampNum(this.s.coins + v);
    this.s.stats.coinsEarned = clampNum(this.s.stats.coinsEarned + v);
  }

  private waveCleared(): void {
    const s = this.s;
    const bonus = 25 + 10 * Math.min(s.wave, 20);
    this.addCoins(bonus);
    if (this.mods.interest > 0) this.addCoins(Math.min(100, Math.floor(s.coins * this.mods.interest)), false);
    if (this.mods.waveHeal > 0) s.castleHp = Math.min(s.castleMax, s.castleHp + Math.round(this.mods.waveHeal));
    this.emit({ t: 'waveClear', n: s.wave, bonus });
    s.projs = [];
    s.wave++;
    if (s.ctx.mode === 'campaign' && s.wave >= this.level.waves) {
      s.phase = 'won';
      this.emit({ t: 'win' });
      return;
    }
    s.phase = 'prep';
    s.phaseT = BREATHER;
    this.openBoostOffer();
  }

  // ------------------------------------------------------------------ damage
  private applyEffects(e: EnemyState, effects: EffectSpec[], hitDmg: number, src: HitSrc): void {
    const m = this.mods;
    for (const f of effects) {
      switch (f.type) {
        case 'burn': {
          const dps = hitDmg * (f.dpsPct ?? 0) * (1 + m.burnDmg);
          if (dps >= e.burnDps || e.burnT <= 0) { e.burnDps = dps; e.burnSrc = src.tower; }
          e.burnT = Math.max(e.burnT, f.dur * (1 + m.burnDur));
          break;
        }
        case 'poison': {
          const max = (f.maxStacks ?? 1) + Math.round(m.poisonStacks);
          e.poisonStacks = Math.min(max, e.poisonStacks + 1);
          e.poisonDps = Math.max(e.poisonT > 0 ? e.poisonDps : 0, hitDmg * (f.dpsPct ?? 0) * (1 + m.poisonDmg));
          e.poisonT = f.dur;
          e.poisonSrc = src.tower;
          break;
        }
        case 'chill': {
          const pct = Math.min(0.7, ((f.pct ?? 0) + m.chillPct) * (e.boss ? 0.5 : 1));
          if (pct >= e.chillPct || e.chillT <= 0) e.chillPct = pct;
          e.chillT = Math.max(e.chillT, f.dur * (1 + m.chillDur));
          break;
        }
        case 'freeze': {
          if (e.freezeImm > 0 || e.freezeT > 0) break;
          if (this.rngM.chance((f.chance ?? 1) + m.freezeChance)) e.freezeT = f.dur * (e.boss ? 0.4 : 1);
          break;
        }
        case 'mark': {
          e.markPct = Math.max(e.markT > 0 ? e.markPct : 0, (f.pct ?? 0) + m.markPct);
          e.markT = f.dur;
          break;
        }
        case 'shred': {
          e.shredPct = Math.max(e.shredT > 0 ? e.shredPct : 0, f.pct ?? 0);
          e.shredT = f.dur;
          break;
        }
      }
    }
    if (src.spread) e.spread = Math.max(e.spread, src.spread);
    if (src.blast) { e.blast = Math.max(e.blast, src.blast); e.blastSrc = src.tower; }
  }

  private hit(e: EnemyState, dmg: number, el: DamageType, src: HitSrc): number {
    if (e.dead) return 0;
    const def = ENEMIES[e.def], m = this.mods, s = this.s;
    let d = dmg * (def.resist[el] ?? 1);
    if (src.vsUndead && def.tags.includes('undead')) d *= src.vsUndead;
    if (e.markT > 0) d *= 1 + e.markPct;
    if (e.boss) d *= 1 + m.bossDmg;
    if (m.slowedDmg && (e.chillT > 0 || e.freezeT > 0)) d *= 1 + m.slowedDmg;
    if (src.direct && !src.noReact) {
      for (const r of REACTIONS) {
        if (r.damage !== el || !this.hasStatus(e, r.status)) continue;
        d *= 1 + (r.mul - 1) * (1 + m.reaction);
        s.stats.reactions++;
        if (r.extra === 'chain') this.chainBonus = 1;
        if (r.extra === 'blast') this.areaDamage(e.x, e.y, 1, dmg * 0.35, 'lightning', { tower: src.tower, direct: false, noReact: true }, false, e.id);
        this.emit({ t: 'reaction', id: r.id, x: e.x, y: e.y });
        break; // one reaction per hit (the table is ordered by priority)
      }
    }
    if (src.direct && e.armor > 0) {
      let armor = e.armor * (e.shredT > 0 ? 1 - e.shredPct : 1);
      if (src.siege) armor *= 0.5;
      d = Math.max(d * 0.25, d - armor);
    }
    if (e.shieldT > 0) d *= 1 - e.shieldReduce;
    d = clampNum(d);
    e.hp -= d;
    if (src.tower) {
      const t = this.tower(src.tower);
      if (t) { t.dealt = clampNum(t.dealt + d); s.stats.dmgByDef[t.def] = clampNum((s.stats.dmgByDef[t.def] ?? 0) + d); }
    }
    if (src.effects && e.hp > 0) this.applyEffects(e, src.effects, dmg, src);
    else if (e.hp <= 0) { if (src.spread) e.spread = Math.max(e.spread, src.spread); if (src.blast) { e.blast = Math.max(e.blast, src.blast); e.blastSrc = src.tower; } }
    const exec = Math.max(src.execute ?? 0, src.direct ? m.executeAll : 0);
    if (exec > 0 && !e.boss && e.hp > 0 && e.hp / e.maxHp < exec) e.hp = 0;
    if (src.direct) this.emit({ t: 'hit', x: e.x, y: e.y, el, dmg: d, crit: !!src.crit, fly: e.fly });
    if (e.hp <= 0) this.kill(e);
    return d;
  }

  private areaDamage(x: number, y: number, r: number, dmg: number, el: DamageType, src: HitSrc, groundOnly: boolean, exclude = 0): void {
    const r2 = r * r;
    // Snapshot: kills may trigger chain reactions that mutate nothing in this array, but be defensive.
    const list = this.s.enemies;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead || e.id === exclude || (groundOnly && e.fly)) continue;
      const dx = e.x - x, dy = e.y - y;
      if (dx * dx + dy * dy <= r2) this.hit(e, dmg, el, src);
    }
  }

  private kill(e: EnemyState): void {
    if (e.dead) return;
    const s = this.s, def = ENEMIES[e.def];
    e.dead = true;
    e.hp = 0;
    this.anyDead = true;
    s.stats.kills++;
    if (e.boss) s.stats.bosses++;
    const coins = def.bounty + this.mods.bountyFlat;
    this.addCoins(coins);
    this.emit({ t: 'kill', id: e.id, def: e.def, x: e.x, y: e.y, boss: e.boss, coins });
    for (const a of def.abilities ?? []) {
      if (a.type === 'split') for (let i = 0; i < a.count; i++) this.pending.push({ def: a.into, path: e.path, dist: Math.max(0, e.dist - i * 0.25), hpMul: e.maxHp / (def.hp * (1 + this.mods.enemyHp)), fly: e.fly });
    }
    if (e.spread > 0 && (e.burnT > 0 || e.poisonT > 0)) {
      const r2 = e.spread * e.spread;
      for (const o of s.enemies) {
        if (o.dead || o === e) continue;
        const dx = o.x - e.x, dy = o.y - e.y;
        if (dx * dx + dy * dy > r2) continue;
        if (e.burnT > 0 && e.burnDps > o.burnDps) { o.burnDps = e.burnDps; o.burnT = Math.max(o.burnT, 3); o.burnSrc = e.burnSrc; o.spread = e.spread; }
        if (e.poisonT > 0) { o.poisonStacks = Math.max(o.poisonStacks, Math.max(1, e.poisonStacks - 1)); o.poisonDps = Math.max(o.poisonDps, e.poisonDps); o.poisonT = Math.max(o.poisonT, 4); o.poisonSrc = e.poisonSrc; o.spread = e.spread; }
      }
      this.emit({ t: 'spread', x: e.x, y: e.y, r: e.spread });
    }
    if (e.blast > 0) {
      const dmg = e.blast;
      e.blast = 0;
      this.emit({ t: 'blast', x: e.x, y: e.y });
      this.areaDamage(e.x, e.y, 1.1, dmg, 'fire', { tower: e.blastSrc, direct: false, noReact: true }, false, e.id);
    }
  }

  // ------------------------------------------------------------------ simulation
  /** Advances the simulation by real seconds (already multiplied by game speed) in fixed ticks. */
  advance(dt: number): void {
    this.acc += Math.min(dt, 0.5);
    let guard = 0;
    while (this.acc >= TICK && guard++ < 30) {
      this.acc -= TICK;
      this.step();
    }
  }

  step(): void {
    const s = this.s, dt = TICK;
    if (s.phase === 'boost' || s.phase === 'won' || s.phase === 'lost') return;
    s.time += dt;
    for (const a of s.abilities) if (a.cd > 0) a.cd = Math.max(0, a.cd - dt);
    if (s.overT > 0) s.overT = Math.max(0, s.overT - dt);

    if (s.phase === 'prep') {
      s.phaseT -= dt;
      if (s.phaseT <= 0) this.beginWave();
    } else if (s.phase === 'wave') {
      s.waveT += dt;
      while (s.qi < s.queue.length && s.queue[s.qi].t <= s.waveT) {
        if (s.enemies.length >= MAX_ENEMIES_ALIVE) {
          // Hold the spawn clock instead of exceeding the on-screen enemy limit.
          s.waveT = s.queue[s.qi].t;
          break;
        }
        const q = s.queue[s.qi++];
        this.spawnEnemy(q.e, q.path, 0, q.hpMul);
      }
    }

    this.updateEnemies(dt);
    if ((s.phase as Phase) === 'lost') return;
    this.updateTowers(dt);
    this.updateProjectiles(dt);

    if (this.anyDead) {
      s.enemies = s.enemies.filter((e) => !e.dead);
      this.anyDead = false;
    }
    if (this.pending.length) {
      for (const p of this.pending) {
        const e = this.spawnEnemy(p.def, p.path, p.dist, p.hpMul, ENEMIES[p.def]?.tags.includes('flying') ? true : false);
        if (e && p.fly && !e.fly) { /* children of flyers walk from the nearest road point */ }
      }
      this.pending.length = 0;
    }
    if (s.phase === 'wave' && s.qi >= s.queue.length && s.enemies.length === 0) this.waveCleared();
  }

  /**
   * Castle damage of an enemy that got through. It grows with the world so a well-upgraded
   * castle can never simply out-last a level without fighting; a boss that gets through takes most of the castle.
   */
  leakDamage(def: EnemyDef, boss: boolean): number {
    if (boss) return Math.ceil(this.s.castleMax * 0.6);
    const mul = this.s.ctx.mode === 'endless' ? Math.min(2.5, 1 + 0.05 * this.s.wave) : 1 + 0.25 * (this.level.world - 1);
    return Math.max(1, Math.round(def.leak * mul));
  }

  private updateEnemies(dt: number): void {
    const s = this.s, m = this.mods, list = s.enemies;
    // Auras first (n <= 20, so the quadratic pass is negligible).
    for (const e of list) e.haste = 0;
    for (const src of list) {
      if (src.dead) continue;
      const abil = ENEMIES[src.def].abilities;
      if (!abil) continue;
      for (const a of abil) {
        if (a.type !== 'haste_aura' && a.type !== 'heal_aura') continue;
        const r2 = a.radius * a.radius;
        for (const o of list) {
          if (o.dead || o === src) continue;
          const dx = o.x - src.x, dy = o.y - src.y;
          if (dx * dx + dy * dy > r2) continue;
          if (a.type === 'haste_aura') o.haste = Math.max(o.haste, a.pct);
          else if (!o.boss && o.hp < o.maxHp) o.hp = Math.min(o.maxHp, o.hp + o.maxHp * a.pctPerSec * dt);
        }
      }
    }
    const castle = this.map.castle;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead) continue;
      const def: EnemyDef = ENEMIES[e.def];
      // ---- status timers and damage over time ----
      if (e.burnT > 0) { e.burnT -= dt; this.hit(e, e.burnDps * dt, 'fire', { tower: e.burnSrc, direct: false }); if (e.burnT <= 0) e.burnDps = 0; }
      if (e.dead) continue;
      if (e.poisonT > 0) { e.poisonT -= dt; this.hit(e, e.poisonDps * e.poisonStacks * dt, 'poison', { tower: e.poisonSrc, direct: false }); if (e.poisonT <= 0) { e.poisonStacks = 0; e.poisonDps = 0; } }
      if (e.dead) continue;
      if (e.chillT > 0) { e.chillT -= dt; if (e.chillT <= 0) e.chillPct = 0; }
      if (e.freezeT > 0) { e.freezeT -= dt; if (e.freezeT <= 0) e.freezeImm = 2.5; }
      else if (e.freezeImm > 0) e.freezeImm -= dt;
      if (e.markT > 0) e.markT -= dt;
      if (e.shredT > 0) e.shredT -= dt;
      if (e.shieldT > 0) e.shieldT -= dt;
      if (m.thorns > 0) {
        const dx = e.x - castle.x, dy = e.y - castle.y;
        if (dx * dx + dy * dy < 4.5) this.hit(e, e.maxHp * (e.boss ? 0.02 : 0.09) * dt, 'physical', { tower: 0, direct: false });
        if (e.dead) continue;
      }
      // ---- abilities ----
      if (def.abilities && e.freezeT <= 0) {
        for (let k = 0; k < def.abilities.length; k++) {
          const a = def.abilities[k];
          if (a.type === 'regen') { if (e.hp < e.maxHp && e.burnT <= 0 && e.poisonT <= 0) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * a.pctPerSec * dt); continue; }
          if (a.type === 'enrage') { if (!e.enraged && e.hp / e.maxHp < a.below) { e.enraged = true; this.emit({ t: 'enemyAbility', kind: 'enrage', id: e.id, x: e.x, y: e.y }); } continue; }
          if (!('every' in a)) continue;
          e.ab[k] -= dt;
          if (e.ab[k] > 0) continue;
          e.ab[k] = a.every;
          if (a.type === 'summon') {
            const hpMul = e.maxHp / (def.hp * (1 + m.enemyHp));
            for (let n = 0; n < a.count; n++) {
              // Summons appear on the road next to the summoner (flyers drop them on the ground route).
              const ground = this.map.paths[e.path];
              const dist = e.fly ? Math.min(ground.len - 0.5, (e.dist / this.pathOf(e).len) * ground.len) : e.dist;
              this.pending.push({ def: a.enemy, path: e.path, dist: Math.max(0, dist - 0.3 - n * 0.3), hpMul: e.boss ? this.level.hpMul * 1.1 : hpMul * 0.6, fly: false });
            }
            this.emit({ t: 'enemyAbility', kind: 'summon', id: e.id, x: e.x, y: e.y });
          } else if (a.type === 'shield') {
            e.shieldT = a.dur; e.shieldReduce = a.reduce;
            this.emit({ t: 'enemyAbility', kind: 'shield', id: e.id, x: e.x, y: e.y, dur: a.dur });
          } else if (a.type === 'stun_towers') {
            const near = s.towers.filter((t) => t.stun <= 0).map((t) => ({ t, d: Math.hypot(this.slotPos(t.slot).x - e.x, this.slotPos(t.slot).y - e.y) })).sort((p, q) => p.d - q.d).slice(0, a.count);
            for (const n of near) { n.t.stun = a.dur; this.emit({ t: 'stun', tower: n.t.id, dur: a.dur }); }
            this.emit({ t: 'enemyAbility', kind: 'stun', id: e.id, x: e.x, y: e.y });
          } else if (a.type === 'blink') {
            e.dist = Math.min(this.pathOf(e).len - 0.6, e.dist + a.dist);
            this.emit({ t: 'enemyAbility', kind: 'blink', id: e.id, x: e.x, y: e.y });
          }
        }
      }
      // ---- movement ----
      if (e.freezeT <= 0) {
        let sp = def.speed * Math.max(0.2, 1 + m.enemySpeed) * (1 - e.chillPct) * (1 + e.haste);
        if (e.enraged) for (const a of def.abilities!) if (a.type === 'enrage') sp *= a.speedMul;
        e.dist += sp * dt;
      }
      const path = this.pathOf(e);
      pathPoint(path, e.dist, tmp);
      e.x = tmp.x; e.y = tmp.y;
      if (e.dist >= path.len - 0.35) {
        e.dead = true;
        this.anyDead = true;
        s.stats.leaks++;
        const dmg = this.leakDamage(def, e.boss);
        s.castleHp = Math.max(0, s.castleHp - dmg);
        this.emit({ t: 'leak', dmg, id: e.id, boss: e.boss });
        if (s.castleHp <= 0) {
          s.phase = 'lost';
          s.enemies = s.enemies.filter((x) => !x.dead);
          this.anyDead = false;
          this.emit({ t: 'lose' });
          return;
        }
      }
    }
  }

  private refreshAuras(): void {
    this.buffRate.clear();
    this.buffDmg.clear();
    const s = this.s;
    for (const src of s.towers) {
      const c = this.towerStats(src);
      if (!c.attack.buffRate && !c.attack.buffDmg) continue;
      const p = this.slotPos(src.slot), r2 = c.range * c.range;
      for (const t of s.towers) {
        if (t === src) continue;
        const q = this.slotPos(t.slot);
        const dx = q.x - p.x, dy = q.y - p.y;
        if (dx * dx + dy * dy > r2) continue;
        // Auras of the same kind do not stack – the strongest one wins.
        this.buffRate.set(t.id, Math.max(this.buffRate.get(t.id) ?? 0, c.attack.buffRate ?? 0));
        this.buffDmg.set(t.id, Math.max(this.buffDmg.get(t.id) ?? 0, c.attack.buffDmg ?? 0));
      }
    }
    this.auraDirty = false;
  }
  /** Aura bonuses currently applied to a tower (UI). */
  auraOf(id: number): { rate: number; dmg: number } {
    if (this.auraDirty) this.refreshAuras();
    return { rate: this.buffRate.get(id) ?? 0, dmg: this.buffDmg.get(id) ?? 0 };
  }

  private pickTargets(t: TowerState, c: TowerComputed, n: number, out: EnemyState[]): void {
    out.length = 0;
    const p = this.slotPos(t.slot), r2 = c.range * c.range, ground = c.def.targets === 'ground';
    const prefer = c.effects.length ? c.effects[0].type : null;
    const list = this.s.enemies;
    const scores: number[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead || (ground && e.fly)) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      if (dx * dx + dy * dy > r2) continue;
      let score = e.dist / this.pathOf(e).len;
      // Status towers spread their effect: targets that still lack it are preferred.
      if (prefer === 'chill' && e.chillT <= 0.3) score += 1;
      else if (prefer === 'poison' && e.poisonStacks < (c.effects[0].maxStacks ?? 1)) score += 1;
      else if (prefer === 'burn' && e.burnT <= 0.3) score += 1;
      else if (prefer === 'mark' && e.markT <= 0.3 && c.attack.kind !== 'beam') score += 1;
      // Beams keep ramping on their current victim.
      if (c.attack.kind === 'beam' && e.id === t.targetId) score += 2;
      let k = out.length;
      while (k > 0 && scores[k - 1] < score) k--;
      if (k < n) {
        out.splice(k, 0, e);
        scores.splice(k, 0, score);
        if (out.length > n) { out.length = n; scores.length = n; }
      }
    }
  }

  private updateTowers(dt: number): void {
    const s = this.s, m = this.mods;
    if (this.auraDirty) this.refreshAuras();
    const targets: EnemyState[] = [];
    const over = s.overT > 0 ? 1 + ABILITIES.overcharge.power : 1;
    for (const t of s.towers) {
      if (t.stun > 0) { t.stun -= dt; continue; }
      const c = this.towerStats(t);
      t.cd -= dt * (1 + (this.buffRate.get(t.id) ?? 0)) * over;
      if (t.cd > 0) continue;
      const p = this.slotPos(t.slot);
      const kind = c.attack.kind;
      const multi = kind === 'pulse' ? MAX_ENEMIES_ALIVE : Math.max(1, c.attack.multi ?? 1);
      this.pickTargets(t, c, multi, targets);
      if (!targets.length) { t.cd = 0; if (kind === 'beam') { t.ramp = 0; t.targetId = 0; } continue; }
      t.cd += 1 / c.rate;
      if (t.cd < 0) t.cd = 0;
      let dmg = c.damage * (1 + (this.buffDmg.get(t.id) ?? 0));
      const critChance = (c.specials.critChance ?? 0) + m.critChance;
      const crit = critChance > 0 && this.rngM.chance(critChance);
      if (crit) dmg *= (c.specials.critMul ?? 2) + m.critMul;
      s.shots++;
      const src: HitSrc = {
        tower: t.id, direct: true, siege: c.attack.siege, crit, effects: c.effects,
        execute: c.specials.execute, vsUndead: c.specials.vsUndead, spread: c.specials.spreadOnDeath,
        blast: c.specials.deathBlast ? c.damage * c.specials.deathBlast : 0,
      };
      if (kind === 'projectile') {
        for (const e of targets) {
          s.projs.push({
            id: s.nextId++, tower: t.id, x: p.x, y: p.y, target: e.id, lx: e.x, ly: e.y, speed: c.attack.speed ?? 10,
            dmg, el: c.element, crit, splash: (c.attack.splash ?? 0) * (c.attack.splash ? 1 + m.splash : 0), siege: !!c.attack.siege,
            effects: c.effects, spread: src.spread ?? 0, blast: src.blast ?? 0, execute: src.execute ?? 0, vsUndead: src.vsUndead ?? 0,
            ground: c.def.targets === 'ground', look: c.def.look.kind,
          });
        }
        this.emit({ t: 'shot', tower: t.id, kind, el: c.element, x: p.x, y: p.y, tx: targets[0].x, ty: targets[0].y });
      } else if (kind === 'chain') {
        this.chainBonus = 0;
        const pts: number[] = [p.x, p.y, 0];
        let cur = targets[0];
        const hitIds = new Set<number>();
        let d = dmg;
        let jumps = (c.attack.chain ?? 0) + Math.round(m.chainExtra);
        for (let j = 0; cur && j <= jumps; j++) {
          hitIds.add(cur.id);
          pts.push(cur.x, cur.y, cur.fly ? 1 : 0);
          const cx = cur.x, cy = cur.y;
          this.hit(cur, d, c.element, src);
          if (j === 0 && this.chainBonus) jumps += this.chainBonus;
          d *= c.attack.chainFalloff ?? 0.75;
          let best: EnemyState | null = null, bd = 1.9 * 1.9;
          for (const o of s.enemies) {
            if (o.dead || hitIds.has(o.id)) continue;
            const dx = o.x - cx, dy = o.y - cy, dd = dx * dx + dy * dy;
            if (dd < bd) { bd = dd; best = o; }
          }
          cur = best as EnemyState;
        }
        this.emit({ t: 'chain', tower: t.id, el: c.element, pts });
      } else if (kind === 'beam') {
        const main = targets[0];
        if (main.id === t.targetId) t.ramp = Math.min(c.attack.rampMax ?? 1, t.ramp + (c.attack.ramp ?? 0));
        else { t.ramp = 0; t.targetId = main.id; }
        const pts: number[] = [];
        for (const e of targets) {
          pts.push(e.x, e.y, e.fly ? 1 : 0);
          this.hit(e, dmg * (1 + t.ramp), c.element, src);
        }
        this.emit({ t: 'beam', tower: t.id, el: c.element, x: p.x, y: p.y, pts, ramp: t.ramp });
      } else {
        for (const e of targets) this.hit(e, dmg, c.element, src);
        this.emit({ t: 'pulse', tower: t.id, el: c.element, x: p.x, y: p.y, r: c.range });
      }
      // "Starfall" boost: every Nth tower attack calls a small meteor on the target.
      if (m.meteorEvery > 0 && s.shots % Math.max(2, Math.round(m.meteorEvery)) === 0) {
        const e = targets[0];
        this.emit({ t: 'ability', id: 'meteor', x: e.x, y: e.y, r: 1.1, mini: true });
        this.areaDamage(e.x, e.y, 1.1, c.damage * 3, 'fire', { tower: t.id, direct: true, noReact: true }, false);
      }
    }
  }

  private updateProjectiles(dt: number): void {
    const s = this.s;
    if (!s.projs.length) return;
    let removed = false;
    for (const p of s.projs) {
      const target = s.enemies.find((e) => e.id === p.target && !e.dead);
      if (target) { p.lx = target.x; p.ly = target.y; }
      const dx = p.lx - p.x, dy = p.ly - p.y, dist = Math.hypot(dx, dy), stepLen = p.speed * dt;
      if (dist > stepLen) {
        p.x += (dx / dist) * stepLen;
        p.y += (dy / dist) * stepLen;
        continue;
      }
      p.x = p.lx; p.y = p.ly;
      const src: HitSrc = { tower: p.tower, direct: true, siege: p.siege, crit: p.crit, effects: p.effects, execute: p.execute, vsUndead: p.vsUndead, spread: p.spread, blast: p.blast };
      if (p.splash > 0) {
        this.emit({ t: 'splash', x: p.x, y: p.y, r: p.splash, el: p.el });
        this.areaDamage(p.x, p.y, p.splash, p.dmg, p.el, src, p.ground);
      } else if (target) {
        this.hit(target, p.dmg, p.el, src);
      }
      p.target = -1;
      removed = true;
    }
    if (removed) s.projs = s.projs.filter((p) => p.target !== -1);
  }
}
