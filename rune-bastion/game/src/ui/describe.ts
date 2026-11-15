import type { TowerComputed } from '../core/stats';
import type { BoostDef, EffectSpec } from '../core/types';
import { t } from '../services/i18n';
import { fmtStat } from './dom';

const pct = (v: number) => `${Math.round(v * 100)}%`;

function effectLine(e: EffectSpec): string {
  switch (e.type) {
    case 'burn': return t('fx.burn', { pct: pct(e.dpsPct ?? 0), dur: e.dur });
    case 'poison': return t('fx.poison', { pct: pct(e.dpsPct ?? 0), dur: e.dur, stacks: e.maxStacks ?? 1 });
    case 'chill': return t('fx.chill', { pct: pct(e.pct ?? 0), dur: e.dur });
    case 'freeze': return t('fx.freeze', { pct: pct(e.chance ?? 1), dur: e.dur });
    case 'mark': return t('fx.mark', { pct: pct(e.pct ?? 0), dur: e.dur });
    case 'shred': return t('fx.shred', { pct: pct(e.pct ?? 0), dur: e.dur });
  }
}

/** Human-readable ability list of a computed tower (panel, merge preview, collection). */
export function describeTower(c: TowerComputed): string[] {
  const out: string[] = [];
  const a = c.attack;
  if (a.kind === 'chain') out.push(t('fx.chain', { n: a.chain ?? 0 }));
  if (a.kind === 'beam') out.push(t('fx.beam', { pct: pct(a.rampMax ?? 0) }));
  if (a.kind === 'pulse') out.push(t('fx.pulse'));
  if (a.splash) out.push(t('fx.splash', { r: fmtStat(a.splash) }));
  if ((a.multi ?? 1) > 1) out.push(t('fx.multi', { n: a.multi! }));
  if (a.siege) out.push(t('fx.siege'));
  if (a.buffRate) out.push(t('fx.buff_rate', { pct: pct(a.buffRate) }));
  if (a.buffDmg) out.push(t('fx.buff_dmg', { pct: pct(a.buffDmg) }));
  // Later effects of the same type override earlier ones (branches upgrade base effects).
  const byType = new Map<string, EffectSpec>();
  for (const e of c.effects) {
    const prev = byType.get(e.type);
    if (!prev || (e.pct ?? e.dpsPct ?? e.chance ?? 0) >= (prev.pct ?? prev.dpsPct ?? prev.chance ?? 0)) byType.set(e.type, e);
  }
  for (const e of byType.values()) out.push(effectLine(e));
  const s = c.specials;
  if (s.critChance) out.push(t('fx.crit', { pct: pct(s.critChance), mul: s.critMul ?? 2 }));
  if (s.spreadOnDeath) out.push(t('fx.spread'));
  if (s.execute) out.push(t('fx.execute', { pct: pct(s.execute) }));
  if (s.deathBlast) out.push(t('fx.blast'));
  if (s.vsUndead) out.push(t('fx.undead', { pct: pct(s.vsUndead - 1) }));
  if (c.def.targets === 'ground') out.push(t('fx.ground'));
  return out;
}

export function towerTitle(def: string, branch: string | null): string {
  return branch ? t(`branch.${branch}.name`) : t(`tower.${def}.name`);
}
export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export const EL_ICON: Record<string, string> = { physical: '🏹', fire: '🔥', ice: '❄️', poison: '☠️', lightning: '⚡', arcane: '🔮', light: '☀️' };
export const ABILITY_ICON: Record<string, string> = { meteor: '☄️', freeze: '❄️', overcharge: '⚡', heal: '💚' };
export const boostText = (b: BoostDef) => ({ name: t(`boost.${b.id}.name`), desc: t(`boost.${b.id}.desc`) });
