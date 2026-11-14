import { ALCHEMY_RARITY, FORBIDDEN, HYBRID_MIN_TIER, MERGE_FEE, RECIPES, TOWERS } from '../data/towers';
import type { MergeRecipe } from './types';
import { BRANCH_TIER, MAX_TIER, RARITY_ORDER } from './types';

/** Minimal tower description the merge rules need – keeps the rules testable without a battle. */
export interface MergeInput { def: string; tier: number; branch: string | null; rank: number }
export interface MergeOption { def: string; tier: number; branch: string | null; rank: number; fee: number; kind: 'same' | 'hybrid' }
export type MergeCheck = { ok: true; options: MergeOption[] } | { ok: false; reason: string };

const pairKey = (a: string, b: string) => (a < b ? `${a}+${b}` : `${b}+${a}`);
const RECIPE_MAP = new Map<string, MergeRecipe>(RECIPES.map((r) => [pairKey(r.a, r.b), r]));
const FORBID_MAP = new Map<string, string>(FORBIDDEN.map((f) => [pairKey(f.a, f.b), f.reason]));

export function findRecipe(a: string, b: string): MergeRecipe | undefined {
  return RECIPE_MAP.get(pairKey(a, b));
}

/**
 * Data-driven compatibility check. Order of checks: tower type → tier → specialization (branch)
 * → rarity/alchemy → recipe. Returns every allowed result so the UI can show a full preview.
 * `feeMul` comes from run modifiers (e.g. the "merge master" boost makes merges free).
 */
export function checkMerge(a: MergeInput, b: MergeInput, alchemy: number, feeMul = 1): MergeCheck {
  const da = TOWERS[a.def], db = TOWERS[b.def];
  if (!da || !db) return { ok: false, reason: 'merge.err.unknown' };
  const rank = Math.max(a.rank, b.rank);
  const fee = (tier: number) => Math.max(0, Math.round(MERGE_FEE[tier] * Math.max(0, feeMul)));

  if (a.def === b.def) {
    if (a.tier !== b.tier) return { ok: false, reason: 'merge.err.tier' };
    if (a.tier >= MAX_TIER) return { ok: false, reason: 'merge.err.max' };
    if ((a.branch ?? null) !== (b.branch ?? null)) return { ok: false, reason: 'merge.err.branch' };
    const tier = a.tier + 1;
    if (tier === BRANCH_TIER && da.branches) {
      return { ok: true, options: da.branches.map((br) => ({ def: a.def, tier, branch: br.id, rank, fee: fee(tier), kind: 'same' as const })) };
    }
    return { ok: true, options: [{ def: a.def, tier, branch: a.branch ?? null, rank, fee: fee(tier), kind: 'same' }] };
  }

  // Different towers: only base towers can be alloyed into a hybrid.
  if (da.hybrid || db.hybrid) return { ok: false, reason: 'merge.err.hybrid_mix' };
  const forbidden = FORBID_MAP.get(pairKey(a.def, b.def));
  if (forbidden) return { ok: false, reason: forbidden };
  const recipe = findRecipe(a.def, b.def);
  if (!recipe) return { ok: false, reason: 'merge.err.no_recipe' };
  if (a.tier !== b.tier) return { ok: false, reason: 'merge.err.tier' };
  if (a.tier !== HYBRID_MIN_TIER || a.branch || b.branch) return { ok: false, reason: 'merge.err.hybrid_tier' };
  if (alchemy < recipe.alchemy) return { ok: false, reason: 'merge.err.alchemy' };
  const maxRarity = RARITY_ORDER.indexOf(ALCHEMY_RARITY[Math.min(alchemy, ALCHEMY_RARITY.length - 1)]);
  if (RARITY_ORDER.indexOf(da.rarity) > maxRarity || RARITY_ORDER.indexOf(db.rarity) > maxRarity) return { ok: false, reason: 'merge.err.rarity' };
  const tier = a.tier + 1;
  const options = recipe.results.filter((id) => TOWERS[id]?.hybrid).map((id) => ({ def: id, tier, branch: null, rank, fee: fee(tier), kind: 'hybrid' as const }));
  if (!options.length) return { ok: false, reason: 'merge.err.no_recipe' };
  return { ok: true, options };
}
