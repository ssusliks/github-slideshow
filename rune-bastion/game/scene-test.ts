import { Battle } from './src/core/battle';
import { BattleView } from './src/render/view';
import { WORLDS, LEVEL_BY_ID } from './src/data/worlds';
const q = new URLSearchParams(location.search);
const levelId = q.get('level') ?? '1-3';
const loadout = (q.get('towers') ?? 'archer,cannon,fire,ice,poison').split(',');
const b = new Battle({ levelId, mode: 'campaign', seed: 3, loadout, cardMul: {}, baseMods: { startCoins: Number(q.get('coins') ?? 600) }, alchemy: 3, abilities: ['meteor', 'freeze'], tutorial: true });
b.collect = true;
const view = new BattleView(document.getElementById('c') as HTMLCanvasElement, document.getElementById('t')!, { quality: 'high', fx: 1, shake: true });
view.setBattle(b, WORLDS[LEVEL_BY_ID[levelId].world - 1], 'default');
let i = 0;
for (let s = 0; s < b.map.slots.length; s++) b.buyTower(loadout[i++ % loadout.length], s);
// build some tiers for the visual check
for (let pass = 0; pass < 3; pass++) for (const a of [...b.s.towers]) for (const c of [...b.s.towers]) { if (a !== c && b.tower(a.id) && b.tower(c.id) && b.mergeCheck(a.id, c.id).ok) b.merge(a.id, c.id, pass % 2); }
for (let s = 0; s < b.map.slots.length; s++) if (!b.towerAt(s)) b.buyTower(loadout[i++ % loadout.length], s);
b.startWave();
let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (b.s.phase === 'boost') b.chooseBoost(0);
  if (b.s.phase === 'prep') b.startWave();
  b.advance(dt * Number(q.get('speed') ?? 1));
  view.frame(dt);
  b.events.length = 0;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
(window as any).b = b; (window as any).view = view;
