import { computeTower } from '../core/stats';
import { BRANCH_TIER, emptyMods } from '../core/types';
import { ENEMIES } from '../data/enemies';
import { ACHIEVEMENTS, AD_PLACEMENTS, CARD_MAX_LEVEL, GEM_SHOP, IAP_PRODUCTS, LOGIN_REWARDS, OFFLINE_CAP_HOURS, PREMIUM_BENEFITS, RESEARCH } from '../data/meta';
import { BASE_TOWER_IDS, RECIPES, TOWERS } from '../data/towers';
import { ABILITIES, ENDLESS, LEVELS, LEVEL_BY_ID, WORLDS } from '../data/worlds';
import { progressScore, unlockedAbilities } from '../meta/profile';
import { castleThumb, enemyThumb, towerThumb } from '../render/thumb';
import { randomId } from '../services/hash';
import { LANGS, t } from '../services/i18n';
import { cloudConfigured, isOnline } from '../services/net';
import type { Lang } from '../services/settings';
import type { App } from './app';
import { ABILITY_ICON, EL_ICON, ROMAN, describeTower } from './describe';
import { add, btn, clear, fmtNum, fmtStat, fmtTime, h } from './dom';

const TABS: [string, string, string][] = [['menu', '🏰', 'nav.home'], ['towers', '🗼', 'nav.towers'], ['research', '⚗️', 'nav.research'], ['quests', '📜', 'nav.quests'], ['shop', '🛒', 'nav.shop']];

function frame(app: App, current: string, body: HTMLElement): HTMLElement {
  const g = app.game;
  const badge = (id: string) => {
    const n = id === 'quests' ? g.claimableCount() : id === 'towers' ? BASE_TOWER_IDS.filter((x) => g.cardInfo(x).canUpgrade).length : id === 'research' ? RESEARCH.filter((r) => g.researchInfo(r.id).canBuy).length : 0;
    return n > 0 ? h('i.badge', null, n) : null;
  };
  return h('div.page', null,
    h('div.topbar', null,
      h('div.cur', null, '🪙 ', h('b', { 'data-cur': 'gold' }, fmtNum(g.p.gold))),
      h('div.cur', null, '💎 ', h('b', { 'data-cur': 'gems' }, fmtNum(g.p.gems))),
      h('div.cur', null, '🔮 ', h('b', { 'data-cur': 'essence' }, fmtNum(g.p.essence))),
      btn('⚙️', () => app.nav('settings'), 'icon', { id: 'btn-settings', 'aria-label': t('nav.settings') })),
    h('div.scroll', null, body),
    h('div.tabs', null, TABS.map(([id, icon, key]) => h(`button.tab${current === id || (id === 'menu' && current === 'map') ? '.on' : ''}`, { type: 'button', id: `tab-${id}`, onclick: () => app.nav(id) }, h('span', null, icon), h('small', null, t(key)), badge(id)))));
}

// ---------------------------------------------------------------- home
function menu(app: App): HTMLElement {
  const g = app.game, next = LEVEL_BY_ID[g.nextLevelId()], allDone = g.clearedCount() >= LEVELS.length;
  const world = WORLDS[next.world - 1];
  const ev = g.events();
  return h('div.home', { style: { '--sky-top': world.palette.skyTop, '--sky-bottom': world.palette.skyBottom } as any },
    h('div.logo', null, h('span', null, 'Rune'), h('b', null, 'Bastion')),
    h('img.castle', { src: castleThumb(world, g.p.cosmetics.castle), alt: '' }),
    ev.map((e) => h('div.event', null, '🎉 ', h('b', null, t(`event.${e.id.startsWith('week_') ? 'week' : e.id}.name`, { el: e.element ? t(`el.${e.element}`) : '' })), ' ', h('small', null, t(`event.${e.id.startsWith('week_') ? 'week' : e.id}.desc`, { el: e.element ? t(`el.${e.element}`) : '' })), h('small.muted', null, ' · ', fmtTime((e.endsAt - g.effectiveNow()) / 1000)))),
    btn([h('span', null, allDone ? t('menu.replay') : t('menu.play')), h('small', null, `${t(`world.${world.key}.name`)} · ${next.id}`)], () => levelDialog(app, next.id), 'primary huge', { id: 'btn-play' }),
    h('div.row', null,
      btn(['🗺️ ', t('menu.campaign')], () => app.nav('map'), 'wide', { id: 'btn-map' }),
      btn(['♾️ ', t('menu.endless'), g.endlessUnlocked() ? null : ' 🔒'], () => (g.endlessUnlocked() ? endlessDialog(app) : app.toast(t('menu.endless_locked', { level: ENDLESS.unlockLevel }), 'warn')), 'wide', { id: 'btn-endless' })),
    h('div.idle', null, '🌙 ', t('menu.idle', { rate: fmtNum(g.goldPerHour()), hours: OFFLINE_CAP_HOURS })));
}

// ---------------------------------------------------------------- campaign map
function map(app: App, params: { world?: number } | null): HTMLElement {
  const g = app.game;
  const cur = params?.world ?? LEVEL_BY_ID[g.nextLevelId()].world;
  const w = WORLDS[cur - 1];
  const levels = LEVELS.filter((l) => l.world === cur);
  const unlocked = g.isLevelUnlocked(`${cur}-1`);
  return h('div.map', null,
    h('div.world-tabs', null, WORLDS.map((x) => h(`button.wtab${x.id === cur ? '.on' : ''}`, { type: 'button', 'data-world': x.id, onclick: () => app.nav('map', { world: x.id }) }, g.isLevelUnlocked(`${x.id}-1`) ? String(x.id) : '🔒'))),
    h('div.world-card', { style: { background: `linear-gradient(${w.palette.skyTop}, ${w.palette.skyBottom})` } },
      h('h2', null, t(`world.${w.key}.name`)), h('p', null, t(`world.${w.key}.story`)),
      h('div.boss-line', null, h('img', { src: enemyThumb(ENEMIES[w.boss]), alt: '' }), h('span', null, t('map.boss'), ': ', h('b', null, t(`enemy.${w.boss}.name`))))),
    unlocked ? null : h('p.locked-note', null, '🔒 ', t('map.world_locked')),
    h('div.levels', null, levels.map((l) => {
      const open = g.isLevelUnlocked(l.id), done = g.p.campaign[l.id];
      return h(`button.level${open ? '' : '.locked'}${done ? '.done' : ''}${l.boss ? '.boss' : ''}`, { type: 'button', 'data-level': l.id, onclick: () => (open ? levelDialog(app, l.id) : app.toast(t('map.level_locked'), 'warn')) },
        h('b', null, l.boss ? '👑' : l.id), h('span.stars-s', null, open ? [1, 2, 3].map((i) => h(`i${done && i <= done.stars ? '.on' : ''}`, null, '★')) : '🔒'));
    })));
}

function loadoutEditor(app: App, onChange: () => void): HTMLElement {
  const g = app.game, size = g.loadoutSize();
  const box = h('div.loadout');
  const render = () => {
    clear(box);
    box.append(h('div.sub', null, t('prep.loadout', { n: g.p.loadout.length, max: size })));
    box.append(h('div.pick', null, BASE_TOWER_IDS.filter((id) => g.p.cards[id]).map((id) => {
      const on = g.p.loadout.includes(id);
      return h(`button.pick-card${on ? '.on' : ''}`, { type: 'button', 'data-pick': id, onclick: () => {
        const next = on ? g.p.loadout.filter((x) => x !== id) : [...g.p.loadout, id];
        if (!on && next.length > size) { app.toast(t('err.loadout_size'), 'warn'); return; }
        const r = g.setLoadout(next);
        if (!r.ok) app.toast(t(r.reason), 'warn');
        render(); onChange();
      } }, h('img', { src: towerThumb(TOWERS[id]), alt: '' }), h('small', null, t(`tower.${id}.name`)), h('i', null, EL_ICON[TOWERS[id].element]));
    })));
  };
  render();
  return box;
}

function levelDialog(app: App, levelId: string): void {
  const l = LEVEL_BY_ID[levelId], g = app.game;
  if (!g.isLevelUnlocked(levelId)) { app.toast(t('map.level_locked'), 'warn'); return; }
  const foes = [...l.pool, ...(l.boss ? [l.boss] : [])];
  const close = app.modal(h('div.dialog', null,
    h('h2', null, `${t(`world.${WORLDS[l.world - 1].key}.name`)} ${l.id}`),
    h('div.chips', null, h('span.chip', null, '🌊 ', t('prep.waves', { n: l.waves })), h('span.chip', null, '🪙 ', fmtNum(Math.round(l.rewardGold * (g.p.campaign[l.id] ? 0.6 : 2)))), l.boss ? h('span.chip.r-epic', null, '👑 ', t('map.boss')) : null),
    h('div.sub', null, t('prep.enemies')),
    h('div.foes', null, foes.map((id) => h('div.foe', { 'data-foe': id, onclick: () => app.toast(`${t(`enemy.${id}.name`)}: ${t(`enemy.${id}.desc`)}`) }, h('img', { src: enemyThumb(ENEMIES[id]), alt: '' }), h('small', null, t(`enemy.${id}.name`))))),
    loadoutEditor(app, () => undefined),
    btn(t('prep.start'), () => { close(); app.startBattle(levelId, 'campaign'); }, 'primary wide', { id: 'btn-start-level' })));
}

function endlessDialog(app: App): void {
  const g = app.game;
  const left = Math.max(0, ENDLESS.fullRewardRunsPerDay - g.p.endless.runs);
  const close = app.modal(h('div.dialog', null,
    h('h2', null, '♾️ ', t('menu.endless')),
    h('p', null, t('endless.desc', { n: ENDLESS.bossEvery })),
    h('div.chips', null, h('span.chip', null, t('endless.record', { n: g.p.endless.best })), h('span.chip', null, t('endless.full_runs', { n: left }))),
    loadoutEditor(app, () => undefined),
    btn(t('prep.start'), () => { close(); app.startBattle('endless', 'endless'); }, 'primary wide', { id: 'btn-start-endless' })));
}

// ---------------------------------------------------------------- towers
function towers(app: App): HTMLElement {
  const g = app.game;
  return h('div.pad', null,
    h('h2', null, t('towers.title')),
    h('p.muted', null, t('towers.hint')),
    h('div.grid', null, BASE_TOWER_IDS.map((id) => {
      const d = TOWERS[id], c = g.cardInfo(id);
      if (!c.unlocked) return h('button.tcard.locked', { type: 'button', 'data-tower': id, onclick: () => app.toast(t('towers.locked', { level: d.unlockLevel ?? '' }), 'warn') }, h('img', { src: towerThumb(d), alt: '' }), h('b', null, t(`tower.${id}.name`)), h('small', null, '🔒 ', t('towers.unlock_at', { level: d.unlockLevel ?? '' })));
      return h(`button.tcard.r-${d.rarity}${c.canUpgrade ? '.ready' : ''}`, { type: 'button', 'data-tower': id, onclick: () => towerDialog(app, id) },
        h('img', { src: towerThumb(d), alt: '' }), h('b', null, t(`tower.${id}.name`)),
        h('small', null, c.maxed ? `${t('ui.lvl')} ${CARD_MAX_LEVEL} · ✦${c.mastery}` : `${t('ui.lvl')} ${c.level}`),
        h('div.bar.thin', null, h('div.bar-fill.shard', { style: { width: `${Math.min(100, (c.shards / Math.max(1, c.needShards)) * 100)}%` } })),
        h('small', null, `🧩 ${c.shards}/${c.needShards}`), g.p.loadout.includes(id) ? h('i.in', null, '✓') : null);
    })),
    h('h2', null, t('towers.hybrids')),
    h('p.muted', null, t('towers.hybrids_hint', { n: g.alchemyLevel() })),
    h('div.recipes', null, RECIPES.map((r) => {
      const open = g.alchemyLevel() >= r.alchemy;
      return h(`div.recipe${open ? '' : '.locked'}`, null,
        h('img', { src: towerThumb(TOWERS[r.a], 2), alt: '' }), h('span', null, '+'), h('img', { src: towerThumb(TOWERS[r.b], 2), alt: '' }), h('span', null, '→'),
        r.results.map((res) => h('button.res', { type: 'button', 'data-hybrid': res, onclick: () => hybridDialog(app, res) }, h('img', { src: towerThumb(TOWERS[res], 3), alt: '' }), h('small', null, open ? t(`tower.${res}.name`) : `🔒 ${t('towers.alchemy_need', { n: r.alchemy })}`))));
    })));
}

function statRow(def: string, tier: number, branch: string | null, mul: number): HTMLElement {
  const c = computeTower(def, tier, 0, branch, mul, emptyMods());
  return h('div.stats.wrap', null, h('span', null, '⚔️ ', fmtStat(c.damage)), h('span', null, '⏱ ', fmtStat(c.rate)), h('span', null, '🎯 ', fmtStat(c.range)), h('span.dps', null, 'DPS ', fmtStat(c.dps)));
}

function towerDialog(app: App, id: string): void {
  const g = app.game, d = TOWERS[id];
  const body = h('div.dialog');
  const render = () => {
    const c = g.cardInfo(id);
    clear(body);
    body.append(
      h('div.panel-head', null, h('img.thumb.lg', { src: towerThumb(d), alt: '' }), h('div.grow', null,
        h('h2', null, t(`tower.${id}.name`)),
        h('div.chips', null, h(`span.chip.r-${d.rarity}`, null, t(`rarity.${d.rarity}`)), h('span.chip', null, EL_ICON[d.element], ' ', t(`el.${d.element}`)), h('span.chip', null, t(`attack.${d.attack.kind}`))),
        h('p.muted', null, t(`tower.${id}.desc`)))),
      h('div.sub', null, c.maxed ? t('towers.mastery', { n: c.mastery }) : `${t('ui.lvl')} ${c.level}/${CARD_MAX_LEVEL}`, ' · ', t('towers.power', { pct: Math.round(c.mul * 100) })),
      statRow(id, 1, null, c.mul),
      h('div.fx-list', null, describeTower(computeTower(id, 1, 0, null, c.mul, emptyMods())).map((l) => h('span', null, l))),
      btn([h('span', null, c.maxed ? t('towers.upgrade_mastery') : t('ui.upgrade')), h('small', null, `🧩 ${c.shards}/${c.needShards} · 🪙 ${fmtNum(c.needGold)} · ${Math.round(c.mul * 100)}% → ${Math.round(c.nextMul * 100)}%`)], () => {
        const r = g.upgradeCard(id);
        if (r.ok) { app.audio.play('upgrade'); render(); app.refresh(); } else app.toast(t(r.reason), 'warn');
      }, 'primary wide', { disabled: !c.canUpgrade, id: 'btn-card-upgrade' }),
      h('div.sub', null, t('towers.evolutions', { tier: ROMAN[BRANCH_TIER] })),
      h('div.branches', null, d.branches!.map((br) => h('div.branch', null, h('img.thumb', { src: towerThumb(d, BRANCH_TIER, br.id), alt: '' }), h('div.grow', null, h('b', null, t(`branch.${br.id}.name`)), h('p.muted', null, t(`branch.${br.id}.desc`)), statRow(id, BRANCH_TIER, br.id, c.mul))))),
      h('div.sub', null, t('towers.tiers')),
      h('div.tiers', null, [1, 2, 3, 4, 5].map((tier) => h('div.tier-cell', null, h('img', { src: towerThumb(d, tier, tier >= BRANCH_TIER ? d.branches![0].id : null), alt: '' }), h('small', null, ROMAN[tier])))));
  };
  render();
  app.modal(body, { cls: 'sheet' });
}

function hybridDialog(app: App, id: string): void {
  const d = TOWERS[id], r = RECIPES.find((x) => x.results.includes(id))!;
  const c = computeTower(id, 3, 0, null, 1, emptyMods());
  app.modal(h('div.dialog', null,
    h('div.panel-head', null, h('img.thumb.lg', { src: towerThumb(d, 3), alt: '' }), h('div.grow', null, h('h2', null, t(`tower.${id}.name`)),
      h('div.chips', null, h(`span.chip.r-${d.rarity}`, null, t(`rarity.${d.rarity}`)), h('span.chip', null, EL_ICON[d.element], EL_ICON[d.element2!]), h('span.chip', null, t(`attack.${d.attack.kind}`))),
      h('p.muted', null, t(`tower.${id}.desc`)))),
    h('div.sub', null, t('towers.recipe')),
    h('p', null, `${t(`tower.${r.a}.name`)} ${ROMAN[2]} + ${t(`tower.${r.b}.name`)} ${ROMAN[2]} → ${t(`tower.${id}.name`)} ${ROMAN[3]}`),
    statRow(id, 3, null, 1),
    h('div.fx-list', null, describeTower(c).map((l) => h('span', null, l)))));
}

// ---------------------------------------------------------------- research
function research(app: App): HTMLElement {
  const g = app.game;
  const rows = Math.max(...RESEARCH.map((r) => r.row)) + 1;
  const grid = h('div.tree');
  for (let row = 0; row < rows; row++) for (let col = 0; col < 6; col++) {
    const n = RESEARCH.find((r) => r.row === row && r.col === col);
    if (!n) { grid.append(h('div.node.empty')); continue; }
    const info = g.researchInfo(n.id);
    grid.append(h(`button.node${info.locked ? '.locked' : ''}${info.maxed ? '.maxed' : ''}${info.canBuy ? '.ready' : ''}`, { type: 'button', 'data-node': n.id, onclick: () => researchDialog(app, n.id) },
      h('span', null, n.icon), h('small', null, `${info.level}/${n.max}`)));
  }
  return h('div.pad', null, h('h2', null, t('research.title')), h('p.muted', null, t('research.hint')), grid);
}
function researchDialog(app: App, id: string): void {
  const g = app.game;
  const body = h('div.dialog');
  const render = () => {
    const info = g.researchInfo(id), n = info.node;
    clear(body);
    add(body,
      h('h2', null, n.icon, ' ', t(`research.${id}.name`)), h('p', null, t(`research.${id}.desc`)),
      h('div.sub', null, `${t('ui.lvl')} ${info.level}/${n.max}`),
      info.locked ? h('p.locked-note', null, '🔒 ', t(info.locked, { node: n.requires ? t(`research.${n.requires.id}.name`) : '', level: n.requires?.level ?? '', el: n.element ? t(`el.${n.element}`) : '' })) : null,
      btn([h('span', null, info.maxed ? t('ui.max') : t('research.buy')), info.maxed ? null : h('small', null, `${n.currency === 'gold' ? '🪙' : '🔮'} ${fmtNum(info.cost)}`)], () => {
        const r = g.buyResearch(id);
        if (r.ok) { app.audio.play('upgrade'); render(); app.refresh(); } else app.toast(t(r.reason, { node: n.requires ? t(`research.${n.requires.id}.name`) : '', level: n.requires?.level ?? '' }), 'warn');
      }, 'primary wide', { disabled: !info.canBuy, id: 'btn-research-buy' }));
  };
  render();
  app.modal(body);
}

// ---------------------------------------------------------------- quests
function quests(app: App, params: { tab?: string } | null): HTMLElement {
  const g = app.game, tab = params?.tab ?? 'daily';
  const tabs = h('div.seg', null, ['daily', 'weekly', 'ach', 'login'].map((k) => h(`button${tab === k ? '.on' : ''}`, { type: 'button', 'data-qtab': k, onclick: () => app.nav('quests', { tab: k }) }, t(`quests.${k}`))));
  const list = h('div.list');
  const claimBtn = (done: boolean, claimed: boolean, fn: () => void, id: string) => claimed ? h('span.done', null, '✓') : btn(t('ui.claim'), fn, done ? 'primary small' : 'ghost small', { disabled: !done, 'data-claim': id });
  if (tab === 'daily' || tab === 'weekly') {
    for (const q of g.questList(tab)) {
      list.append(h(`div.quest${q.claimed ? '.claimed' : ''}`, null,
        h('div.grow', null, h('b', null, t(`quest.${q.def.stat}`, { n: q.def.goal })), h('div.bar.thin', null, h('div.bar-fill', { style: { width: `${(q.progress / q.def.goal) * 100}%` } })), h('small', null, `${fmtNum(q.progress)}/${fmtNum(q.def.goal)}`), h('div.rewards.s', null, app.rewardNodes(q.def.reward))),
        claimBtn(q.done, q.claimed, () => { const r = g.claimQuest(tab, q.def.id); if (r.ok) { app.rewardPopup(t('quests.reward'), r.reward); app.refresh(); } else app.toast(t(r.reason), 'warn'); }, q.def.id)));
    }
    if (!list.children.length) list.append(h('p.muted', null, t('quests.none')));
  } else if (tab === 'ach') {
    for (const a of g.achievementList()) {
      const goal = a.next ?? a.def.tiers[a.def.tiers.length - 1], all = a.next === null;
      list.append(h(`div.quest${all ? '.claimed' : ''}`, null,
        h('div.grow', null, h('b', null, t(`ach.${a.def.stat}`, { n: fmtNum(goal) })), h('small.muted', null, ` ${a.claimed}/${a.def.tiers.length}`), h('div.bar.thin', null, h('div.bar-fill', { style: { width: `${Math.min(100, (a.value / goal) * 100)}%` } })), h('small', null, `${fmtNum(Math.min(a.value, goal))}/${fmtNum(goal)}`), all ? null : h('div.rewards.s', null, app.rewardNodes(a.def.rewards[a.claimed]))),
        claimBtn(a.claimable, all, () => { const r = g.claimAchievement(a.def.id); if (r.ok) { app.rewardPopup(t('quests.reward'), r.reward); app.refresh(); } else app.toast(t(r.reason), 'warn'); }, a.def.id)));
    }
  } else {
    const l = g.loginReward();
    list.append(h('p.muted', null, t('login.hint')), h('div.calendar', null, LOGIN_REWARDS.map((r, i) => h(`div.day${i === l.index ? '.today' : ''}${i < l.index || (i === l.index && l.claimed) ? '.got' : ''}`, null, h('small', null, t('login.day', { n: i + 1 })), h('div.rewards.s', null, app.rewardNodes(r))))),
      btn(l.claimed ? t('login.claimed') : t('ui.claim'), () => { const r = g.claimLogin(); if (r.ok) { app.rewardPopup(t('login.title'), r.reward); app.refresh(); } }, 'primary wide', { disabled: l.claimed, id: 'btn-login-claim' }));
  }
  return h('div.pad', null, h('h2', null, t('quests.title')), tabs, list);
}

// ---------------------------------------------------------------- shop
function shop(app: App): HTMLElement {
  const g = app.game, iap = app.iap;
  const buyIap = async (id: string) => {
    if (!iap.available) { app.toast(t(isOnline() ? 'shop.store_unavailable' : 'shop.need_internet'), 'warn'); return; }
    const r = await iap.buy(id);
    if (r.ok) { app.rewardPopup(t('shop.thanks'), IAP_PRODUCTS.find((p) => p.id === id)!.reward); app.refresh(); }
    else if (r.reason !== 'cancelled') app.toast(t(`shop.err.${r.reason}`), r.reason === 'pending' ? 'warn' : 'error');
  };
  const premium = IAP_PRODUCTS.find((p) => p.premium)!;
  const adCard = (pl: string, icon: string) => {
    const left = g.adsLeft(pl), def = AD_PLACEMENTS[pl];
    const reward = def.goldHours ? { gold: g.goldPerHour() * def.goldHours } : def.reward!;
    return h('div.item', null, h('span.big', null, icon), h('b', null, t(`shop.${pl}`)), h('div.rewards.s', null, app.rewardNodes(reward)),
      btn(['🎬 ', t('ui.free'), h('small', null, ` ${left}/${def.daily}`)], async () => { const r = await app.rewarded(pl); if (r.ok && r.reward) { app.rewardPopup(t('shop.thanks'), r.reward); app.refresh(); } }, 'primary small', { disabled: left <= 0, 'data-ad': pl }));
  };
  return h('div.pad', null,
    h('h2', null, t('shop.title')),
    !cloudConfigured() && !iap.available ? h('p.muted', null, t('shop.offline_note')) : null,
    h(`div.premium${g.isPremium() ? '.owned' : ''}`, null,
      h('h3', null, '👑 ', t('iap.premium.name')),
      h('ul', null, h('li', null, t('premium.b1', { pct: Math.round(PREMIUM_BENEFITS.goldBonus * 100) })), h('li', null, t('premium.b2')), h('li', null, t('premium.b3')), h('li', null, t('premium.b4'))),
      h('p.muted', null, t('premium.fair')),
      g.isPremium() ? h('span.done', null, '✓ ', t('shop.owned')) : btn(iap.priceOf(premium.id), () => void buyIap(premium.id), 'primary wide', { 'data-iap': premium.id })),
    h('h3', null, t('shop.free')),
    h('div.items', null, adCard('free_gold', '🪙'), adCard('free_shards', '🧩')),
    h('h3', null, t('shop.gems')),
    h('div.items', null, IAP_PRODUCTS.filter((p) => !p.premium).map((p) => {
      const owned = p.once && g.p.owned.includes(p.id);
      return h(`div.item${owned ? '.owned' : ''}`, null, h('span.big', null, p.once ? '🎁' : '💎'), h('b', null, t(`iap.${p.id}.name`)), h('div.rewards.s', null, app.rewardNodes(p.reward)),
        owned ? h('span.done', null, '✓ ', t('shop.owned')) : btn(iap.priceOf(p.id), () => void buyIap(p.id), 'primary small', { 'data-iap': p.id }));
    })),
    h('h3', null, t('shop.resources')),
    h('div.items', null, GEM_SHOP.filter((i) => !i.cosmetic).map((i) => {
      const info = g.gemItemInfo(i.id);
      const reward = i.goldHours ? { gold: info.gold } : i.reward!;
      return h('div.item', null, h('span.big', null, i.goldHours ? '🪙' : i.reward?.essence ? '🔮' : '🧩'), h('b', null, t(`gem.${i.id}`)), h('div.rewards.s', null, app.rewardNodes(reward)),
        btn([`💎 ${i.cost}`, Number.isFinite(info.left) ? h('small', null, ` ${info.left}/${i.dailyLimit}`) : null], () => { const r = g.buyGemItem(i.id, randomId(6)); if (r.ok) { app.rewardPopup(t('shop.thanks'), r.reward); app.refresh(); } else app.toast(t(r.reason), 'warn'); }, 'accent small', { disabled: !info.canBuy, 'data-gem': i.id }));
    })),
    h('h3', null, t('shop.cosmetics')),
    h('p.muted', null, t('shop.cosmetics_hint')),
    h('div.items', null, ['default', 'obsidian', 'golden', 'crystal', 'royal'].map((cid) => {
      const owned = g.p.cosmetics.owned.includes(cid), on = g.p.cosmetics.castle === cid;
      const item = GEM_SHOP.find((i) => i.cosmetic === cid);
      return h(`div.item${on ? '.equipped' : ''}`, null, h('img.skin', { src: castleThumb(WORLDS[0], cid), alt: '' }), h('b', null, t(`cos.${cid}`)), h('small.muted', null, t(`cos.${cid}.how`)),
        owned ? btn(on ? t('shop.equipped') : t('shop.equip'), () => { g.equipCastle(cid); app.refresh(); }, on ? 'ghost small' : 'primary small', { disabled: on, 'data-skin': cid })
          : item ? btn(`💎 ${item.cost}`, () => { const r = g.buyGemItem(item.id, randomId(6)); if (r.ok) { app.audio.play('reward'); app.refresh(); } else app.toast(t(r.reason), 'warn'); }, 'accent small', { disabled: !g.gemItemInfo(item.id).canBuy, 'data-skin': cid }) : h('span.muted', null, '🔒'));
    })),
    btn(t('shop.restore'), async () => { const n = await iap.recover(); app.toast(t(n > 0 ? 'shop.restored' : 'shop.nothing_restore')); app.refresh(); }, 'ghost wide', { id: 'btn-restore' }));
}

// ---------------------------------------------------------------- settings
function settings(app: App): HTMLElement {
  const s = app.settings, g = app.game, cloud = app.cloud;
  const apply = () => { app.applySettings(); };
  const slider = (key: 'music' | 'sfx' | 'fx', label: string) => h('label.set', null, h('span', null, label), h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s[key]), id: `set-${key}`, oninput: (e: Event) => { s[key] = Number((e.target as HTMLInputElement).value); apply(); } }));
  const toggle = (key: 'vibration' | 'shake', label: string) => h('label.set', null, h('span', null, label), h('input', { type: 'checkbox', checked: s[key], id: `set-${key}`, onchange: (e: Event) => { s[key] = (e.target as HTMLInputElement).checked; apply(); } }));
  const seg = <T extends string | number>(cur: T, opts: [T, string][], set: (v: T) => void, id: string) => h('div.seg', { id }, opts.map(([v, label]) => h(`button${cur === v ? '.on' : ''}`, { type: 'button', 'data-v': String(v), onclick: () => { set(v); apply(); app.refresh(); } }, label)));
  const auth = cloud.auth;
  const acct = h('div.card');
  acct.append(h('h3', null, t('acct.title')));
  if (!cloud.enabled) acct.append(h('p.muted', null, t('acct.disabled')));
  else {
    acct.append(h('p', null, auth ? (auth.kind === 'account' ? `✅ ${auth.email ?? t('acct.linked')}` : `👤 ${t('acct.guest')}`) : `👤 ${t('acct.guest_local')}`),
      h('p.muted', null, t(`cloud.status.${cloud.lastStatus}`), auth?.lastSyncAt ? ` · ${new Date(auth.lastSyncAt).toLocaleString()}` : ''),
      btn(['☁️ ', t('acct.sync')], () => void app.syncCloud(true), 'primary wide', { id: 'btn-sync' }));
    if (!auth || auth.kind === 'guest') acct.append(btn(t('acct.create'), () => accountDialog(app, 'register'), 'wide', { id: 'btn-register' }));
    acct.append(btn(t('acct.login'), () => accountDialog(app, 'login'), 'ghost wide', { id: 'btn-login' }));
    acct.append(h('div.row', null,
      btn(['G ', auth?.links.google ? '✓' : t('acct.link')], () => void linkProvider(app, 'google'), 'small', { disabled: !!auth?.links.google, id: 'btn-google' }),
      btn([' ', auth?.links.apple ? '✓' : t('acct.link')], () => void linkProvider(app, 'apple'), 'small', { disabled: !!auth?.links.apple, id: 'btn-apple' })));
    if (auth) acct.append(btn(t('acct.cloud_history'), () => void cloudHistoryDialog(app), 'ghost wide', { id: 'btn-cloud-history' }));
    if (app.modified) acct.append(h('p.locked-note', null, '⚠️ ', t('acct.restricted')));
  }
  acct.append(btn(t('acct.backups'), () => backupsDialog(app), 'ghost wide', { id: 'btn-backups' }),
    btn(t('acct.delete_local'), async () => {
      if (!(await app.confirm(t('acct.delete_local'), t('acct.delete_local_text'), t('ui.delete'), t('ui.cancel')))) return;
      app.saveSvc.wipe(); app.cloud.logoutLocal(); location.reload();
    }, 'danger wide', { id: 'btn-delete-local' }));
  if (auth) acct.append(btn(t('acct.delete_cloud'), async () => {
    if (!(await app.confirm(t('acct.delete_cloud'), t('acct.delete_cloud_text'), t('ui.delete'), t('ui.cancel')))) return;
    const r = await cloud.deleteAccount();
    app.toast(t(r.ok ? 'acct.deleted' : r.reason!), r.ok ? 'good' : 'error');
    app.refresh();
  }, 'danger wide', { id: 'btn-delete-cloud' }));

  return h('div.pad', null,
    h('h2', null, t('nav.settings')),
    h('div.card', null,
      h('label.set', null, h('span', null, t('set.lang')), h('select', { id: 'set-lang', onchange: (e: Event) => { s.lang = (e.target as HTMLSelectElement).value as Lang; apply(); app.refresh(); } }, LANGS.map((l) => h('option', { value: l.id, ...(l.id === s.lang ? { selected: 'selected' } : {}) }, l.name)))),
      slider('music', t('set.music')), slider('sfx', t('set.sfx')), toggle('vibration', t('set.vibration')), toggle('shake', t('set.shake')), slider('fx', t('set.fx')),
      h('div.set', null, h('span', null, t('set.fps')), seg(s.fps, [[30, '30'], [60, '60']], (v) => (s.fps = v), 'set-fps')),
      h('div.set', null, h('span', null, t('set.quality')), seg(s.quality, [['auto', t('set.q.auto')], ['low', t('set.q.low')], ['medium', t('set.q.medium')], ['high', t('set.q.high')]], (v) => (s.quality = v), 'set-quality'))),
    acct,
    h('div.card', null, h('h3', null, t('support.title')), h('p.muted', null, t('support.hint')), btn(t('support.open'), () => supportDialog(app), 'wide', { id: 'btn-support' }),
      btn(t('privacy.title'), () => app.modal(h('div.dialog', null, h('h2', null, t('privacy.title')), h('p', null, t('privacy.text')), app.config.privacyUrl ? h('p.muted', null, app.config.privacyUrl) : null), { cls: 'sheet' }), 'ghost wide', { id: 'btn-privacy' })),
    h('p.muted.center', null, `Rune Bastion v${app.config.version} · ${t('set.profile')} ${g.p.id.slice(0, 8)} · ${t('set.playtime')} ${fmtTime(g.p.playtime)}`));
}

function accountDialog(app: App, mode: 'register' | 'login'): void {
  const email = h('input', { type: 'email', placeholder: t('acct.email'), autocomplete: 'email', id: 'in-email' }) as HTMLInputElement;
  const pass = h('input', { type: 'password', placeholder: t('acct.password'), autocomplete: mode === 'register' ? 'new-password' : 'current-password', id: 'in-pass' }) as HTMLInputElement;
  const submit = btn(t(mode === 'register' ? 'acct.create' : 'acct.login'), async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.value) || pass.value.length < 8) { app.toast(t('cloud.err.invalid'), 'warn'); return; }
    submit.disabled = true;
    if (mode === 'register') {
      const r = await app.cloud.register(email.value, pass.value);
      submit.disabled = false;
      if (!r.ok) { app.toast(t(r.reason!), 'error'); return; }
      close(); app.toast(t('acct.created'), 'good');
      await app.syncCloud(true);
    } else {
      const r = await app.cloud.login({ email: email.value, password: pass.value });
      submit.disabled = false;
      if (!r.ok) { app.toast(t(r.reason!), 'error'); return; }
      close();
      await chooseProgress(app, r.remote ?? null);
    }
    app.refresh();
  }, 'primary wide', { id: 'btn-acct-submit' });
  const close = app.modal(h('div.dialog', null, h('h2', null, t(mode === 'register' ? 'acct.create' : 'acct.login')), h('p.muted', null, t(mode === 'register' ? 'acct.create_hint' : 'acct.login_hint')), email, pass, submit));
}

/** After signing in on a device that already has progress: the player decides which one to keep. */
async function chooseProgress(app: App, remote: { cleared: number; score: number; playtime: number } | null): Promise<void> {
  const local = app.game.p;
  if (!remote) { await app.syncCloud(true, 'local'); return; }
  if (Object.keys(local.campaign).length === 0 && local.playtime < 300) { await app.syncCloud(true, 'remote'); return; }
  const line = (cleared: number, playtime: number) => t('acct.progress_line', { levels: cleared, time: fmtTime(playtime) });
  const keepCloud = await app.confirm(t('acct.conflict_title'), `${t('acct.conflict_text')}\n\n☁️ ${line(remote.cleared, remote.playtime)}\n📱 ${line(Object.keys(local.campaign).length, local.playtime)}`, t(remote.score >= progressScore(local) ? 'acct.keep_cloud_rec' : 'acct.keep_cloud'), t(remote.score >= progressScore(local) ? 'acct.keep_device' : 'acct.keep_device_rec'));
  await app.syncCloud(true, keepCloud ? 'remote' : 'local');
}

async function linkProvider(app: App, provider: 'google' | 'apple'): Promise<void> {
  const tok = await app.cloud.providerToken(provider);
  if (!tok.idToken) { app.toast(t(tok.reason ?? 'cloud.err.cancelled'), 'warn'); return; }
  const r = await app.cloud.link(provider, tok.idToken);
  if (r.ok) { app.toast(t('acct.linked_ok'), 'good'); app.refresh(); return; }
  if (r.reason === 'cloud.err.identity_taken') {
    // The identity already owns an account: offer to switch to it instead.
    if (await app.confirm(t('acct.switch_title'), t('acct.switch_text'), t('acct.login'), t('ui.cancel'))) {
      const l = await app.cloud.login({ provider, idToken: tok.idToken });
      if (l.ok) await chooseProgress(app, l.remote ?? null); else app.toast(t(l.reason!), 'error');
      app.refresh();
    }
    return;
  }
  app.toast(t(r.reason!), 'error');
}

function backupsDialog(app: App): void {
  const list = app.saveSvc.backups();
  const close = app.modal(h('div.dialog', null, h('h2', null, t('acct.backups')), h('p.muted', null, t('acct.backups_hint')),
    list.length ? list.map((b) => h('div.quest', null, h('div.grow', null, h('b', null, new Date(b.savedAt).toLocaleString()), h('small', null, `${t(`backup.${b.slot}`)} · ${t('acct.progress_line', { levels: b.cleared, time: '' })} 🪙${fmtNum(b.gold)} 💎${fmtNum(b.gems)}`)),
      btn(t('acct.restore'), async () => {
        if (!(await app.confirm(t('acct.restore'), t('acct.restore_text'), t('acct.restore'), t('ui.cancel')))) return;
        const p = app.saveSvc.readBackup(b.slot);
        if (!p) { app.toast(t('err.unknown'), 'error'); return; }
        close(); app.adoptProfile(p); app.toast(t('acct.restored'), 'good');
      }, 'small', { 'data-backup': b.slot }))) : h('p.muted', null, t('acct.no_backups'))), { cls: 'sheet' });
}

async function cloudHistoryDialog(app: App): Promise<void> {
  const items = await app.cloud.history();
  const close = app.modal(h('div.dialog', null, h('h2', null, t('acct.cloud_history')), h('p.muted', null, t('acct.cloud_history_hint')),
    items.length ? items.map((it) => h('div.quest', null, h('div.grow', null, h('b', null, new Date(it.updatedAt).toLocaleString()), h('small', null, t('acct.progress_line', { levels: it.summary.cleared, time: fmtTime(it.summary.playtime) }))),
      btn(t('acct.restore'), async () => {
        if (!(await app.confirm(t('acct.restore'), t('acct.restore_text'), t('acct.restore'), t('ui.cancel')))) return;
        const p = await app.cloud.fetchRevision(it.rev);
        if (!p) { app.toast(t('cloud.err.network'), 'error'); return; }
        close(); app.adoptProfile(p); app.toast(t('acct.restored'), 'good');
      }, 'small', { 'data-rev': it.rev }))) : h('p.muted', null, t('acct.no_backups'))), { cls: 'sheet' });
}

function supportDialog(app: App): void {
  const s = app.settings;
  const cat = h('select', { id: 'sup-cat' }, ['bug', 'purchase', 'progress', 'other'].map((c) => h('option', { value: c }, t(`support.cat.${c}`)))) as HTMLSelectElement;
  const msg = h('textarea', { rows: '5', placeholder: t('support.message'), id: 'sup-msg', maxlength: '4000' }) as HTMLTextAreaElement;
  const contact = h('input', { type: 'email', placeholder: t('support.contact'), id: 'sup-contact' }) as HTMLInputElement;
  const tech = h('input', { type: 'checkbox', checked: true, id: 'sup-tech' }) as HTMLInputElement;
  const logs = h('input', { type: 'checkbox', checked: s.logsConsent, id: 'sup-logs' }) as HTMLInputElement;
  const close = app.modal(h('div.dialog', null, h('h2', null, t('support.title')), cat, msg, contact,
    h('label.set', null, h('span', null, t('support.attach_tech')), tech), h('label.set', null, h('span', null, t('support.attach_logs')), logs), h('p.muted', null, t('support.privacy')),
    btn(t('support.send'), async () => {
      if (!msg.value.trim()) { app.toast(t('support.empty'), 'warn'); return; }
      s.logsConsent = logs.checked; app.applySettings();
      const g = app.game.p;
      // Technical info is limited to what support needs to find the problem; no personal data.
      const techInfo = tech.checked ? JSON.stringify({ v: app.config.version, native: app.isNative, lang: s.lang, profile: g.id, cleared: Object.keys(g.campaign).length, rev: g.rev, flags: g.flags, ads: app.ads.providerName, store: app.iap.providerName, ua: navigator.userAgent.slice(0, 160) }) : '';
      const ticket = { category: cat.value, message: msg.value.trim(), contact: contact.value.trim(), tech: techInfo, logs: logs.checked ? app.log.report({}) : '' };
      const sent = cloudConfigured() && isOnline() ? await app.cloud.sendTicket(ticket) : false;
      if (sent) { close(); app.toast(t('support.sent'), 'good'); return; }
      // No backend or no network: fall back to the mail app with the same content.
      const body = encodeURIComponent(`${ticket.message}\n\n---\n${ticket.tech}${ticket.logs ? `\n${ticket.logs.slice(0, 1500)}` : ''}`);
      location.href = `mailto:${app.config.supportEmail}?subject=${encodeURIComponent(`[Rune Bastion] ${cat.value}`)}&body=${body}`;
      close(); app.toast(t('support.mail'), 'good');
    }, 'primary wide', { id: 'btn-support-send' })), { cls: 'sheet' });
}

// ---------------------------------------------------------------- offline reward
function offlinePopup(app: App): void {
  const g = app.game, pend = g.pendingOffline();
  let taken = false;
  const take = (double: boolean) => async () => {
    if (taken) return;
    if (double) { const r = await app.rewarded('offline_x2'); if (!r.ok) return; }
    taken = true;
    const c = g.claimOffline();
    if (c.ok && double) g.doubleOffline();
    close();
    if (c.ok) { app.audio.play('reward'); app.toast(`+${fmtNum(c.gold * (double ? 2 : 1))} 🪙`, 'good'); }
    app.refresh();
  };
  const close = app.modal(h('div.dialog.center', { id: 'offline' }, h('div.big-icon', null, '🌙'), h('h2', null, t('offline.title')),
    h('p', null, t('offline.text', { time: fmtTime(pend.seconds) }), pend.capped ? ` ${t('offline.capped', { hours: OFFLINE_CAP_HOURS })}` : ''),
    h('div.rewards', null, app.rewardNodes({ gold: pend.gold })),
    g.adsLeft('offline_x2') > 0 ? btn([h('span', null, t('offline.double')), h('small', null, '🎬 ', t('ui.free'))], take(true), 'accent wide', { id: 'btn-offline-x2' }) : null,
    btn(t('ui.claim'), take(false), 'primary wide', { id: 'btn-offline-claim' })), { dismissable: false });
}

export const SCREENS = { frame, menu, map, towers, research, quests, shop, settings, offlinePopup, levelDialog };
export const _unused = { ACHIEVEMENTS, ABILITIES, ABILITY_ICON, unlockedAbilities };
