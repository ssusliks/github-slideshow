import { CONFIG } from '../config';
import type { Breaker } from './log';
import { withTimeout } from './log';
import { isNative, platformName } from './platform';

/**
 * Rewarded ads behind one interface. The game only ever asks "show a rewarded ad for placement X"
 * and gets back whether the reward was earned – SDK errors, timeouts and missing fill are all
 * reported as { completed: false } and can never crash or block gameplay.
 */
export interface AdResult { completed: boolean; reason?: 'no_fill' | 'closed' | 'error' | 'timeout' | 'unavailable' }
export interface AdProvider {
  readonly name: string;
  init(): Promise<void>;
  showRewarded(placement: string): Promise<AdResult>;
}

/** Google AdMob through @capacitor-community/admob (Android / iOS). */
export class AdMobProvider implements AdProvider {
  readonly name = 'admob';
  private mod: typeof import('@capacitor-community/admob') | null = null;
  async init(): Promise<void> {
    this.mod = await import('@capacitor-community/admob');
    await this.mod.AdMob.initialize({ initializeForTesting: CONFIG.admob.testing });
  }
  async showRewarded(_placement: string): Promise<AdResult> {
    const m = this.mod;
    if (!m) return { completed: false, reason: 'unavailable' };
    const adId = platformName() === 'ios' ? CONFIG.admob.rewardedIos : CONFIG.admob.rewardedAndroid;
    let rewarded = false;
    const handles = [
      await m.AdMob.addListener(m.RewardAdPluginEvents.Rewarded, () => { rewarded = true; }),
    ];
    try {
      await m.AdMob.prepareRewardVideoAd({ adId, isTesting: CONFIG.admob.testing });
      await m.AdMob.showRewardVideoAd();
      return rewarded ? { completed: true } : { completed: false, reason: 'closed' };
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      return { completed: false, reason: /no fill|no ad/i.test(msg) ? 'no_fill' : 'error' };
    } finally {
      for (const h of handles) h.remove().catch(() => undefined);
    }
  }
}

/**
 * Development / browser provider: shows a clearly labelled test overlay with a countdown.
 * It exercises the exact same reward pipeline as the real SDK (used by automated tests).
 */
export class SimulatedAdProvider implements AdProvider {
  readonly name = 'simulated';
  constructor(private labels: () => { title: string; skip: string; claim: string }, private seconds = 3) {}
  async init(): Promise<void> { /* nothing to load */ }
  showRewarded(placement: string): Promise<AdResult> {
    return new Promise((resolve) => {
      const l = this.labels();
      const root = document.createElement('div');
      root.className = 'adsim';
      root.dataset.placement = placement;
      root.innerHTML = `<div class="adsim-box"><div class="adsim-tag">TEST AD</div><div class="adsim-title"></div><div class="adsim-count"></div><button class="btn adsim-claim" disabled></button><button class="adsim-skip"></button></div>`;
      (root.querySelector('.adsim-title') as HTMLElement).textContent = l.title;
      const count = root.querySelector('.adsim-count') as HTMLElement, claim = root.querySelector('.adsim-claim') as HTMLButtonElement, skip = root.querySelector('.adsim-skip') as HTMLButtonElement;
      claim.textContent = l.claim; skip.textContent = l.skip;
      let left = this.seconds;
      count.textContent = String(left);
      const done = (r: AdResult) => { clearInterval(timer); root.remove(); resolve(r); };
      const timer = setInterval(() => {
        left--;
        count.textContent = left > 0 ? String(left) : '✓';
        if (left <= 0) { claim.disabled = false; clearInterval(timer); }
      }, 1000);
      claim.onclick = () => done({ completed: true });
      skip.onclick = () => done({ completed: false, reason: 'closed' });
      document.body.appendChild(root);
    });
  }
}

export class AdService {
  private ready = false;
  private showing = false;
  constructor(private provider: AdProvider | null, private breaker: Breaker, private log: (kind: string, msg: unknown) => void) {}

  get available(): boolean {
    return !!this.provider && this.ready && !this.breaker.open;
  }
  get providerName(): string {
    return this.provider?.name ?? 'none';
  }
  async init(): Promise<void> {
    if (!this.provider) return;
    try {
      await withTimeout(this.provider.init(), 10000, 'ads.init');
      this.ready = true;
    } catch (e) {
      this.log('ads_init', e);
      this.breaker.fail();
    }
  }
  /** Shows a rewarded ad. Never throws; a hung SDK is cut off by a timeout. */
  async showRewarded(placement: string): Promise<AdResult> {
    if (!this.available || this.showing) return { completed: false, reason: 'unavailable' };
    this.showing = true;
    try {
      const r = await withTimeout(this.provider!.showRewarded(placement), 90000, 'ads.show');
      if (r.completed || r.reason === 'closed' || r.reason === 'no_fill') this.breaker.ok();
      else this.breaker.fail();
      return r;
    } catch (e) {
      this.log('ads_show', e);
      this.breaker.fail();
      return { completed: false, reason: String((e as Error)?.message).startsWith('timeout') ? 'timeout' : 'error' };
    } finally {
      this.showing = false;
    }
  }
}

export function createAdProvider(labels: () => { title: string; skip: string; claim: string }): AdProvider | null {
  if (isNative()) return new AdMobProvider();
  return CONFIG.dev ? new SimulatedAdProvider(labels) : null;
}
