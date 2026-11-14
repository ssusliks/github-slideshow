import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/data/worlds';
import { expectedContext, runBot } from './bot';

describe('campaign smoke', () => {
  it('prints a pass over all levels', () => {
    const rows: string[] = [];
    for (const l of LEVELS) {
      let wins = 0, hp = 0, time = 0;
      const N = 6;
      for (let seed = 1; seed <= N; seed++) {
        const r = runBot(expectedContext(l.id, seed), { hybrids: true });
        if (r.won) wins++;
        hp += r.hpPct; time += r.time;
      }
      rows.push(`${l.id.padEnd(4)} map ${l.map}${l.mirror ? 'm' : ' '} waves ${l.waves} hpMul ${l.hpMul.toFixed(2).padStart(6)}  wins ${wins}/${N}  hp ${(hp / N * 100).toFixed(0).padStart(3)}%  time ${(time / N).toFixed(0).padStart(3)}s`);
    }
    console.log(rows.join('\n'));
    expect(rows.length).toBe(LEVELS.length);
  });
});
