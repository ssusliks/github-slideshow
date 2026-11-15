import { it } from 'vitest';
import { simulateAccount } from './progression';
import { runBot } from './bot';
import { LEVEL_BY_ID } from '../src/data/worlds';
import { BASE_TOWER_IDS } from '../src/data/towers';
it('dbg', () => {
  for (const id of ['2-5', '3-3']) {
    const { game } = simulateAccount(1, { hybrids: true }, 12, LEVEL_BY_ID[id].index, 'dealers');
    for (const t of BASE_TOWER_IDS) game.p.cards[t] = { level: 3, mastery: 0 };
    const ctx = { ...game.buildContext(id, 'campaign', 1), tutorial: false };
    for (const lo of [['archer'], ['archer', 'ice'], ['cannon'], ['cannon', 'ice'], ['arcane'], ['arcane', 'sun'], ['archer', 'sun']]) for (const mul of [2, 3]) {
      let wins = 0, hp = 0, react = 0, iceShare = 0; const N = 10;
      for (let s = 1; s <= N; s++) { const r = runBot({ ...ctx, seed: s * 13, loadout: lo, baseMods: { ...ctx.baseMods, enemyHp: mul - 1 } }, {}); if (r.won) wins++; hp += r.hpPct; react += r.battle.s.stats.reactions; iceShare += r.battle.s.towers.filter((t) => t.def === 'ice' || t.def === 'sun').length; }
      console.log(id, lo.join('+').padEnd(12), 'x' + mul, `wins ${wins}/${N}`, `hp ${(hp / N * 100).toFixed(0)}%`, `reactions ${(react / N).toFixed(0)}`, `support towers ${(iceShare / N).toFixed(1)}`);
    }
  }
});
