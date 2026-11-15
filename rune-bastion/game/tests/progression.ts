import { BASE_TOWER_IDS } from '../src/data/towers';
import { RESEARCH } from '../src/data/meta';
import { LEVELS } from '../src/data/worlds';
import { Game } from '../src/meta/game';
import { newProfile } from '../src/meta/profile';
import { BotPolicy, runBot } from './bot';

/**
 * Simulated account: plays the campaign through the real Game rules, spends its income with a
 * simple policy and grinds earlier levels when it gets stuck. Produces the data the balance
 * tests assert on (attempts per level, battle length, castle health).
 */
export interface LevelLog { id: string; attempts: number; grinds: number; hpPct: number; time: number; gold: number; cardAvg: number; research: number; day: number; maxTier: number; hybrids: number; merges: number }

const HOUR = 3600000;

/** How the simulated player builds a loadout: different, all reasonable, play styles. */
export type LoadoutStyle = 'dealers' | 'newest' | 'elements';
const PREFERENCE: Record<LoadoutStyle, string[]> = {
  dealers: ['storm', 'poison', 'fire', 'arcane', 'ice', 'sun'],
  newest: ['sun', 'arcane', 'storm', 'poison', 'ice', 'fire'],
  elements: ['ice', 'fire', 'poison', 'storm', 'sun', 'arcane'],
};

export function spend(g: Game, style: LoadoutStyle = 'dealers'): void {
  // Always keep the two starters (they cover air and armor), then fill by the style's preference.
  const size = g.loadoutSize();
  const pick = ['archer', 'cannon', ...PREFERENCE[style].filter((t) => g.p.cards[t])].slice(0, size);
  g.setLoadout(pick);
  for (let guard = 0; guard < 200; guard++) {
    let did = false;
    for (const t of g.p.loadout.slice().sort((a, b) => g.p.cards[a].level - g.p.cards[b].level)) if (g.upgradeCard(t).ok) { did = true; break; }
    if (did) continue;
    // Alchemy first (it unlocks hybrids), then whatever is cheapest.
    if (g.researchInfo('alchemy').canBuy && g.buyResearch('alchemy').ok) continue;
    const saving = !g.researchInfo('alchemy').maxed && !g.researchInfo('alchemy').locked;
    const buyable = RESEARCH.map((r) => g.researchInfo(r.id)).filter((i) => i.canBuy && !(saving && i.node.currency === 'essence')).sort((a, b) => a.cost - b.cost);
    if (buyable.length && g.buyResearch(buyable[0].node.id).ok) continue;
    break;
  }
}

function claimAll(g: Game): void {
  g.claimLogin();
  for (const kind of ['daily', 'weekly'] as const) for (const q of g.questList(kind)) if (q.done && !q.claimed) g.claimQuest(kind, q.def.id);
  for (const a of g.achievementList()) if (a.claimable) g.claimAchievement(a.def.id);
}

export function simulateAccount(seed: number, policy: BotPolicy = { hybrids: true }, maxAttempts = 12, levels = LEVELS.length, style: LoadoutStyle = 'dealers'): { log: LevelLog[]; game: Game; stuck: string | null } {
  let clock = new Date(2026, 10, 16, 9, 0, 0).getTime();
  const g = new Game(newProfile(`sim-${seed}`, clock), { now: () => clock, onChange: () => undefined, log: () => undefined });
  const log: LevelLog[] = [];
  let runs = 0, day = 0;
  const play = (levelId: string, tag: string) => {
    const r = g.beginRun(levelId, 'campaign', `${seed}:${tag}:${runs}`);
    if (!r.ok) throw new Error(`beginRun ${levelId}: ${r.reason}`);
    const res = runBot({ ...r.ctx, tutorial: false }, policy);
    const st = res.battle.serialize();
    st.ctx = r.ctx;
    const fin = g.finishRun(st);
    if (!fin.ok) throw new Error(`finishRun ${levelId}: ${fin.reason}`);
    runs++;
    clock += 5 * 60000;
    g.markSeen();
    // Six battles a day, then the player comes back the next day and collects idle gold.
    if (runs % 6 === 0) { clock += 20 * HOUR; day++; g.touchTime(); g.refreshPeriods(); g.claimOffline(); }
    claimAll(g);
    spend(g, style);
    return res;
  };
  for (const lvl of LEVELS.slice(0, levels)) {
    let attempts = 0, grinds = 0, won = false, last = { hpPct: 0, time: 0, maxTier: 1, hybrids: 0, merges: 0 };
    while (!won && attempts < maxAttempts) {
      attempts++;
      const res = play(lvl.id, lvl.id);
      won = res.won;
      last = { hpPct: res.hpPct, time: res.time, maxTier: res.battle.s.stats.maxTier, hybrids: res.battle.s.stats.hybrids, merges: res.battle.s.stats.merges };
      if (!won && lvl.index > 0) { play(LEVELS[lvl.index - 1].id, 'grind'); grinds++; }
    }
    const cards = g.p.loadout.map((t) => g.p.cards[t].level);
    log.push({ id: lvl.id, attempts, grinds, hpPct: last.hpPct, time: last.time, maxTier: last.maxTier, hybrids: last.hybrids, merges: last.merges, gold: g.p.gold, cardAvg: cards.reduce((a, b) => a + b, 0) / cards.length, research: Object.values(g.p.research).reduce((a, b) => a + b, 0), day });
    if (!won) return { log, game: g, stuck: lvl.id };
  }
  return { log, game: g, stuck: null };
}
