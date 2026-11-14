import { MAX_RANK_BELOW_TOP, RANK_BONUS, TIER_MUL, TOWERS } from '../data/towers';
import type { AttackSpec, DamageType, EffectSpec, Mods, TowerDef, TowerSpecials } from './types';
import { BRANCH_TIER, MAX_TIER, clampNum } from './types';

export interface TowerComputed {
  def: TowerDef;
  element: DamageType;
  damage: number;
  rate: number;
  range: number;
  attack: AttackSpec;
  effects: EffectSpec[];
  specials: TowerSpecials;
  /** damage per second against a single unresisted target (UI + balance reports). */
  dps: number;
}

/** Rank multiplier: linear up to the soft cap, then logarithmic so "endless" upgrades never explode. */
export function rankMul(rank: number): number {
  const r = Math.max(0, Math.floor(rank));
  if (r <= MAX_RANK_BELOW_TOP) return 1 + RANK_BONUS * r;
  return 1 + RANK_BONUS * MAX_RANK_BELOW_TOP + 0.5 * Math.log1p((r - MAX_RANK_BELOW_TOP) * 0.3);
}

export function maxRank(tier: number): number {
  return tier >= MAX_TIER ? 999 : MAX_RANK_BELOW_TOP;
}

/**
 * Pure stat calculation shared by the simulation, merge previews and the collection UI.
 * `cardMul` is the account-level multiplier of the tower card, `mods` the aggregated run modifiers.
 */
export function computeTower(defId: string, tier: number, rank: number, branch: string | null, cardMul: number, mods: Mods): TowerComputed {
  const def = TOWERS[defId];
  if (!def) throw new Error(`Unknown tower ${defId}`);
  const t = Math.min(MAX_TIER, Math.max(1, tier));
  let damage = def.base.damage * TIER_MUL[t];
  let rate = def.base.rate * (1 + 0.04 * (t - 1));
  let range = def.base.range * (1 + 0.03 * (t - 1));
  let attack: AttackSpec = { ...def.attack };
  let effects: EffectSpec[] = def.effects.map((e) => ({ ...e }));
  let specials: TowerSpecials = { ...(def.specials ?? {}) };
  const br = t >= BRANCH_TIER && branch ? def.branches?.find((b) => b.id === branch) : undefined;
  if (br) {
    damage *= br.mul?.damage ?? 1;
    rate *= br.mul?.rate ?? 1;
    range *= br.mul?.range ?? 1;
    attack = { ...attack, ...(br.attack ?? {}) };
    if (br.addEffects) effects = effects.concat(br.addEffects.map((e) => ({ ...e })));
    specials = { ...specials, ...(br.specials ?? {}) };
  }
  const elBonus = Math.max(mods.dmgEl[def.element], def.element2 ? mods.dmgEl[def.element2] : -Infinity);
  damage *= rankMul(rank) * cardMul * Math.max(0.1, 1 + mods.dmgAll + elBonus + (def.hybrid ? mods.hybridDmg : 0));
  rate *= Math.max(0.2, 1 + mods.rateAll);
  range = Math.max(1.2, range * (1 + mods.rangeAll));
  damage = clampNum(damage);
  const multi = attack.multi ?? 1;
  const dps = damage * rate * (attack.kind === 'beam' ? 1 + (attack.rampMax ?? 0) / 2 : 1) * (attack.kind === 'pulse' ? 1 : multi);
  return { def, element: def.element, damage, rate, range, attack, effects, specials, dps };
}
