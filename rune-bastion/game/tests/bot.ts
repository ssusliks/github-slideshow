import { Battle } from '../src/core/battle';
import type { RunContext } from '../src/core/types';
import { BOOST_BY_ID } from '../src/data/boosts';
import { TOWERS } from '../src/data/towers';
import { LEVELS, LEVEL_BY_ID } from '../src/data/worlds';

/** Scripted player used by balance simulations. Policies approximate different play styles. */
export interface BotPolicy {
  /** towers the bot is allowed to buy (subset of loadout); default = whole loadout. */
  only?: string[];
  hybrids?: boolean;
  branch?: 0 | 1;
  boosts?: 'smart' | 'first' | 'worst';
  abilities?: boolean;
  merge?: boolean;
  upgrade?: boolean;
}
export interface BotResult { won: boolean; hp: number; hpPct: number; time: number; wave: number; kills: number; leaks: number; battle: Battle }

const RARITY_SCORE = { common: 1, rare: 2, epic: 3 } as const;

/** Card multiplier / research a typical player has when first reaching a level (see docs/BALANCE). */
export function expectedContext(levelId: string, seed = 1, over: Partial<RunContext> = {}): RunContext {
  const lvl = LEVEL_BY_ID[levelId];
  const idx = lvl ? lvl.index : 12;
  const unlocked = Object.values(TOWERS).filter((t) => !t.hybrid && (t.unlockLevel === '' || LEVELS.findIndex((l) => l.id === t.unlockLevel) < idx)).map((t) => t.id);
  const loadout = unlocked.slice(-5).length < 3 ? unlocked : ['archer', 'cannon', ...unlocked.filter((t) => t !== 'archer' && t !== 'cannon').slice(-3)];
  const cardLevel = 1 + Math.floor(idx / 2.5);
  const cardMul: Record<string, number> = {};
  for (const t of unlocked) cardMul[t] = 1 + 0.08 * (cardLevel - 1);
  const abilities = ['meteor'];
  if (idx > 2) abilities.push('freeze');
  if (idx > 5) abilities.push('overcharge');
  if (idx > 8) abilities.push('heal');
  return {
    levelId, mode: 'campaign', seed, loadout, cardMul,
    baseMods: { dmgAll: 0.015 * idx, castleHp: Math.floor(idx / 3), startCoins: 5 * Math.floor(idx / 2) },
    alchemy: idx >= 3 ? (idx >= 9 ? (idx >= 15 ? 3 : 2) : 1) : 0, abilities, ...over,
  };
}

export function runBot(ctx: RunContext, policy: BotPolicy = {}, maxTime = 900): BotResult {
  const b = new Battle(ctx);
  const allowed = (policy.only ?? ctx.loadout).filter((t) => ctx.loadout.includes(t));
  // Slots ranked by how much road they cover.
  const coverage = b.map.slots.map((s, i) => {
    let n = 0;
    for (const p of b.map.paths) for (let d = 0; d < p.len; d += 0.5) {
      const idx = p.cum.findIndex((c) => c >= d);
      const pt = p.pts[Math.max(0, idx)];
      if (Math.hypot(pt.x - s.x, pt.y - s.y) <= 2.3) n++;
    }
    return { i, n };
  }).sort((a, c) => c.n - a.n).map((x) => x.i);
  let buyIdx = 0, think = 0;
  while (b.s.phase !== 'won' && b.s.phase !== 'lost' && b.s.time < maxTime) {
    const s = b.s;
    if (s.phase === 'boost') {
      const offer = s.offer!;
      let pick = 0;
      if (policy.boosts !== 'first') {
        const score = (id: string) => (id === 'glasscannon' ? 0.5 : RARITY_SCORE[BOOST_BY_ID[id].rarity]) * (policy.boosts === 'worst' ? -1 : 1);
        offer.forEach((id, i) => { if (score(id) > score(offer[pick])) pick = i; });
      }
      b.chooseBoost(pick);
      continue;
    }
    if (s.phase === 'prep') b.startWave();
    if (--think <= 0) {
      think = 10;
      // 1. merges
      if (policy.merge !== false) {
        let merged = true;
        while (merged) {
          merged = false;
          outer: for (const a of s.towers) for (const c of s.towers) {
            if (a === c) continue;
            const chk = b.mergeCheck(a.id, c.id);
            if (!chk.ok) continue;
            if (chk.options[0].kind === 'hybrid' && !policy.hybrids) continue;
            const opt = Math.min(chk.options.length - 1, policy.branch ?? 0);
            if (b.merge(a.id, c.id, opt).ok) { merged = true; break outer; }
          }
        }
      }
      // 2. buy into the best free slot
      let bought = true;
      while (bought) {
        bought = false;
        const free = coverage.find((i) => !b.towerAt(i));
        if (free === undefined) break;
        const def = allowed[buyIdx % allowed.length];
        if (s.coins >= b.buyCost(def) && b.buyTower(def, free).ok) { buyIdx++; bought = true; }
      }
      // 3. upgrades when the board is full
      if (policy.upgrade !== false && coverage.every((i) => b.towerAt(i))) {
        const best = s.towers.slice().sort((a, c) => c.tier - a.tier || a.rank - c.rank)[0];
        if (best && b.canUpgrade(best) && s.coins >= b.upgradeCost(best) + 40) b.upgradeTower(best.id);
      }
      // 4. abilities
      if (policy.abilities !== false && s.enemies.length) {
        const lead = s.enemies.reduce((a, c) => (c.dist > a.dist ? c : a));
        if (s.enemies.length >= 3) b.useAbility('meteor', lead.x, lead.y);
        if (s.enemies.length >= 6) b.useAbility('overcharge');
        if (s.enemies.some((e) => e.dist > 12) && s.enemies.length >= 4) b.useAbility('freeze');
        if (s.castleHp < s.castleMax * 0.6) b.useAbility('heal');
      }
    }
    b.step();
  }
  const s = b.s;
  return { won: s.phase === 'won', hp: s.castleHp, hpPct: s.castleHp / s.castleMax, time: s.time, wave: s.wave, kills: s.stats.kills, leaks: s.stats.leaks, battle: b };
}
