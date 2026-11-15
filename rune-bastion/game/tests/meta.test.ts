import { beforeEach, describe, expect, it } from 'vitest';
import { Battle } from '../src/core/battle';
import { ACHIEVEMENTS, AD_PLACEMENTS, CARD_MAX_LEVEL, DAILY_QUESTS, GEM_SHOP, IAP_PRODUCTS, LOGIN_REWARDS, OFFLINE_CAP_HOURS, RESEARCH, REVIVE_GEMS, WEEKLY_QUESTS, cardMultiplier, eventsAt, offlineRate } from '../src/data/meta';
import { BASE_TOWER_IDS, TOWERS } from '../src/data/towers';
import { ENDLESS, LEVELS } from '../src/data/worlds';
import { Game } from '../src/meta/game';
import { CAPS, Profile, newProfile, progressScore, sanitizeProfile, unlockedAbilities } from '../src/meta/profile';
import { expectedContext, runBot } from './bot';

const HOUR = 3600000, DAY = 24 * HOUR;
// 2026-11-16 12:00 local time (a Monday) – far from midnight so day arithmetic is stable in any TZ.
const T0 = new Date(2026, 10, 16, 12, 0, 0).getTime();
let clock = T0;
let logs: string[] = [];
let changes = 0;
function mk(p?: Profile): Game {
  return new Game(p ?? newProfile('test-profile', clock), { now: () => clock, onChange: () => { changes++; }, log: (k) => logs.push(k) });
}
beforeEach(() => { clock = T0; logs = []; changes = 0; });

/** Plays a level with the bot through the real Game run pipeline. */
function playLevel(g: Game, levelId: string, runId: string, expectWin = true) {
  const r = g.beginRun(levelId, 'campaign', runId);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('beginRun failed');
  const res = runBot({ ...r.ctx, tutorial: false, baseMods: { ...r.ctx.baseMods, dmgAll: (r.ctx.baseMods.dmgAll ?? 0) + (expectWin ? 3 : -0.95) } }, { hybrids: true });
  expect(res.won).toBe(expectWin);
  const state = res.battle.serialize();
  state.ctx = r.ctx; // the bot only tweaked difficulty; identity fields are unchanged
  return { state, fin: g.finishRun(state) };
}

describe('profile', () => {
  it('a new profile is valid, has starter towers and survives sanitising unchanged', () => {
    const p = newProfile('abc', T0);
    expect(Object.keys(p.cards).sort()).toEqual(['archer', 'cannon', 'fire']);
    expect(sanitizeProfile(JSON.parse(JSON.stringify(p)), T0)).toEqual(p);
    expect(unlockedAbilities(p)).toEqual(['meteor']);
  });
  it('sanitising clamps hostile values and drops unknown content', () => {
    const raw: any = JSON.parse(JSON.stringify(newProfile('abc', T0)));
    Object.assign(raw, { gold: 1e99, gems: -5, essence: NaN, playtime: 'x', loadout: ['archer', 'hacked', 'frostfire', 'sun'], ledger: 'nope' });
    raw.cards.hacked = { level: 99 }; raw.cards.frostfire = { level: 5 }; raw.cards.archer = { level: 999, mastery: -4 };
    raw.research = { weaponry: 500, bogus: 3 }; raw.campaign = { '1-1': { stars: 9, clears: 1 }, '9-9': { stars: 3, clears: 1 } };
    raw.cosmetics = { owned: ['default', 'pwned'], castle: 'pwned' }; raw.shards = { archer: 1e30, nope: 5 };
    const p = sanitizeProfile(raw, T0)!;
    expect(p.gold).toBe(CAPS.gold); expect(p.gems).toBe(0); expect(p.essence).toBe(0); expect(p.playtime).toBe(0);
    expect(p.cards.hacked).toBeUndefined(); expect(p.cards.frostfire).toBeUndefined();
    expect(p.cards.archer).toEqual({ level: CARD_MAX_LEVEL, mastery: 0 });
    expect(p.loadout).toEqual(['archer']);
    expect(p.research).toEqual({ weaponry: 10 });
    expect(p.campaign).toEqual({ '1-1': { stars: 3, clears: 1 } });
    expect(p.cosmetics).toEqual({ owned: ['default'], castle: 'default' });
    expect(p.shards).toEqual({ archer: CAPS.shards });
    expect(p.ledger).toEqual([]);
  });
  it('rejects things that are not profiles or come from a newer version', () => {
    for (const bad of [null, 5, 'x', [], {}, { id: '' }, { id: 'a', v: 999 }]) expect(sanitizeProfile(bad, T0)).toBeNull();
  });
});

describe('grants are idempotent', () => {
  it('applies a reward once per grant id and resolves random shards deterministically', () => {
    const g = mk();
    expect(g.grant({ gold: 50, gems: 3, randomShards: 9 }, 'x:1')).toBe(true);
    const after = JSON.stringify([g.p.gold, g.p.gems, g.p.shards]);
    expect(g.p.gold).toBe(150);
    expect(Object.values(g.p.shards).reduce((a, b) => a + b, 0)).toBe(9);
    expect(g.grant({ gold: 50, gems: 3, randomShards: 9 }, 'x:1')).toBe(false);
    expect(JSON.stringify([g.p.gold, g.p.gems, g.p.shards])).toBe(after);
    expect(g.resolveReward({ randomShards: 9 }, 'x:1')).toEqual(g.resolveReward({ randomShards: 9 }, 'x:1'));
    expect(g.grant({ gold: 1 }, '')).toBe(false);
  });
  it('ignores hybrid / unknown shard ids and caps currencies', () => {
    const g = mk();
    g.grant({ shards: { frostfire: 5, nope: 5, archer: 2 }, gold: 1e30 }, 'y');
    expect(g.p.shards).toEqual({ archer: 2 });
    expect(g.p.gold).toBe(CAPS.gold);
  });
  it('spending validates amounts', () => {
    const g = mk();
    expect(g.spend('gold', 1e9)).toBe(false);
    expect(g.spend('gold', -5)).toBe(false);
    expect(g.spend('gold', NaN)).toBe(false);
    expect(g.spend('gold', 40)).toBe(true);
    expect(g.p.gold).toBe(60);
  });
});

describe('campaign runs', () => {
  it('a won level pays once, unlocks the next level and records stars', () => {
    const g = mk();
    expect(g.isLevelUnlocked('1-1')).toBe(true);
    expect(g.isLevelUnlocked('1-2')).toBe(false);
    expect(g.beginRun('1-2', 'campaign', 'r0').ok).toBe(false);
    const gold0 = g.p.gold, gems0 = g.p.gems;
    const { state, fin } = playLevel(g, '1-1', 'run-a');
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    const s = fin.summary;
    expect(s.won).toBe(true); expect(s.firstClear).toBe(true); expect(s.stars).toBeGreaterThanOrEqual(1);
    expect(g.p.gold).toBe(gold0 + s.reward.gold);
    expect(g.p.gems).toBe(gems0 + s.reward.gems);
    expect(s.reward.gold).toBeGreaterThan(100);
    expect(g.p.campaign['1-1'].clears).toBe(1);
    expect(g.isLevelUnlocked('1-2')).toBe(true);
    expect(g.p.tutorial.done).toBe(true);
    // replaying the same finished state cannot pay again
    const again = g.finishRun(state);
    expect(again.ok).toBe(false);
    expect(g.p.gold).toBe(gold0 + s.reward.gold);
    // the rewarded-ad double works exactly once
    expect(g.doubleLastRun().ok).toBe(true);
    expect(g.p.gold).toBe(gold0 + s.reward.gold * 2);
    expect(g.doubleLastRun().ok).toBe(false);
  });
  it('replays pay less than the first clear and never re-grant first-clear gems', () => {
    const g = mk();
    const a = playLevel(g, '1-1', 'r1').fin, b = playLevel(g, '1-1', 'r2').fin;
    if (!a.ok || !b.ok) throw new Error('runs failed');
    expect(b.summary.firstClear).toBe(false);
    expect(b.summary.reward.gold).toBeLessThan(a.summary.reward.gold);
    expect(b.summary.reward.gems).toBeLessThanOrEqual(5);
    expect(g.p.campaign['1-1'].clears).toBe(2);
  });
  it('a defeat pays only a small consolation and unlocks nothing', () => {
    const g = mk();
    const { fin } = playLevel(g, '1-1', 'r-lost', false);
    if (!fin.ok) throw new Error('finish failed');
    expect(fin.summary.won).toBe(false);
    expect(fin.summary.reward.gems).toBe(0);
    expect(fin.summary.reward.gold).toBeLessThan(30);
    expect(g.p.campaign['1-1']).toBeUndefined();
    expect(fin.summary.canDouble).toBe(false);
  });
  it('rejects forged or mismatched results and logs them', () => {
    const g = mk();
    const r = g.beginRun('1-1', 'campaign', 'forge');
    if (!r.ok) throw new Error();
    const b = new Battle(r.ctx);
    const forged = b.serialize();
    forged.phase = 'won'; // "instant win": no time passed, nothing killed
    expect(g.finishRun(forged)).toEqual({ ok: false, reason: 'err.run_rejected' });
    expect(logs).toContain('run_implausible');
    expect(g.p.campaign['1-1']).toBeUndefined();
    // a result that belongs to another run / level
    const r2 = g.beginRun('1-1', 'campaign', 'forge2');
    if (!r2.ok) throw new Error();
    const other = runBot(expectedContext('1-1', 999)).battle.serialize();
    expect(g.finishRun(other)).toEqual({ ok: false, reason: 'err.run_mismatch' });
    // no active run at all
    g.abandonRun();
    expect(g.finishRun(other)).toEqual({ ok: false, reason: 'err.no_run' });
    // an unfinished battle
    const r3 = g.beginRun('1-1', 'campaign', 'forge3');
    if (!r3.ok) throw new Error();
    expect(g.finishRun(new Battle(r3.ctx).serialize())).toEqual({ ok: false, reason: 'err.not_finished' });
  });
  it('unlocks towers, abilities, worlds and endless along the campaign', () => {
    const g = mk();
    const seen = { towers: [] as string[], abilities: [] as string[], worlds: [] as number[], endless: false };
    for (const l of LEVELS.slice(0, 7)) {
      const { fin } = playLevel(g, l.id, `c-${l.id}`);
      if (!fin.ok) throw new Error(`level ${l.id}: ${fin.reason}`);
      if (fin.summary.unlockedTower) seen.towers.push(fin.summary.unlockedTower);
      if (fin.summary.unlockedAbility) seen.abilities.push(fin.summary.unlockedAbility);
      if (fin.summary.unlockedWorld) seen.worlds.push(fin.summary.unlockedWorld);
      seen.endless ||= !!fin.summary.endlessUnlocked;
    }
    expect(seen.towers).toEqual(['ice', 'poison', 'storm']);
    expect(seen.abilities).toEqual(['freeze', 'overcharge']);
    expect(seen.worlds).toEqual([2]);
    expect(seen.endless).toBe(true);
    expect(g.endlessUnlocked()).toBe(true);
    expect(unlockedAbilities(g.p)).toEqual(['meteor', 'freeze', 'overcharge']);
    expect(g.p.essence).toBeGreaterThanOrEqual(20);
    expect(g.worldsUnlocked()).toBe(2);
  });
  it('endless rewards are sub-linear and throttled per day', () => {
    const g = mk();
    g.p.campaign[ENDLESS.unlockLevel] = { stars: 3, clears: 1 };
    const golds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = g.beginRun('endless', 'endless', `e${i}`);
      if (!r.ok) throw new Error(r.reason);
      const b = new Battle(r.ctx);
      const st = b.serialize();
      st.phase = 'lost'; st.wave = 20; st.time = 400; st.stats.kills = 200;
      const fin = g.finishRun(st);
      if (!fin.ok) throw new Error(fin.reason);
      golds.push(fin.summary.reward.gold);
    }
    expect(golds[0]).toBe(golds[2]);
    expect(golds[3]).toBeLessThan(golds[0] * 0.3);
    expect(g.p.endless.best).toBe(20);
    // doubling the waves must not double the payout
    clock += DAY;
    g.refreshPeriods();
    const r = g.beginRun('endless', 'endless', 'e-long');
    if (!r.ok) throw new Error();
    const st = new Battle(r.ctx).serialize();
    st.phase = 'lost'; st.wave = 40; st.time = 900; st.stats.kills = 500;
    const fin = g.finishRun(st);
    if (!fin.ok) throw new Error();
    expect(fin.summary.reward.gold).toBeLessThan(golds[0] * 2);
    // a full day of endless pays less than clearing the current campaign levels once
    const campaignDay = LEVELS.slice(0, 6).reduce((a, l) => a + l.rewardGold * 2, 0);
    expect(golds[0] * ENDLESS.fullRewardRunsPerDay).toBeLessThan(campaignDay);
  });
});

describe('cards, loadout and research', () => {
  it('card upgrades need shards and gold, raise the multiplier and stop at the mastery cap', () => {
    const g = mk();
    expect(g.upgradeCard('ice')).toEqual({ ok: false, reason: 'err.locked' });
    expect(g.upgradeCard('archer')).toEqual({ ok: false, reason: 'err.shards' });
    g.p.shards.archer = 5;
    g.p.gold = 0;
    expect(g.upgradeCard('archer')).toEqual({ ok: false, reason: 'err.gold' });
    expect(g.p.shards.archer).toBe(5);
    g.p.gold = 1e9; g.p.shards.archer = 1e5;
    let prev = g.cardInfo('archer').mul;
    for (let i = 0; i < 30; i++) { expect(g.upgradeCard('archer').ok).toBe(true); const m = g.cardInfo('archer').mul; expect(m).toBeGreaterThan(prev); prev = m; }
    expect(g.p.cards.archer.level).toBe(CARD_MAX_LEVEL);
    expect(g.p.cards.archer.mastery).toBe(21);
    expect(cardMultiplier(10, 1e9)).toBeLessThan(6);
    expect(Number.isFinite(cardMultiplier(1e9, 1e9))).toBe(true);
  });
  it('loadout respects size, ownership and uniqueness', () => {
    const g = mk();
    expect(g.setLoadout([]).ok).toBe(false);
    expect(g.setLoadout(['archer', 'ice']).ok).toBe(false);
    expect(g.setLoadout(['archer', 'archer', 'fire']).ok).toBe(true);
    expect(g.p.loadout).toEqual(['archer', 'fire']);
    for (const t of BASE_TOWER_IDS) g.p.cards[t] = { level: 1, mastery: 0 };
    expect(g.setLoadout(BASE_TOWER_IDS.slice(0, 5)).ok).toBe(false);
    g.p.research.loadout = 1;
    expect(g.setLoadout(BASE_TOWER_IDS.slice(0, 5)).ok).toBe(true);
  });
  it('research enforces prerequisites, currencies and caps, and feeds battle modifiers', () => {
    const g = mk();
    g.p.gold = 1e9; g.p.essence = 1e6;
    expect(g.buyResearch('rapid')).toEqual({ ok: false, reason: 'research.need_node' });
    expect(g.buyResearch('alchemy')).toEqual({ ok: false, reason: 'research.need_node' });
    expect(g.buyResearch('m_ice')).toEqual({ ok: false, reason: 'research.need_tower' });
    expect(g.buyResearch('nope').ok).toBe(false);
    for (let i = 0; i < 10; i++) expect(g.buyResearch('weaponry').ok).toBe(true);
    expect(g.buyResearch('weaponry')).toEqual({ ok: false, reason: 'err.max' });
    expect(g.buyResearch('alchemy')).toEqual({ ok: false, reason: 'research.need_campaign' });
    g.p.campaign['1-3'] = { stars: 1, clears: 1 };
    expect(g.buyResearch('alchemy').ok).toBe(true);
    expect(g.buyResearch('m_fire').ok).toBe(true);
    const mods = g.baseMods();
    expect(mods.dmgAll).toBeCloseTo(0.3, 6);
    expect(mods['dmgEl.fire']).toBeGreaterThanOrEqual(0.04);
    const ctx = g.buildContext('1-1', 'campaign', 1);
    expect(ctx.alchemy).toBe(1);
    expect(new Battle({ ...ctx, tutorial: false }).mods.dmgAll).toBeCloseTo(0.3, 6);
    g.p.gold = 0;
    expect(g.buyResearch('fortify')).toEqual({ ok: false, reason: 'err.gold' });
    // every node has a sane, growing price
    for (const n of RESEARCH) expect(n.baseCost * n.growth ** n.max).toBeLessThan(1e9);
  });
});

describe('quests, achievements, login', () => {
  it('daily quests are stable within a day, progress, pay once and reset the next day', () => {
    const g = mk();
    const day1 = g.questList('daily').map((q) => q.def.id);
    expect(day1.length).toBe(3);
    expect(mk(JSON.parse(JSON.stringify(g.p))).questList('daily').map((q) => q.def.id)).toEqual(day1);
    const q = g.questList('daily')[0];
    expect(g.claimQuest('daily', q.def.id)).toEqual({ ok: false, reason: 'err.not_done' });
    g.track(q.def.stat, q.def.goal);
    const gold = g.p.gold, gems = g.p.gems, sh = JSON.stringify(g.p.shards);
    expect(g.claimQuest('daily', q.def.id).ok).toBe(true);
    expect(g.p.gold !== gold || g.p.gems !== gems || JSON.stringify(g.p.shards) !== sh).toBe(true);
    expect(g.claimQuest('daily', q.def.id)).toEqual({ ok: false, reason: 'err.claimed' });
    clock += DAY;
    g.refreshPeriods();
    expect(g.questList('daily').every((x) => x.progress === 0 && !x.claimed)).toBe(true);
    expect(g.questList('weekly').length).toBe(3);
  });
  it('quest pools only reference tracked stats', () => {
    const tracked = ['kills', 'wins', 'merges', 'abilities', 'threeStars', 'boosts', 'hybrids', 'endlessWaves', 'cardUpgrades', 'bosses', 'researches'];
    for (const q of [...DAILY_QUESTS, ...WEEKLY_QUESTS]) expect(tracked, q.id).toContain(q.stat);
    for (const a of ACHIEVEMENTS) { expect(a.tiers.length).toBe(a.rewards.length); expect([...tracked, 'stars', 'endlessBest', 'maxTier', 'towersUnlocked']).toContain(a.stat); }
  });
  it('achievements pay each tier once', () => {
    const g = mk();
    expect(g.claimAchievement('a_kills')).toEqual({ ok: false, reason: 'err.not_done' });
    g.track('kills', 1500);
    const gems = g.p.gems;
    expect(g.claimAchievement('a_kills').ok).toBe(true);
    expect(g.claimAchievement('a_kills').ok).toBe(true);
    expect(g.claimAchievement('a_kills')).toEqual({ ok: false, reason: 'err.not_done' });
    expect(g.p.gems).toBe(gems + 35);
  });
  it('login calendar: one claim per day, streak continues or resets', () => {
    const g = mk();
    expect(g.loginReward().index).toBe(0);
    expect(g.claimLogin().ok).toBe(true);
    expect(g.claimLogin()).toEqual({ ok: false, reason: 'err.claimed' });
    clock += DAY; g.refreshPeriods();
    expect(g.loginReward()).toMatchObject({ index: 1, claimed: false });
    clock += 3 * DAY; g.refreshPeriods();
    expect(g.loginReward().index).toBe(0);
    expect(LOGIN_REWARDS.length).toBe(7);
  });
  it('turning the clock back does not hand out the same day twice', () => {
    const g = mk();
    clock += DAY; g.touchTime(); g.refreshPeriods();
    expect(g.claimLogin().ok).toBe(true);
    clock -= 2 * DAY; // cheater sets the date back
    expect(g.touchTime()).toBe(false);
    g.refreshPeriods();
    expect(g.claimLogin()).toEqual({ ok: false, reason: 'err.claimed' });
    expect(logs).toContain('time_rollback');
    expect(g.p.time.suspect).toBe(1);
  });
});

describe('offline income', () => {
  it('accrues gold while away, capped at 8 hours', () => {
    const g = mk();
    g.p.campaign['1-1'] = { stars: 3, clears: 1 };
    const rate = g.goldPerHour();
    expect(rate).toBe(offlineRate(1));
    clock += 2 * HOUR;
    expect(g.pendingOffline()).toMatchObject({ gold: rate * 2, seconds: 7200, capped: false });
    clock += 30 * HOUR;
    const p = g.pendingOffline();
    expect(p.capped).toBe(true);
    expect(p.gold).toBe(rate * OFFLINE_CAP_HOURS);
    const gold = g.p.gold;
    const c = g.claimOffline();
    expect(c.ok && c.gold).toBe(rate * OFFLINE_CAP_HOURS);
    expect(g.p.gold).toBe(gold + rate * OFFLINE_CAP_HOURS);
    expect(g.pendingOffline().gold).toBe(0);
    expect(g.claimOffline().ok).toBe(false);
    expect(g.doubleOffline().ok).toBe(true);
    expect(g.doubleOffline().ok).toBe(false);
    expect(g.p.gold).toBe(gold + rate * OFFLINE_CAP_HOURS * 2);
  });
  it('active play does not count as offline time', () => {
    const g = mk();
    for (let i = 0; i < 10; i++) { clock += 20000; g.markSeen(); }
    expect(g.pendingOffline().gold).toBe(0);
  });
  it('clock tampering gains nothing: jump forward, claim, go back, repeat', () => {
    const g = mk();
    g.p.campaign['1-1'] = { stars: 3, clears: 1 };
    const rate = g.goldPerHour(), gold = g.p.gold;
    clock += 8 * HOUR; g.touchTime(); g.claimOffline(); // one (fake) 8h jump still pays 8h at most
    clock = T0 + 60000; g.touchTime(); // back to real time
    expect(g.pendingOffline().gold).toBe(0);
    expect(g.claimOffline().ok).toBe(false);
    clock = T0 + 4 * HOUR; g.touchTime(); // real time has not caught up with the fake mark yet
    expect(g.pendingOffline().gold).toBe(0);
    clock = T0 + 9 * HOUR; g.touchTime(); // real time passed the mark by one hour
    expect(g.pendingOffline().gold).toBe(rate);
    expect(g.p.gold).toBe(gold + rate * 8);
  });
});

describe('ads, shop and purchases', () => {
  it('rewarded placements respect daily caps and pay once per view', () => {
    const g = mk();
    const cap = AD_PLACEMENTS.free_shards.daily;
    for (let i = 0; i < cap; i++) expect(g.completeAd('free_shards', `t${i}`).ok).toBe(true);
    expect(g.completeAd('free_shards', 'extra')).toEqual({ ok: false, reason: 'err.ad_limit' });
    expect(Object.values(g.p.shards).reduce((a, b) => a + b, 0)).toBe(cap * 8);
    expect(g.completeAd('nope', 'x').ok).toBe(false);
    clock += DAY; g.refreshPeriods();
    expect(g.adsLeft('free_shards')).toBe(cap);
  });
  it('the between-level offer is rare, capped, optional and never shown to Premium', () => {
    const g = mk();
    expect(g.shouldOffer()).toBe(false);
    g.p.ads.winsSinceOffer = 3;
    expect(g.shouldOffer()).toBe(true);
    g.declineOffer();
    expect(g.shouldOffer()).toBe(false);
    g.p.ads.winsSinceOffer = 3;
    g.p.ads.counts.offer_chest = AD_PLACEMENTS.offer_chest.daily;
    expect(g.shouldOffer()).toBe(false);
    g.p.ads.counts = {};
    g.p.owned.push('premium');
    expect(g.shouldOffer()).toBe(false);
  });
  it('gem shop: prices, daily limits, cosmetics bought once', () => {
    const g = mk();
    expect(g.buyGemItem('shard_chest', 'n1')).toEqual({ ok: false, reason: 'err.gems' });
    g.p.gems = 10000;
    for (let i = 0; i < 5; i++) expect(g.buyGemItem('shard_chest', `n${i}`).ok).toBe(true);
    expect(g.buyGemItem('shard_chest', 'n9')).toEqual({ ok: false, reason: 'err.limit' });
    expect(g.p.gems).toBe(10000 - 250);
    expect(g.buyGemItem('skin_obsidian', 's').ok).toBe(true);
    expect(g.buyGemItem('skin_obsidian', 's2')).toEqual({ ok: false, reason: 'err.owned' });
    expect(g.equipCastle('obsidian').ok).toBe(true);
    expect(g.equipCastle('golden')).toEqual({ ok: false, reason: 'err.locked' });
    expect(g.buyGemItem('nope', 'x').ok).toBe(false);
    for (const i of GEM_SHOP) expect(i.cost).toBeGreaterThan(0);
  });
  it('store purchases are delivered exactly once per transaction', () => {
    const g = mk();
    const gems = g.p.gems;
    expect(g.applyPurchase('gems_small', 'tx-1')).toEqual({ ok: true, granted: true });
    expect(g.applyPurchase('gems_small', 'tx-1')).toEqual({ ok: true, granted: false });
    expect(g.p.gems).toBe(gems + 80);
    expect(g.applyPurchase('gems_small', 'tx-2')).toEqual({ ok: true, granted: true });
    expect(g.p.gems).toBe(gems + 160);
    expect(g.applyPurchase('premium', 'tx-3')).toEqual({ ok: true, granted: true });
    expect(g.applyPurchase('premium', 'tx-4')).toEqual({ ok: true, granted: false });
    expect(g.isPremium()).toBe(true);
    expect(g.p.cosmetics.owned).toContain('royal');
    expect(g.applyPurchase('nope', 'tx').ok).toBe(false);
    expect(g.applyPurchase('gems_small', '').ok).toBe(false);
  });
  it('nothing sold for money or gems gives exclusive battle power', () => {
    // Premium / purchases never appear in battle modifiers; cosmetics are purely visual.
    const free = mk(), paid = mk();
    for (const p of IAP_PRODUCTS) paid.applyPurchase(p.id, `tx-${p.id}`);
    paid.buyGemItem('skin_obsidian', 'x');
    expect(paid.baseMods()).toEqual(free.baseMods());
    const a = free.buildContext('1-1', 'campaign', 1), b = paid.buildContext('1-1', 'campaign', 1);
    expect(b.cardMul).toEqual(a.cardMul);
    expect(b.loadout).toEqual(a.loadout);
    for (const p of IAP_PRODUCTS) expect(Object.keys(p.reward).every((k) => ['gems', 'gold', 'randomShards', 'cosmetic'].includes(k))).toBe(true);
    // everything a gem can buy is also earned by playing (gems, gold, shards, essence all drop for free)
    expect(REVIVE_GEMS).toBeLessThanOrEqual(newProfile('x', T0).gems);
  });
});

describe('events and progress score', () => {
  it('there is always exactly one calendar event with a sane window', () => {
    for (let d = 0; d < 21; d++) {
      const ev = eventsAt(T0 + d * DAY);
      expect(ev.length).toBe(1);
      expect(ev[0].endsAt).toBeGreaterThan(T0 + d * DAY);
      expect(ev[0].endsAt - (T0 + d * DAY)).toBeLessThanOrEqual(6 * DAY);
      for (const k of Object.keys(ev[0].mods ?? {})) expect(k.startsWith('dmgEl.')).toBe(true);
    }
    expect(eventsAt(new Date(2026, 10, 14, 12).getTime())[0].id).toBe('goldrush');
  });
  it('progress score grows with progress', () => {
    const a = newProfile('a', T0), b = newProfile('b', T0);
    b.campaign['1-1'] = { stars: 3, clears: 1 };
    expect(progressScore(b)).toBeGreaterThan(progressScore(a));
    expect(TOWERS.archer).toBeTruthy();
  });
});
