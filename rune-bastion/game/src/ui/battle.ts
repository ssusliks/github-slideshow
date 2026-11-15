import { Battle, BattleEvent, BattleState, TowerState } from '../core/battle';
import type { MergeOption } from '../core/merge';
import type { RunContext } from '../core/types';
import { BOOST_BY_ID } from '../data/boosts';
import { ENEMIES } from '../data/enemies';
import { REVIVE_GEMS } from '../data/meta';
import { TOWERS } from '../data/towers';
import { ABILITIES, ABILITY_ORDER, LEVELS, LEVEL_BY_ID, WORLDS } from '../data/worlds';
import type { ActiveRun, RunSummary } from '../meta/game';
import { enemyThumb, towerThumb } from '../render/thumb';
import type { BattleView } from '../render/view';
import { t } from '../services/i18n';
import { vibrate } from '../services/platform';
import { saveSettings } from '../services/settings';
import type { App } from './app';
import { ABILITY_ICON, EL_ICON, ROMAN, boostText, describeTower, towerTitle } from './describe';
import { btn, clear, fmtNum, fmtStat, h, setText } from './dom';

type Drag =
  | { kind: 'maybe'; x: number; y: number; slot: number }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'tower'; id: number; hover: number }
  | { kind: 'card'; def: string; x: number; y: number; moved: boolean; hover: number; el: HTMLElement };

/** Battle HUD, touch input, tutorial and result flow for one run. */
export class BattleScreen {
  readonly el: HTMLElement;
  readonly b: Battle;
  private paused = false;
  private adPause = false;
  /** app is in the background: the clock must not advance even if frames keep coming. */
  private suspended = false;
  private defeatOpen = false;
  private modalPause = 0;
  private ended = false;
  private errored = false;
  private selected = 0;
  private placing: string | null = null;
  private mergeFrom = 0;
  private targeting: string | null = null;
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private boostOpen = false;
  private closeBoost: (() => void) | null = null;
  private hudT = 0;
  private lastCoins = -1;
  private lastPanelKey = '';
  private tutStep = 0;
  private bannerT = 0;
  private world = WORLDS[0];
  private els: Record<string, HTMLElement> = {};
  private cards = new Map<string, HTMLElement>();
  private abilityEls = new Map<string, HTMLElement>();
  private canvas: HTMLCanvasElement;
  private off: (() => void)[] = [];

  constructor(private app: App, private view: BattleView, ctx: RunContext, private run: ActiveRun, saved?: BattleState) {
    this.b = new Battle(ctx, saved);
    this.b.collect = true;
    this.world = WORLDS[this.b.level.world - 1];
    this.canvas = view.renderer.domElement;
    view.setBattle(this.b, this.world, app.game.p.cosmetics.castle);
    view.onReaction = (id, x, y) => view.floatText(t(`reaction.${id}`), x, y, 0.95, 'react');
    document.documentElement.style.setProperty('--sky-top', this.world.palette.skyTop);
    document.documentElement.style.setProperty('--sky-bottom', this.world.palette.skyBottom);
    this.el = this.build();
    this.bindInput();
    app.audio.setMood(this.b.level.boss ? 'boss' : 'battle');
    if (saved) this.togglePause(true);
  }

  // ------------------------------------------------------------------ DOM
  private build(): HTMLElement {
    const b = this.b, E = this.els;
    E.hpFill = h('div.bar-fill.hp');
    E.hpText = h('span');
    E.wave = h('span.wave-label');
    E.waveFill = h('div.bar-fill.wave');
    E.coins = h('span', { id: 'coins' });
    E.speed = btn(`×${this.app.settings.speed}`, () => this.toggleSpeed(), 'hud-btn', { id: 'btn-speed' });
    E.banner = h('div.banner');
    E.start = btn('', () => { this.b.startWave(); }, 'primary start', { id: 'btn-start' });
    E.shop = h('div.shopbar');
    E.panel = h('div.panel.hidden');
    E.abilities = h('div.abilities');
    E.tut = h('div.tut.hidden');
    E.hand = h('div.hand.hidden', null, '👆');
    E.hint = h('div.mode-hint.hidden');
    for (const def of b.s.ctx.loadout) {
      const d = TOWERS[def];
      const card = h('div.card', { 'data-tower': def }, h('img', { src: towerThumb(d), alt: '', draggable: 'false' }), h('div.card-el', null, EL_ICON[d.element]), h('div.card-cost', null, '🪙', h('b')));
      this.cards.set(def, card);
      E.shop.appendChild(card);
      this.bindCard(card, def);
    }
    for (const id of ABILITY_ORDER) {
      if (!b.s.abilities.some((a) => a.id === id)) continue;
      const el = btn([h('span.ab-icon', null, ABILITY_ICON[id]), h('span.ab-cd')], () => this.onAbility(id), 'ability', { 'data-ability': id, 'aria-label': t(`ability.${id}.name`), 'data-quiet': '1' });
      this.abilityEls.set(id, el);
      E.abilities.appendChild(el);
    }
    return h('div.hud', null,
      h('div.hud-top', null,
        h('div.pill.hp-pill', null, h('span.ico', null, '❤️'), h('div.bar', null, E.hpFill), E.hpText),
        h('div.wavebox', null, E.wave, h('div.bar.thin', null, E.waveFill)),
        h('div.pill.coin-pill', null, h('span.ico', null, '🪙'), E.coins)),
      h('div.hud-side-left', null, btn(h('span.pause-ico'), () => this.togglePause(true), 'hud-btn', { id: 'btn-pause', 'aria-label': t('ui.pause') }), E.speed),
      E.abilities, E.banner, E.tut, E.hand, E.hint,
      h('div.hud-bottom', null, E.start, E.shop, E.panel));
  }

  // ------------------------------------------------------------------ input
  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(ev, fn as EventListener, opts);
    this.off.push(() => el.removeEventListener(ev, fn as EventListener, opts));
  }
  private bindInput(): void {
    const c = this.canvas;
    this.on(c, 'pointerdown', (e) => {
      if (this.ended || this.paused) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [p, q] = [...this.pointers.values()];
        this.pinch = Math.hypot(p.x - q.x, p.y - q.y);
        this.cancelDrag();
        return;
      }
      this.drag = { kind: 'maybe', x: e.clientX, y: e.clientY, slot: this.view.slotAtScreen(e.clientX, e.clientY) };
    });
    this.on(c, 'pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      prev.x = e.clientX; prev.y = e.clientY;
      if (this.pointers.size >= 2) {
        const [p, q] = [...this.pointers.values()];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (this.pinch > 0 && d > 0) this.view.zoomBy(d / this.pinch);
        this.pinch = d;
        this.view.pan(dx / 2, dy / 2);
        return;
      }
      const g = this.drag;
      if (!g) return;
      if (g.kind === 'maybe') {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 10) return;
        const tw = g.slot >= 0 ? this.b.towerAt(g.slot) : undefined;
        if (tw && !this.targeting) {
          this.drag = { kind: 'tower', id: tw.id, hover: -1 };
          this.select(0);
          this.showHighlights(tw.id, true);
        } else this.drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      } else if (g.kind === 'pan') {
        this.view.pan(dx, dy);
      }
      if (this.drag?.kind === 'tower') this.dragTowerMove(this.drag, e.clientX, e.clientY);
      if (this.targeting) this.view.setTargeting(ABILITIES[this.targeting].radius ?? 1, this.view.groundAt(e.clientX, e.clientY));
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.pointers.size < 2) this.pinch = 0;
      const g = this.drag;
      this.drag = null;
      if (!g || this.ended) return;
      if (g.kind === 'maybe') this.onTap(e.clientX, e.clientY, g.slot);
      else if (g.kind === 'tower') this.dropTower(g, e.clientX, e.clientY);
    };
    this.on(c, 'pointerup', up);
    this.on(c, 'pointercancel', (e) => { this.pointers.delete(e.pointerId); this.cancelDrag(); });
  }

  private bindCard(card: HTMLElement, def: string): void {
    this.on(card, 'pointerdown', (e) => {
      if (this.ended || this.paused) return;
      e.preventDefault();
      if (this.b.s.coins < this.b.buyCost(def)) { this.app.toast(t('act.err.coins'), 'warn'); this.app.audio.play('deny'); return; }
      try { card.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.drag = { kind: 'card', def, x: e.clientX, y: e.clientY, moved: false, hover: -1, el: card };
    });
    this.on(card, 'pointermove', (e) => {
      const g = this.drag;
      if (!g || g.kind !== 'card' || g.def !== def) return;
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 8) return;
      if (!g.moved) { g.moved = true; this.select(0); this.setPlacing(null); this.showHighlights(0, false); card.classList.add('dragging'); }
      const slot = this.view.slotAtScreen(e.clientX, e.clientY, 54);
      const free = slot >= 0 && !this.b.towerAt(slot);
      g.hover = free ? slot : -1;
      const pt = free ? this.b.slotPos(slot) : this.view.groundAt(e.clientX, e.clientY - 30);
      this.view.setGhost(def, 1, null, pt);
      const stats = this.b.previewStats(def, 1, 0, null);
      if (pt) this.view.setRange(pt.x, pt.y, stats.range, free ? 0x7dff9a : 0xffffff);
      this.showHighlights(0, false, g.hover);
    });
    const end = (e: PointerEvent) => {
      const g = this.drag;
      if (!g || g.kind !== 'card' || g.def !== def) return;
      this.drag = null;
      card.classList.remove('dragging');
      this.view.setGhost(null);
      this.view.setRange(0, 0, 0);
      if (!g.moved) { this.setPlacing(this.placing === def ? null : def); return; }
      this.view.setHighlights(null);
      const slot = e.type === 'pointercancel' ? -1 : this.view.slotAtScreen(e.clientX, e.clientY, 54);
      if (slot >= 0) this.buy(def, slot);
    };
    this.on(card, 'pointerup', end);
    this.on(card, 'pointercancel', end);
  }

  private cancelDrag(): void {
    this.drag = null;
    this.view.setGhost(null);
    if (!this.placing && !this.mergeFrom) this.view.setHighlights(null);
    this.cards.forEach((c) => c.classList.remove('dragging'));
  }

  /** Colours the slots for the current intent: placing a new tower, or moving/merging tower `src`. */
  private showHighlights(src: number, allowMove: boolean, hover = -1): void {
    const m = new Map<number, string>();
    this.b.map.slots.forEach((_s, i) => {
      const tw = this.b.towerAt(i);
      if (!tw) { if (!src || allowMove) m.set(i, i === hover ? 'hover' : 'free'); return; }
      if (!src || tw.id === src) return;
      const chk = this.b.mergeCheck(src, tw.id);
      if (chk.ok) m.set(i, i === hover ? 'hover' : chk.options[0].kind === 'hybrid' ? 'hybrid' : 'merge');
      else if (i === hover) m.set(i, 'bad');
    });
    this.view.setHighlights(m);
  }

  private dragTowerMove(g: Extract<Drag, { kind: 'tower' }>, x: number, y: number): void {
    const tw = this.b.tower(g.id);
    if (!tw) { this.cancelDrag(); return; }
    const slot = this.view.slotAtScreen(x, y, 54);
    g.hover = slot >= 0 && slot !== tw.slot ? slot : -1;
    const pt = g.hover >= 0 ? this.b.slotPos(g.hover) : this.view.groundAt(x, y - 30);
    this.view.setGhost(tw.def, tw.tier, tw.branch, pt);
    this.showHighlights(tw.id, true, g.hover);
  }
  private dropTower(g: Extract<Drag, { kind: 'tower' }>, x: number, y: number): void {
    this.view.setGhost(null);
    this.view.setHighlights(null);
    const tw = this.b.tower(g.id);
    if (!tw) return;
    const slot = this.view.slotAtScreen(x, y, 54);
    if (slot < 0 || slot === tw.slot) { this.select(tw.id); return; }
    const other = this.b.towerAt(slot);
    if (!other) {
      const r = this.b.moveTower(tw.id, slot);
      if (!r.ok) this.app.toast(t(r.reason), 'warn');
      return;
    }
    this.openMerge(tw.id, other.id);
  }

  private onTap(x: number, y: number, slot: number): void {
    if (this.targeting) {
      const pt = this.view.groundAt(x, y);
      const id = this.targeting;
      this.setTargeting(null);
      if (pt) { const r = this.b.useAbility(id, pt.x, pt.y); if (!r.ok) this.app.toast(t(r.reason), 'warn'); }
      return;
    }
    const tw = slot >= 0 ? this.b.towerAt(slot) : undefined;
    if (this.placing) {
      if (slot >= 0 && !tw) { this.buy(this.placing, slot); return; }
      this.setPlacing(null);
      if (!tw) return;
    }
    if (this.mergeFrom) {
      const from = this.mergeFrom;
      this.setMergeMode(0);
      if (tw && tw.id !== from) { this.openMerge(from, tw.id); return; }
    }
    this.select(tw ? tw.id : 0);
  }

  private buy(def: string, slot: number): void {
    const r = this.b.buyTower(def, slot);
    if (!r.ok) { this.app.toast(t(r.reason), 'warn'); this.app.audio.play('deny'); return; }
    if (this.b.s.coins < this.b.buyCost(def)) this.setPlacing(null);
    else if (this.placing) this.showHighlights(0, false);
  }

  private setPlacing(def: string | null): void {
    this.placing = def;
    this.cards.forEach((c, id) => c.classList.toggle('active', id === def));
    if (def) { this.select(0); this.setMergeMode(0); this.setTargeting(null); this.showHighlights(0, false); this.modeHint(t('hint.place')); }
    else { if (!this.mergeFrom) this.view.setHighlights(null); this.modeHint(null); }
  }
  private setMergeMode(id: number): void {
    this.mergeFrom = id;
    if (id) { this.showHighlights(id, false); this.modeHint(t('hint.merge')); }
    else { this.view.setHighlights(null); this.modeHint(null); }
  }
  private setTargeting(id: string | null): void {
    this.targeting = id;
    this.abilityEls.forEach((el, k) => el.classList.toggle('active', k === id));
    if (id) { this.setPlacing(null); this.select(0); this.modeHint(t('hint.target')); }
    else { this.view.setTargeting(0); this.modeHint(null); }
  }
  private modeHint(text: string | null): void {
    this.els.hint.classList.toggle('hidden', !text);
    if (text) setText(this.els.hint, text);
  }

  private onAbility(id: string): void {
    if (this.ended || this.paused) return;
    const st = this.b.s.abilities.find((a) => a.id === id);
    if (!st || st.cd > 0) { this.app.audio.play('deny'); return; }
    if (ABILITIES[id].targeted) { this.setTargeting(this.targeting === id ? null : id); return; }
    const r = this.b.useAbility(id);
    if (!r.ok) { this.app.toast(t(r.reason), 'warn'); this.app.audio.play('deny'); }
  }

  // ------------------------------------------------------------------ tower panel
  private select(id: number): void {
    this.selected = id;
    this.view.setSelected(id);
    this.lastPanelKey = '';
    if (!id) { this.els.panel.classList.add('hidden'); this.els.shop.classList.remove('hidden'); this.view.setRange(0, 0, 0); }
    this.renderPanel();
  }
  private renderPanel(): void {
    const tw = this.selected ? this.b.tower(this.selected) : undefined;
    const P = this.els.panel;
    if (!tw) { if (this.selected) this.select(0); return; }
    const b = this.b, c = b.towerStats(tw), up = b.upgradeCost(tw), canUp = b.canUpgrade(tw), aura = b.auraOf(tw.id);
    const key = `${tw.id}:${tw.tier}:${tw.rank}:${tw.def}:${b.s.coins >= up}:${Math.round(c.damage * 10)}:${aura.rate}:${aura.dmg}:${tw.stun > 0}`;
    if (key === this.lastPanelKey) return;
    this.lastPanelKey = key;
    const pos = b.slotPos(tw.slot);
    this.view.setRange(pos.x, pos.y, c.range);
    const d = c.def;
    clear(P);
    P.classList.remove('hidden');
    this.els.shop.classList.add('hidden');
    P.appendChild(h('div.panel-head', null,
      h('img.thumb', { src: towerThumb(d, tw.tier, tw.branch), alt: '' }),
      h('div.grow', null,
        h('div.panel-title', null, towerTitle(tw.def, tw.branch), ' ', h('span.tier', null, ROMAN[tw.tier]), tw.rank ? h('span.rank', null, `+${tw.rank}`) : null),
        h('div.chips', null, h(`span.chip.r-${d.rarity}`, null, t(`rarity.${d.rarity}`)), h('span.chip', null, EL_ICON[d.element], ' ', t(`el.${d.element}`)), d.element2 ? h('span.chip', null, EL_ICON[d.element2], ' ', t(`el.${d.element2}`)) : null),
        h('div.stats', null,
          h('span', null, '⚔️ ', fmtStat(c.damage * (1 + aura.dmg))), h('span', null, '⏱ ', fmtStat(c.rate * (1 + aura.rate)), t('ui.per_sec')), h('span', null, '🎯 ', fmtStat(c.range)), h('span.dps', null, 'DPS ', fmtStat(c.dps * (1 + aura.dmg) * (1 + aura.rate))))),
      btn('✕', () => this.select(0), 'x')));
    const lines = describeTower(c);
    if (aura.rate || aura.dmg) lines.push(t('fx.aura_bonus', { rate: Math.round(aura.rate * 100), dmg: Math.round(aura.dmg * 100) }));
    if (tw.stun > 0) lines.unshift(t('ui.stunned'));
    P.appendChild(h('div.fx-list', null, lines.map((l) => h('span', null, l))));
    P.appendChild(h('div.panel-actions', null,
      btn([h('span', null, canUp ? t('ui.upgrade') : t('ui.max')), canUp ? h('small', null, '🪙 ', fmtNum(up)) : null], () => { const r = b.upgradeTower(tw.id); if (!r.ok) this.app.toast(t(r.reason), 'warn'); }, 'primary', { disabled: !canUp || b.s.coins < up, id: 'btn-upgrade' }),
      btn([h('span', null, t('ui.merge')), h('small', null, '🧬')], () => this.startMergeMode(tw), 'accent', { id: 'btn-merge' }),
      btn([h('span', null, t('ui.sell')), h('small', null, '🪙 +', fmtNum(b.sellValue(tw)))], () => { b.sellTower(tw.id); this.select(0); }, 'ghost', { id: 'btn-sell' })));
  }
  private startMergeMode(tw: TowerState): void {
    const any = this.b.s.towers.some((o) => o.id !== tw.id && this.b.mergeCheck(tw.id, o.id).ok);
    if (!any) { this.app.toast(t(TOWERS[tw.def].hybrid ? 'merge.none_hybrid' : 'merge.none'), 'warn'); return; }
    this.select(0);
    this.setMergeMode(tw.id);
  }

  // ------------------------------------------------------------------ merge preview
  private openMerge(aId: number, bId: number): void {
    const b = this.b;
    const chk = b.mergeCheck(aId, bId);
    if (!chk.ok) { this.app.toast(t(chk.reason), 'warn'); this.app.audio.play('deny'); return; }
    const A = b.tower(aId)!, B = b.tower(bId)!;
    const sA = b.towerStats(A), sB = b.towerStats(B);
    const best = sA.dps >= sB.dps ? sA : sB;
    const have = new Set([...describeTower(sA), ...describeTower(sB)]);
    let pick = 0;
    const optEls: HTMLElement[] = [];
    const confirmBtn = btn('', () => doMerge(), 'primary', { id: 'btn-merge-confirm' });
    const refresh = () => {
      optEls.forEach((el, i) => el.classList.toggle('picked', i === pick));
      const o = chk.options[pick];
      clear(confirmBtn);
      confirmBtn.append(h('span', null, t('merge.confirm')), h('small', null, o.fee > 0 ? `🪙 ${o.fee}` : t('ui.free')));
      confirmBtn.disabled = b.s.coins < o.fee;
    };
    const delta = (now: number, was: number) => {
      const d = was > 0 ? now / was - 1 : 0;
      return Math.abs(d) < 0.005 ? null : h(`i.${d > 0 ? 'up' : 'down'}`, null, `${d > 0 ? '▲' : '▼'}${Math.abs(Math.round(d * 100))}%`);
    };
    chk.options.forEach((o: MergeOption, i) => {
      const s = b.previewStats(o.def, o.tier, o.rank, o.branch), d = TOWERS[o.def];
      const el = h('div.merge-opt', { 'data-opt': i, onclick: () => { pick = i; refresh(); } },
        h('img.thumb.lg', { src: towerThumb(d, o.tier, o.branch), alt: '' }),
        h('div.grow', null,
          h('div.panel-title', null, towerTitle(o.def, o.branch), ' ', h('span.tier', null, ROMAN[o.tier])),
          h('div.chips', null, h(`span.chip.r-${d.rarity}`, null, t(`rarity.${d.rarity}`)), h('span.chip', null, EL_ICON[d.element], ' ', t(`el.${d.element}`)), d.element2 ? h('span.chip', null, EL_ICON[d.element2], ' ', t(`el.${d.element2}`)) : null, h('span.chip', null, t(`attack.${s.attack.kind}`))),
          h('div.stats.wrap', null,
            h('span', null, '⚔️ ', fmtStat(s.damage), delta(s.damage, best.damage)), h('span', null, '⏱ ', fmtStat(s.rate), delta(s.rate, best.rate)),
            h('span', null, '🎯 ', fmtStat(s.range), delta(s.range, best.range)), h('span.dps', null, 'DPS ', fmtStat(s.dps), delta(s.dps, best.dps))),
          h('div.fx-list', null, describeTower(s).map((l) => h(`span${have.has(l) ? '' : '.new'}`, null, l))),
          h('p.muted', null, t(o.branch ? `branch.${o.branch}.desc` : `tower.${o.def}.desc`))));
      optEls.push(el);
    });
    const doMerge = () => {
      const r = b.merge(aId, bId, pick);
      if (!r.ok) { this.app.toast(t(r.reason), 'warn'); return; }
      close();
      this.select(b.s.towers[b.s.towers.length - 1].id);
    };
    this.modalPause++;
    const hybrid = chk.options[0].kind === 'hybrid';
    const close = this.app.modal(h('div.merge', null,
      h('h2', null, t(hybrid ? 'merge.title_hybrid' : 'merge.title')),
      h('div.merge-src', null,
        h('div.src', null, h('img.thumb', { src: towerThumb(TOWERS[A.def], A.tier, A.branch), alt: '' }), h('small', null, `${towerTitle(A.def, A.branch)} ${ROMAN[A.tier]}`)),
        h('span.plus', null, '+'),
        h('div.src', null, h('img.thumb', { src: towerThumb(TOWERS[B.def], B.tier, B.branch), alt: '' }), h('small', null, `${towerTitle(B.def, B.branch)} ${ROMAN[B.tier]}`)),
        h('span.plus', null, '→')),
      chk.options.length > 1 ? h('p.choose', null, t('merge.choose')) : null,
      h('div.merge-opts', null, optEls),
      h('div.row', null, btn(t('ui.cancel'), () => close(), 'ghost', { id: 'btn-merge-cancel' }), confirmBtn)), { cls: 'sheet', onClose: () => { this.modalPause--; } });
    refresh();
  }

  // ------------------------------------------------------------------ boosts
  private openBoosts(): void {
    if (this.boostOpen) return;
    this.boostOpen = true;
    const b = this.b;
    const body = h('div.boosts');
    const render = () => {
      clear(body);
      const first = b.s.wave === 0 && b.s.time === 0;
      body.append(h('h2', null, t(first ? 'boost.title_first' : 'boost.title')), h('p.muted', null, t('boost.hint')));
      (b.s.offer ?? []).forEach((id, i) => {
        const def = BOOST_BY_ID[id], tx = boostText(def), have = b.s.boosts[id] ?? 0;
        body.append(h(`button.boost.r-${def.rarity}`, { type: 'button', 'data-boost': id, onclick: () => { if (b.chooseBoost(i).ok) { this.boostOpen = false; this.closeBoost?.(); this.closeBoost = null; } } },
          h('div.boost-top', null, h('b', null, tx.name), h('span.chip', null, t(`rarity.${def.rarity}`)), def.max > 1 ? h('small', null, `${have}/${def.max}`) : null),
          h('span', null, tx.desc)));
      });
      const cost = b.rerollCost();
      body.append(h('div.row', null,
        btn([h('span', null, t('boost.reroll')), h('small', null, cost > 0 ? `🪙 ${cost}` : t('ui.free'))], () => { const r = b.rerollBoosts(); if (r.ok) render(); else this.app.toast(t(r.reason), 'warn'); }, 'ghost', { disabled: b.s.coins < cost, id: 'btn-reroll' }),
        this.app.game.adsLeft('reroll') > 0 ? btn([h('span', null, t('boost.reroll')), h('small', null, '🎬 ', t('ui.free'))], async () => {
          const r = await this.app.rewarded('reroll');
          if (r.ok) { b.rerollBoosts(true); render(); }
        }, 'ghost', { id: 'btn-reroll-ad' }) : null));
    };
    render();
    this.closeBoost = this.app.modal(body, { dismissable: false, cls: 'sheet' });
    this.app.audio.play('boost');
  }

  // ------------------------------------------------------------------ pause / lifecycle
  togglePause(on: boolean): void {
    if (this.ended || this.errored) return;
    if (on === this.paused) return;
    this.paused = on;
    if (!on) return;
    this.cancelDrag();
    const resume = () => { close(); };
    const close = this.app.modal(h('div.dialog.center', null,
      h('h2', null, t('ui.paused')),
      btn(t('ui.resume'), resume, 'primary wide', { id: 'btn-resume' }),
      btn(t('ui.restart'), async () => { if (await this.app.confirm(t('ui.restart'), t('ui.restart_confirm'), t('ui.restart'), t('ui.cancel'))) { close(); this.quit({ levelId: this.run.levelId, mode: this.run.mode }); } }, 'ghost wide'),
      btn(t('ui.to_map'), async () => { if (await this.app.confirm(t('ui.to_map'), t('ui.quit_confirm'), t('ui.leave'), t('ui.cancel'))) { close(); this.quit(null); } }, 'ghost wide', { id: 'btn-quit' })),
      { dismissable: true, onClose: () => { this.paused = false; this.app.limiter.reset(); } });
  }
  private toggleSpeed(): void {
    const s = this.app.settings;
    s.speed = s.speed === 1 ? 2 : 1;
    saveSettings(this.app.kv, s);
    setText(this.els.speed, `×${s.speed}`);
  }
  setAdPause(on: boolean): void {
    this.adPause = on;
  }
  /** App is going to the background: stop the clock and store a resumable snapshot. */
  suspend(): void {
    if (this.ended || this.errored) return;
    this.suspended = true;
    this.cancelDrag();
    this.app.writeJournal({ run: this.run, clean: true, snapshot: this.b.serialize() });
  }
  resumeFromBackground(): void {
    if (this.ended || this.errored) return;
    // Back in the foreground: from now on a sudden death of the process is a crash again.
    this.suspended = false;
    this.app.writeJournal({ run: this.run, clean: false, snapshot: null });
    if (!this.defeatOpen && !this.boostOpen && this.modalPause === 0) this.togglePause(true);
  }
  /** A runtime error inside the battle: stop safely, grant nothing, offer a clean restart. */
  onRuntimeError(): void {
    if (this.errored || this.ended) return;
    this.errored = true;
    this.app.closeAllModals();
    void this.app.confirm(t('err.battle_title'), t('err.battle_text'), t('crash.restart'), t('ui.to_menu')).then((again) => this.quit(again ? { levelId: this.run.levelId, mode: this.run.mode } : null));
  }
  private quit(next: { levelId: string; mode: 'campaign' | 'endless' } | null): void {
    this.ended = true;
    this.app.game.abandonRun();
    this.app.endBattle(next);
  }
  dispose(): void {
    this.off.forEach((f) => f());
    this.off = [];
    this.app.closeAllModals();
    this.view.setHighlights(null);
    this.view.setGhost(null);
    this.view.setRange(0, 0, 0);
    this.view.setTargeting(0);
    this.view.setSelected(0);
    this.view.onReaction = null;
    this.el.remove();
  }

  // ------------------------------------------------------------------ frame
  frame(dt: number): void {
    const b = this.b, s = b.s;
    const running = !this.paused && !this.adPause && !this.suspended && this.modalPause === 0 && !this.ended && !this.errored;
    if (running) b.advance(dt * this.app.settings.speed);
    if (b.events.length) for (const ev of b.events) this.onEvent(ev);
    this.view.frame(dt);
    b.events.length = 0;
    if (this.ended || this.errored) return;
    if (s.phase === 'boost' && !this.boostOpen) this.openBoosts();
    else if (s.phase !== 'boost' && this.boostOpen) { this.boostOpen = false; this.closeBoost?.(); this.closeBoost = null; }
    if ((s.phase === 'won' || s.phase === 'lost') && !this.ended) { this.onFinished(); return; }
    this.hudT -= dt;
    if (this.hudT <= 0) { this.hudT = 0.1; this.updateHud(); }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.els.banner.classList.remove('show'); }
  }

  private updateHud(): void {
    const b = this.b, s = b.s, E = this.els;
    E.hpFill.style.width = `${Math.max(0, (s.castleHp / s.castleMax) * 100)}%`;
    E.hpFill.classList.toggle('low', s.castleHp / s.castleMax < 0.35);
    setText(E.hpText, `${s.castleHp}/${s.castleMax}`);
    const total = b.totalWaves();
    setText(E.wave, Number.isFinite(total) ? t('ui.wave_of', { n: Math.min(s.wave + 1, total), total }) : t('ui.wave_n', { n: s.wave + 1 }));
    E.waveFill.style.width = `${Math.round(b.waveProgress() * 100)}%`;
    setText(E.coins, fmtNum(s.coins));
    if (s.coins !== this.lastCoins) {
      this.lastCoins = s.coins;
      this.cards.forEach((card, def) => {
        const cost = b.buyCost(def);
        setText(card.querySelector('b'), cost === 0 ? t('ui.free') : String(cost));
        card.classList.toggle('poor', s.coins < cost);
      });
    }
    const prep = s.phase === 'prep';
    E.start.classList.toggle('hidden', !prep || !!this.selected);
    if (prep) setText(E.start, Number.isFinite(s.phaseT) ? `${t('ui.start_wave')} (${Math.max(0, Math.ceil(s.phaseT))})` : t('ui.start_wave'));
    for (const a of s.abilities) {
      const el = this.abilityEls.get(a.id);
      if (!el) continue;
      const def = ABILITIES[a.id];
      const k = a.cd > 0 ? a.cd / (def.cooldown * Math.max(0.4, 1 - b.mods.abilityCd)) : 0;
      el.style.setProperty('--cd', `${Math.round(Math.min(1, k) * 100)}%`);
      el.classList.toggle('cooling', a.cd > 0);
      setText(el.querySelector('.ab-cd'), a.cd > 0 ? String(Math.ceil(a.cd)) : '');
    }
    if (this.selected) this.renderPanel();
    if (s.ctx.tutorial) this.updateTutorial();
    else this.updateHints();
  }

  private banner(text: string, cls = '', img?: string): void {
    const B = this.els.banner;
    clear(B);
    B.className = `banner show ${cls}`;
    if (img) B.appendChild(h('img', { src: img, alt: '' }));
    B.appendChild(h('span', null, text));
    this.bannerT = cls === 'boss' ? 3.2 : 1.8;
  }

  private onEvent(ev: BattleEvent): void {
    const A = this.app.audio, vib = this.app.settings.vibration;
    switch (ev.t) {
      case 'shot': { const tw = this.b.tower(ev.tower); const kind = tw ? TOWERS[tw.def].look.kind : ''; A.play(kind === 'cannon' || kind === 'meteor' || kind === 'frostcannon' ? 'shot_cannon' : `shot_${ev.el}`); break; }
      case 'chain': A.play('shot_lightning'); break;
      case 'beam': A.play('shot_arcane'); break;
      case 'pulse': A.play(`shot_${ev.el}`); break;
      case 'kill': if (ev.boss) { A.play('boss_kill'); if (vib) vibrate('heavy'); this.app.audio.setMood('battle'); } else A.play('kill'); break;
      case 'leak': A.play('leak'); if (vib) vibrate(ev.boss ? 'heavy' : 'medium'); this.el.classList.add('hurt'); setTimeout(() => this.el.classList.remove('hurt'), 350); break;
      case 'place': A.play('place'); break;
      case 'merge': A.play(ev.hybrid ? 'hybrid' : 'merge'); if (vib) vibrate('medium'); break;
      case 'upgrade': A.play('upgrade'); break;
      case 'sell': A.play('sell'); break;
      case 'ability': if (!ev.mini) { A.play(ev.id); if (vib) vibrate('medium'); } break;
      case 'enemyAbility': if (ev.kind === 'stun') A.play('stun'); break;
      case 'wave': {
        const total = this.b.totalWaves();
        if (ev.boss) {
          const boss = this.b.s.queue.find((q) => ENEMIES[q.e].tags.includes('boss'))!.e;
          this.banner(t('ui.boss_incoming', { name: t(`enemy.${boss}.name`) }), 'boss', enemyThumb(ENEMIES[boss]));
          A.play('boss'); A.setMood('boss');
        } else {
          this.banner(Number.isFinite(total) && ev.n === total - 1 ? t('ui.final_wave') : t('ui.wave_n', { n: ev.n + 1 }));
          A.play('wave');
        }
        break;
      }
      case 'waveClear': this.banner(t('ui.wave_clear', { bonus: ev.bonus }), 'good'); break;
      case 'revive': A.play('heal'); break;
    }
  }

  // ------------------------------------------------------------------ tutorial & contextual hints
  private tut(text: string | null): void {
    const T = this.els.tut;
    T.classList.toggle('hidden', !text);
    if (text) setText(T, text);
  }
  private hand(from: { x: number; y: number } | null, to?: { x: number; y: number }): void {
    const H = this.els.hand;
    H.classList.toggle('hidden', !from);
    if (!from) return;
    H.style.setProperty('--x0', `${from.x}px`); H.style.setProperty('--y0', `${from.y}px`);
    H.style.setProperty('--x1', `${(to ?? from).x}px`); H.style.setProperty('--y1', `${(to ?? from).y}px`);
  }
  private center(el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  private updateTutorial(): void {
    const b = this.b, s = b.s;
    const firstFree = () => b.map.slots.findIndex((_x, i) => !b.towerAt(i));
    const pair = () => { for (const a of s.towers) for (const c of s.towers) if (a.id < c.id && b.mergeCheck(a.id, c.id).ok && s.coins >= 10) return [a, c]; return null; };
    const slotPt = (i: number) => this.view.screenOf(b.slotPos(i).x, b.slotPos(i).y, 0.4);
    const card = this.cards.get('archer') ?? [...this.cards.values()][0];
    if (this.drag || this.boostOpen && this.tutStep !== 4) { this.hand(null); if (this.drag) return; }
    // Steps advance on what the player has actually done, so skipping ahead never blocks.
    if (this.tutStep === 0 && s.towers.length >= 1) this.tutStep = 1;
    if (this.tutStep === 1 && (s.towers.length >= 2 || s.coins < b.buyCost('archer'))) this.tutStep = 2;
    if (this.tutStep <= 2 && (s.phase !== 'prep' || s.wave > 0)) this.tutStep = 3;
    if (this.tutStep === 3 && (s.stats.abilities > 0 || s.wave >= 1 || s.phase === 'boost')) this.tutStep = 4;
    if (this.tutStep === 4 && s.stats.boosts > 0) this.tutStep = 5;
    if (this.tutStep === 5 && s.stats.merges > 0) this.tutStep = 6;
    if (this.tutStep === 6 && (s.stats.upgrades > 0 || s.wave >= 2)) this.tutStep = 7;
    switch (this.tutStep) {
      case 0: case 1: {
        this.tut(t(this.tutStep === 0 ? 'tut.place' : 'tut.place2'));
        const f = firstFree();
        if (f >= 0 && card) this.hand(this.center(card), slotPt(f)); else this.hand(null);
        if (!this.placing && !this.drag) this.showHighlights(0, false);
        break;
      }
      case 2: this.tut(t('tut.start')); this.hand(this.center(this.els.start)); if (!this.placing && !this.drag) this.view.setHighlights(null); break;
      case 3: {
        const ab = this.abilityEls.get('meteor');
        if (ab && s.enemies.length >= 3 && s.abilities[0]?.cd === 0) { this.tut(t('tut.ability')); this.hand(this.center(ab)); }
        else { this.tut(t('tut.watch')); this.hand(null); }
        break;
      }
      case 4: this.tut(s.phase === 'boost' ? t('tut.boost') : t('tut.watch')); this.hand(null); break;
      case 5: {
        const p = pair();
        if (p && !this.modalPause) { this.tut(t('tut.merge')); this.hand(slotPt(p[0].slot), slotPt(p[1].slot)); }
        else if (this.modalPause) { this.tut(t('tut.merge_confirm')); this.hand(null); }
        else { this.tut(t('tut.merge_wait')); this.hand(null); }
        break;
      }
      case 6: this.tut(t('tut.upgrade')); this.hand(null); break;
      default: this.tut(null); this.hand(null);
    }
  }
  /** One-time hints that introduce deeper mechanics when they first become relevant. */
  private updateHints(): void {
    const g = this.app.game, s = this.b.s;
    if (!g.p.tutorial.seen.hybrid && s.ctx.alchemy > 0) {
      for (const a of s.towers) for (const c of s.towers) {
        if (a.id >= c.id) continue;
        const chk = this.b.mergeCheck(a.id, c.id);
        if (chk.ok && chk.options[0].kind === 'hybrid') { g.markTutorial('hybrid'); this.banner(t('hint.hybrid'), 'good'); this.bannerT = 5; return; }
      }
    }
    if (!g.p.tutorial.seen.branch && s.towers.some((x) => x.tier === 2) && s.towers.filter((x) => x.tier === 2).some((a) => s.towers.some((c) => c !== a && c.def === a.def && c.tier === 2))) {
      g.markTutorial('branch');
      this.banner(t('hint.branch'), 'good');
      this.bannerT = 5;
    }
  }

  // ------------------------------------------------------------------ results
  private onFinished(): void {
    const b = this.b, s = b.s, app = this.app;
    this.cancelDrag();
    this.select(0);
    this.tut(null); this.hand(null);
    if (s.phase === 'lost' && !s.revived) {
      // Defeat: optional second chance (ad or gems), otherwise the run is settled.
      if (this.defeatOpen) return;
      this.defeatOpen = true;
      this.modalPause++;
      app.audio.play('lose');
      let decided = false;
      const settle = () => { if (decided) return; decided = true; close(); this.modalPause--; this.defeatOpen = false; this.settle(); };
      const revive = () => { if (decided) return; decided = true; close(); this.modalPause--; this.defeatOpen = false; b.revive(); };
      const close = app.modal(h('div.dialog.center', null,
        h('div.big-icon', null, '💔'), h('h2', null, t('lose.title')), h('p', null, t('lose.continue_text')),
        app.game.adsLeft('revive') > 0 ? btn([h('span', null, t('lose.continue')), h('small', null, '🎬 ', t('ui.free'))], async () => { const r = await app.rewarded('revive'); if (r.ok) revive(); }, 'primary wide', { id: 'btn-revive-ad' }) : null,
        btn([h('span', null, t('lose.continue')), h('small', null, `💎 ${REVIVE_GEMS}`)], () => { const r = app.game.payRevive(); if (r.ok) revive(); else app.toast(t(r.reason), 'warn'); }, 'accent wide', { disabled: !app.game.canPayRevive(), id: 'btn-revive-gems' }),
        btn(t('lose.give_up'), settle, 'ghost wide', { id: 'btn-giveup' })), { dismissable: false });
      return;
    }
    this.settle();
  }

  private settle(): void {
    const app = this.app, b = this.b;
    this.ended = true;
    const res = app.game.finishRun(b.serialize());
    app.writeJournal(null);
    app.flush(true);
    if (!res.ok) {
      app.log.add('finish_run', res.reason);
      app.toast(t(res.reason), 'error');
      app.endBattle(null);
      return;
    }
    this.showResult(res.summary);
  }

  private showResult(sm: RunSummary): void {
    const app = this.app, g = app.game;
    app.audio.setMood('menu');
    app.audio.play(sm.won ? 'win' : 'lose');
    const lvl = LEVEL_BY_ID[sm.levelId];
    const next = sm.won && lvl ? LEVELS[lvl.index + 1] : undefined;
    const rewards = h('div.rewards', null, app.rewardNodes(sm.reward));
    const extra: HTMLElement[] = [];
    if (sm.unlockedTower) extra.push(h('div.unlock', null, h('img.thumb', { src: towerThumb(TOWERS[sm.unlockedTower]), alt: '' }), h('div', null, h('b', null, t('win.new_tower')), h('span', null, t(`tower.${sm.unlockedTower}.name`)))));
    if (sm.unlockedAbility) extra.push(h('div.unlock', null, h('span.big', null, ABILITY_ICON[sm.unlockedAbility]), h('div', null, h('b', null, t('win.new_ability')), h('span', null, t(`ability.${sm.unlockedAbility}.name`)))));
    if (sm.unlockedWorld) extra.push(h('div.unlock', null, h('span.big', null, '🗺️'), h('div', null, h('b', null, t('win.new_world')), h('span', null, t(`world.${WORLDS[sm.unlockedWorld - 1].key}.name`)))));
    if (sm.endlessUnlocked) extra.push(h('div.unlock', null, h('span.big', null, '♾️'), h('div', null, h('b', null, t('win.endless_unlocked')), h('span', null, t('menu.endless')))));
    const doubleBtn = sm.canDouble && g.adsLeft('double_reward') > 0 ? btn([h('span', null, t('win.double')), h('small', null, '🎬 ', t('ui.free'))], async () => {
      const r = await app.rewarded('double_reward');
      if (!r.ok) return;
      const d = g.doubleLastRun();
      if (d.ok) { doubleBtn!.remove(); clear(rewards); rewards.append(...app.rewardNodes({ ...sm.reward, gold: sm.reward.gold * 2, shards: Object.fromEntries(Object.entries(sm.reward.shards).map(([k, v]) => [k, v * 2])) })); app.audio.play('reward'); }
    }, 'accent wide', { id: 'btn-double' }) : null;
    const offer = sm.won && g.shouldOffer() ? h('div.offer', null, h('b', null, '🎁 ', t('offer.title')), h('span', null, t('offer.text')), h('div.row', null,
      btn(t('offer.no'), () => { g.declineOffer(); offer!.remove(); }, 'ghost small', { id: 'btn-offer-no' }),
      btn(['🎬 ', t('offer.yes')], async () => { const r = await app.rewarded('offer_chest'); if (r.ok) { offer!.remove(); if (r.reward) app.rewardPopup(t('offer.title'), r.reward); } }, 'primary small', { id: 'btn-offer-yes' }))) : null;
    const title = sm.mode === 'endless' ? t('endless.result', { n: sm.wave }) : t(sm.won ? 'win.title' : 'lose.title');
    app.modal(h(`div.result${sm.won ? '.won' : ''}`, { id: 'result' },
      h('h1', null, title),
      sm.mode === 'campaign' && sm.won ? h('div.stars', null, [1, 2, 3].map((i) => h(`span.star${i <= sm.stars ? '.on' : ''}`, { style: { animationDelay: `${i * 0.18}s` } }, '★'))) : null,
      sm.bestEndless ? h('p.good', null, t('endless.best')) : null,
      !sm.won && sm.mode === 'campaign' ? h('p.muted', null, t('lose.tip')) : null,
      rewards, extra, doubleBtn, offer,
      h('div.row', null,
        btn(t('ui.to_map'), () => app.endBattle(null, sm.mode === 'endless' ? 'menu' : 'map'), 'ghost', { id: 'btn-result-map' }),
        sm.mode === 'endless' || !sm.won ? btn(t('ui.retry'), () => app.endBattle({ levelId: sm.levelId, mode: sm.mode }), 'primary', { id: 'btn-retry' }) : null,
        next && g.isLevelUnlocked(next.id) ? btn(t('win.next'), () => app.endBattle({ levelId: next.id, mode: 'campaign' }), 'primary', { id: 'btn-next' }) : null)),
      { dismissable: false, cls: 'sheet' });
  }
}
