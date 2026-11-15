import { describe, it } from 'vitest';
import { simulateAccount } from './progression';

describe.skipIf(!process.env.EXPLORE)('balance exploration (EXPLORE=1)', () => {
  it('prints the progression table', () => {
    const seeds = [1, 2, 3];
    const style = (process.env.STYLE ?? 'dealers') as any;
    const runs = seeds.map((s) => simulateAccount(s, { hybrids: true }, 12, undefined, style));
    const rows = runs[0].log.map((_, i) => {
      const cells = runs.map((r) => r.log[i]).filter(Boolean);
      const avg = (f: (l: any) => number) => cells.reduce((a, c) => a + f(c), 0) / cells.length;
      return `${cells[0].id.padEnd(4)} attempts ${cells.map((c) => c.attempts).join('/').padEnd(9)} hp ${(avg((c) => c.hpPct) * 100).toFixed(0).padStart(3)}%  time ${avg((c) => c.time).toFixed(0).padStart(3)}s  cards ${avg((c) => c.cardAvg).toFixed(1)}  research ${avg((c) => c.research).toFixed(0).padStart(3)}  day ${avg((c) => c.day).toFixed(0)}  gold ${avg((c) => c.gold).toFixed(0)} tier ${avg((c) => c.maxTier).toFixed(1)} merges ${avg((c) => c.merges).toFixed(1)} hyb ${avg((c) => c.hybrids).toFixed(1)}`;
    });
    console.log(rows.join('\n') + '\nstuck: ' + runs.map((r) => r.stuck).join(','));
  });
});
