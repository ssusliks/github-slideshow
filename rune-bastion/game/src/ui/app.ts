import { CONFIG, applyRuntimeOverrides } from '../config';
import type { BattleState } from '../core/battle';
import { AD_PLACEMENTS, PREMIUM_BENEFITS, Reward } from '../data/meta';
import { TOWERS } from '../data/towers';
import { ActiveRun, Game } from '../meta/game';
import type { Profile } from '../meta/profile';
import { BattleView } from '../render/view';
import { AdService, createAdProvider } from '../services/ads';
import { AudioService } from '../services/audio';
import { CloudService, SyncStatus } from '../services/cloud';
import { randomId } from '../services/hash';
import { setLang, t } from '../services/i18n';
import { PurchaseService, createBillingProvider } from '../services/iap';
import { checkIntegrity } from '../services/integrity';
import { Log } from '../services/log';
import { AdaptiveQuality, FrameLimiter } from '../services/perf';
import { installLifecycle, integrityPlugin, isNative, nativePreferences, vibrate } from '../services/platform';
import { SaveService } from '../services/save';
import { Settings, loadSettings, saveSettings } from '../services/settings';
import { BrowserKV } from '../services/storage';
import { BattleScreen } from './battle';
import { btn, clear, fmtNum, h } from './dom';
import { SCREENS } from './screens';

export interface RunJournal { run: ActiveRun; clean: boolean; snapshot: BattleState | null }

/**
 * Application shell: owns the services, the single frame loop, navigation and the
 * lifecycle (pause / resume / periodic saves). Screens receive it as their only dependency.
 */
export class App {
  kv = new BrowserKV('rb.');
  settings!: Settings;
  log!: Log;
  saveSvc!: SaveService;
  game!: Game;
  cloud!: CloudService;
  ads!: AdService;
  iap!: PurchaseService;
  audio = new AudioService();
  limiter = new FrameLimiter(30);
  quality!: AdaptiveQuality;
  view: BattleView | null = null;
  battle: BattleScreen | null = null;
  /** integrity verdict: true when the build looks modified (online features get restricted). */
  modified = false;
  timeOffset = 0;

  root = document.getElementById('app')!;
  private stage = document.getElementById('stage') as HTMLCanvasElement;
  private textLayer = document.getElementById('ftext')!;
  private screenEl = document.getElementById('screen')!;
  private modalEl = document.getElementById('modals')!;
  private toastEl = document.getElementById('toasts')!;
  private current = 'boot';
  private params: any = null;
  private dirty = false;
  private critical = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedAt = 0;
  private lastTick = 0;
  private modalStack: { el: HTMLElement; onBack?: () => void }[] = [];

  now = (): number => Date.now() + this.timeOffset;

  // ------------------------------------------------------------------ boot
  async boot(): Promise<void> {
    applyRuntimeOverrides(location.search);
    const prefs = await nativePreferences();
    if (prefs) await this.kv.attachNative(prefs);
    this.log = new Log(this.kv);
    this.log.installGlobalHandlers();
    this.log.onFatal = () => { if (this.battle) this.battle.onRuntimeError(); };
    this.settings = loadSettings(this.kv);
    setLang(this.settings.lang);
    this.limiter.fps = this.settings.fps;
    this.audio.setVolumes(this.settings.sfx, this.settings.music);

    this.saveSvc = new SaveService(this.kv, () => Date.now());
    const loaded = this.saveSvc.load();
    for (const i of loaded.incidents) this.log.add('save', i);
    this.game = this.makeGame(loaded.profile);

    this.cloud = new CloudService(this.kv, this.saveSvc, this.log.breaker('cloud'), this.now, (k, m) => this.log.add(k, m));
    this.ads = new AdService(createAdProvider(() => ({ title: t('ad.sim.title'), skip: t('ad.sim.skip'), claim: t('ad.sim.claim') })), this.log.breaker('ads'), (k, m) => this.log.add(k, m));
    this.iap = new PurchaseService(
      createBillingProvider((id, price) => this.confirm(t('iap.sandbox.title'), t('iap.sandbox.text', { item: t(`iap.${id}.name`), price }), t('iap.sandbox.pay'), t('ui.cancel')), () => randomId(8)),
      () => this.game, this.kv, this.log.breaker('iap'), () => this.cloud.auth?.token, (k, m) => this.log.add(k, m), () => this.flush(true),
    );
    this.quality = new AdaptiveQuality((s) => {
      if (!this.view) return;
      this.view.setResolutionScale(s.scale);
      this.view.particles.intensity = this.settings.fx * s.fx;
      if (s.thermal >= 2) this.toast(t('ui.thermal'), 'warn');
    });
    this.quality.auto = this.settings.quality === 'auto';

    document.addEventListener('pointerdown', () => this.audio.unlock(), { passive: true });
    document.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement)?.closest?.('button');
      if (b && !b.hasAttribute('data-quiet')) { this.audio.play('click'); if (this.settings.vibration) vibrate('light'); }
    }, true);
    window.addEventListener('resize', () => this.view?.resize());
    window.addEventListener('online', () => void this.syncCloud(false));
    await installLifecycle({ onPause: () => this.onPause(), onResume: () => this.onResume(), onBack: () => this.back() });
    setInterval(() => this.heartbeat(), 20000);
    requestAnimationFrame((ts) => this.loop(ts));

    (document.getElementById('boot') as HTMLElement)?.remove();
    this.nav('menu');
    if (loaded.status === 'restored_backup') this.toast(t('save.restored'), 'warn');
    if (loaded.status === 'unsigned_sanitized') this.toast(t('save.unverified'), 'warn');

    await this.resumeJournal();
    this.afterBootPopups();
    // Online / SDK initialisation never blocks the game.
    void this.initOnline();
  }

  private makeGame(p: Profile): Game {
    return new Game(p, {
      now: this.now,
      onChange: (critical) => this.markDirty(critical),
      log: (k, d) => this.log.add(`sec_${k}`, d),
    });
  }

  private async initOnline(): Promise<void> {
    try {
      const verdict = await checkIntegrity();
      this.modified = verdict.modified;
      if (verdict.modified) { this.log.add('integrity', verdict.reason); this.cloud.restricted = true; }
    } catch (e) { this.log.add('integrity', e); }
    void this.ads.init();
    void this.iap.init().then(() => this.refresh());
    const off = await this.cloud.timeOffset();
    // Only trust the server clock when the device clock is clearly off (more than two minutes).
    if (off !== null && Math.abs(off) > 120000) { this.timeOffset = off; this.log.add('time', `device clock off by ${Math.round(off / 1000)}s`); }
    await this.syncCloud(false);
    const ip = integrityPlugin();
    if (ip) setInterval(() => ip.getThermal().then((r) => this.quality.setNativeThermal(r.status)).catch(() => undefined), 15000);
  }

  // ------------------------------------------------------------------ persistence
  markDirty(critical = false): void {
    this.dirty = true;
    if (critical) this.critical = true;
    if (critical) { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush(), 0); }
    else if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), 1500);
    this.refreshTop();
  }
  /** Writes the profile now (sync). Safe to call from lifecycle handlers. */
  flush(forceBackup = false): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty && !forceBackup) return;
    const ok = this.log.guard('save_write', () => this.saveSvc.save(this.game.p, forceBackup || this.critical), false);
    this.dirty = false;
    this.critical = false;
    if (!ok) this.toast(t('save.failed'), 'error');
  }
  private heartbeat(): void {
    if (document.visibilityState !== 'visible') return;
    const now = performance.now();
    if (this.lastTick) this.game.addPlaytime((now - this.lastTick) / 1000);
    this.lastTick = now;
    this.game.markSeen();
    this.game.refreshPeriods();
    this.markDirty();
  }

  writeJournal(j: RunJournal | null): void {
    if (j) this.kv.set('run', JSON.stringify(j, (_k, v) => (v === Infinity ? '__inf' : v)));
    else this.kv.remove('run');
  }
  readJournal(): RunJournal | null {
    try {
      const j = JSON.parse(this.kv.get('run') ?? 'null', (_k, v) => (v === '__inf' ? Infinity : v));
      return j && j.run && typeof j.run.runId === 'string' ? j : null;
    } catch { return null; }
  }

  /**
   * Run recovery on start. A journal marked `clean` was written while the app was going to the
   * background, so the battle can be resumed from its snapshot. Anything else means the process
   * died mid-battle: the player is returned to the start of that level, with no rewards.
   */
  private async resumeJournal(): Promise<void> {
    const j = this.readJournal();
    if (!j) return;
    if (this.game.hasGrant(`run:${j.run.runId}`)) { this.writeJournal(null); return; }
    if (j.clean && j.snapshot) {
      const go = await this.confirm(t('resume.title'), t('resume.text'), t('resume.continue'), t('resume.abandon'));
      if (go) { this.startBattle(j.run.levelId, j.run.mode, j); return; }
      this.writeJournal(null);
      return;
    }
    this.log.add('crash_recovery', `run ${j.run.levelId} was interrupted`);
    this.writeJournal(null);
    const again = await this.confirm(t('crash.title'), t('crash.text'), t('crash.restart'), t('ui.to_menu'));
    if (again) this.startBattle(j.run.levelId, j.run.mode);
  }

  private afterBootPopups(): void {
    if (this.battle) return;
    const off = this.game.pendingOffline();
    if (off.gold > 0 && off.seconds >= 120 && this.game.clearedCount() > 0) SCREENS.offlinePopup(this);
    else this.game.markSeen();
  }

  // ------------------------------------------------------------------ lifecycle
  private onPause(): void {
    this.pausedAt = Date.now();
    this.audio.pause();
    this.log.guard('pause', () => {
      this.battle?.suspend();
      this.game.markSeen();
      this.dirty = true;
      this.flush(true);
    }, undefined);
  }
  private onResume(): void {
    this.audio.resume();
    this.limiter.reset();
    this.lastTick = performance.now();
    const away = Date.now() - this.pausedAt;
    this.battle?.resumeFromBackground();
    if (!this.battle) {
      this.game.refreshPeriods();
      if (away > 5 * 60000) this.afterBootPopups();
      this.refresh();
    }
    if (away > 60000) void this.syncCloud(false);
  }
  back(): void {
    const top = this.modalStack[this.modalStack.length - 1];
    if (top) { if (top.onBack) top.onBack(); return; }
    if (this.battle) { this.battle.togglePause(true); return; }
    if (this.current !== 'menu') this.nav('menu');
  }

  // ------------------------------------------------------------------ frame loop
  private loop(ts: number): void {
    requestAnimationFrame((x) => this.loop(x));
    this.log.beat();
    if (!this.battle) return;
    const cap = this.quality.state.fpsCap || this.settings.fps;
    this.limiter.fps = Math.min(cap, this.settings.fps) as 30 | 60;
    const dt = this.limiter.tick(ts);
    if (dt <= 0) return;
    try {
      this.battle.frame(dt);
      this.quality.frame(dt, this.limiter.fps);
    } catch (e) {
      this.log.add('battle_frame', e);
      this.battle.onRuntimeError();
    }
  }

  // ------------------------------------------------------------------ navigation
  nav(screen: string, params: any = null): void {
    if (this.battle) return;
    this.current = screen;
    this.params = params;
    this.refresh();
    this.audio.setMood('menu');
  }
  refresh(): void {
    if (this.battle) return;
    const make = (SCREENS as any)[this.current] ?? SCREENS.menu;
    const scroll = this.screenEl.querySelector('.scroll')?.scrollTop ?? 0;
    clear(this.screenEl);
    this.root.classList.remove('in-battle');
    this.screenEl.appendChild(SCREENS.frame(this, this.current, this.log.guard('screen', () => make(this, this.params), h('div.pad', null, t('err.screen')))));
    const sc = this.screenEl.querySelector('.scroll');
    if (sc) sc.scrollTop = scroll;
  }
  get screen(): string {
    return this.current;
  }
  refreshTop(): void {
    const g = this.game?.p;
    if (!g) return;
    for (const [k, v] of [['gold', g.gold], ['gems', g.gems], ['essence', g.essence]] as const) {
      const el = this.root.querySelector(`[data-cur="${k}"]`);
      if (el && el.textContent !== fmtNum(v)) el.textContent = fmtNum(v);
    }
  }

  // ------------------------------------------------------------------ battle
  startBattle(levelId: string, mode: 'campaign' | 'endless', resume?: RunJournal): void {
    if (this.battle) return;
    let ctx, run: ActiveRun, saved: BattleState | undefined;
    if (resume?.snapshot) {
      run = resume.run;
      this.game.activeRun = run;
      ctx = resume.snapshot.ctx;
      saved = resume.snapshot;
    } else {
      const r = this.game.beginRun(levelId, mode, randomId(10));
      if (!r.ok) { this.toast(t(r.reason), 'error'); return; }
      ctx = r.ctx; run = r.run;
    }
    try {
      if (!this.view) {
        const q = this.settings.quality === 'auto' ? 'medium' : this.settings.quality;
        this.view = new BattleView(this.stage, this.textLayer, { quality: q, fx: this.settings.fx, shake: this.settings.shake });
      }
      this.closeAllModals();
      clear(this.screenEl);
      this.root.classList.add('in-battle');
      this.battle = new BattleScreen(this, this.view, ctx, run, saved);
      this.screenEl.appendChild(this.battle.el);
      this.writeJournal({ run, clean: false, snapshot: null });
      this.limiter.reset();
    } catch (e) {
      // WebGL unavailable or a content error: fail safe back to the menu.
      this.log.add('battle_start', e);
      this.battle = null;
      this.game.abandonRun();
      this.writeJournal(null);
      this.root.classList.remove('in-battle');
      this.toast(t('err.battle_start'), 'error');
      this.nav('menu');
    }
  }
  endBattle(next?: { levelId: string; mode: 'campaign' | 'endless' } | null, to = 'map'): void {
    this.battle?.dispose();
    this.battle = null;
    this.writeJournal(null);
    this.root.classList.remove('in-battle');
    this.flush(true);
    if (next) { this.startBattle(next.levelId, next.mode); return; }
    this.nav(to);
    void this.syncCloud(false);
  }

  applySettings(): void {
    saveSettings(this.kv, this.settings);
    setLang(this.settings.lang);
    this.limiter.fps = this.settings.fps;
    this.audio.setVolumes(this.settings.sfx, this.settings.music);
    this.quality.auto = this.settings.quality === 'auto';
    if (this.view) this.view.applySettings({ quality: this.settings.quality === 'auto' ? 'medium' : this.settings.quality, fx: this.settings.fx * this.quality.state.fx, shake: this.settings.shake });
  }

  // ------------------------------------------------------------------ cloud
  /** Replaces the live profile (cloud download / backup restore). The old one is snapshotted first. */
  adoptProfile(p: Profile, snapshotOld = true): void {
    if (snapshotOld) this.saveSvc.snapshot(this.game.p, 'bak.pre');
    this.game = this.makeGame(p);
    this.dirty = true;
    this.flush(true);
    this.refresh();
  }
  async syncCloud(manual: boolean, prefer?: 'local' | 'remote'): Promise<SyncStatus> {
    if (this.battle && !manual) return 'error';
    this.flush();
    const res = await this.cloud.sync(this.game.p, prefer);
    if (res.profile) { this.adoptProfile(res.profile, false); this.toast(t(res.status === 'conflict_took_remote' ? 'cloud.took_remote' : 'cloud.downloaded')); }
    else if (res.status === 'conflict_kept_local') this.toast(t('cloud.kept_local'));
    else if (manual) this.toast(t(`cloud.status.${res.status}`), res.status === 'error' || res.status === 'restricted' ? 'error' : undefined);
    if (manual && this.current === 'settings') this.refresh();
    return res.status;
  }

  // ------------------------------------------------------------------ rewarded ads
  /**
   * Optional rewarded action. Premium owners skip the video (a listed Premium benefit); daily
   * caps apply to everyone. Resolves true only when the reward condition was really met.
   */
  async rewarded(placement: string): Promise<{ ok: boolean; reward?: ReturnType<Game['resolveReward']> }> {
    if (!AD_PLACEMENTS[placement] || this.game.adsLeft(placement) <= 0) { this.toast(t('ad.limit'), 'warn'); return { ok: false }; }
    if (!(this.game.isPremium() && PREMIUM_BENEFITS.skipAds)) {
      if (!this.ads.available) { this.toast(t('ad.unavailable'), 'warn'); return { ok: false }; }
      this.battle?.setAdPause(true);
      const r = await this.ads.showRewarded(placement);
      this.battle?.setAdPause(false);
      if (!r.completed) { if (r.reason !== 'closed') this.toast(t('ad.unavailable'), 'warn'); return { ok: false }; }
    }
    const done = this.game.completeAd(placement, randomId(8));
    if (!done.ok) { this.toast(t(done.reason), 'warn'); return { ok: false }; }
    return { ok: true, reward: done.reward };
  }

  // ------------------------------------------------------------------ modals & toasts
  toast(text: string, kind?: 'warn' | 'error' | 'good'): void {
    const el = h(`div.toast${kind ? '.' + kind : ''}`, null, text);
    this.toastEl.appendChild(el);
    while (this.toastEl.children.length > 3) this.toastEl.firstChild!.remove();
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
    if (kind === 'error') this.audio.play('deny');
  }
  /** Opens a modal sheet; returns a function that closes it. `onBack` handles the hardware back button. */
  modal(content: HTMLElement, opts: { dismissable?: boolean; cls?: string; onClose?: () => void } = {}): () => void {
    const wrap = h(`div.modal-wrap${opts.cls ? '.' + opts.cls : ''}`);
    const close = () => {
      if (!wrap.isConnected) return;
      wrap.remove();
      this.modalStack = this.modalStack.filter((m) => m.el !== wrap);
      opts.onClose?.();
    };
    if (opts.dismissable !== false) wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
    wrap.appendChild(h('div.modal', null, opts.dismissable !== false ? btn('✕', close, 'x', { 'aria-label': 'close' }) : null, content));
    this.modalEl.appendChild(wrap);
    this.modalStack.push({ el: wrap, onBack: opts.dismissable !== false ? close : undefined });
    return close;
  }
  closeAllModals(): void {
    clear(this.modalEl);
    this.modalStack = [];
  }
  confirm(title: string, text: string, yes: string, no: string): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      const answer = (v: boolean) => { if (answered) return; answered = true; close(); resolve(v); };
      const close = this.modal(h('div.dialog', null, h('h2', null, title), h('p', null, text), h('div.row', null, btn(no, () => answer(false), 'ghost'), btn(yes, () => answer(true), 'primary'))), { dismissable: false });
    });
  }
  rewardNodes(r: Reward | ReturnType<Game['resolveReward']>): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (r.gold) out.push(h('span.rw', null, '🪙 ', fmtNum(r.gold)));
    if (r.gems) out.push(h('span.rw', null, '💎 ', fmtNum(r.gems)));
    if (r.essence) out.push(h('span.rw', null, '🔮 ', fmtNum(r.essence)));
    if ('randomShards' in r && r.randomShards) out.push(h('span.rw', null, '🧩 ', r.randomShards));
    for (const k of Object.keys(r.shards ?? {})) if (TOWERS[k]) out.push(h('span.rw', null, '🧩 ', `${t(`tower.${k}.name`)} ×${r.shards![k]}`));
    if (r.cosmetic) out.push(h('span.rw', null, '🏰 ', t(`cos.${r.cosmetic}`)));
    return out;
  }
  rewardPopup(title: string, r: Reward | ReturnType<Game['resolveReward']>): void {
    this.audio.play('reward');
    const close = this.modal(h('div.dialog.center', null, h('div.big-icon', null, '🎁'), h('h2', null, title), h('div.rewards', null, this.rewardNodes(r)), btn(t('ui.great'), () => close(), 'primary')));
  }
  get isNative(): boolean {
    return isNative();
  }
  get config() {
    return CONFIG;
  }
}
