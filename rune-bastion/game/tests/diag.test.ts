import { describe, it } from 'vitest';
import { simulateAccount } from './progression';
import { runBot } from './bot';
import { LEVELS } from '../src/data/worlds';

describe.skipIf(!process.env.DIAG)('diagnostics', () => {
  it('win rates at the moment a level is first reached', () => {
    const out: string[] = [];
    for (const id of (process.env.DIAG ?? '').split(',')) {
      const idx = LEVELS.findIndex((l) => l.id === id);
      const { game: g } = simulateAccount(Number(process.env.ACC ?? 1), { hybrids: true }, 12, idx);
      const ctx = g.buildContext(id, 'campaign', 1);
      let wins = 0; const waves: number[] = []; const dmg: Record<string, number> = {};
      const N = 12;
      for (let s = 1; s <= N; s++) {
        const r = runBot({ ...ctx, seed: s * 77, tutorial: false }, { hybrids: true });
        if (r.won) wins++; else waves.push(r.wave);
        for (const k of Object.keys(r.battle.s.stats.dmgByDef)) dmg[k] = (dmg[k] ?? 0) + r.battle.s.stats.dmgByDef[k];
      }
      const total = Object.values(dmg).reduce((a, b) => a + b, 0);
      out.push(`${id}: win ${wins}/${N} lostAtWave [${waves.join(',')}] loadout ${ctx.loadout.join(',')} cards ${ctx.loadout.map((t) => g.p.cards[t].level).join('/')} alchemy ${ctx.alchemy} research ${JSON.stringify(g.p.research)} hp ${ctx.baseMods.castleHp ?? 0} dmg ${Object.entries(dmg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${Math.round((v / total) * 100)}%`).join(' ')}`);
    }
    console.log(out.join('\n'));
  });
});
