/**
 * Frame pacing and adaptive quality.
 *  - FrameLimiter caps rendering at 30 or 60 fps (never above 60) on top of requestAnimationFrame.
 *  - AdaptiveQuality watches real frame times and lowers resolution / effects when the device
 *    cannot hold the target, and again when the OS reports (or the trend suggests) overheating.
 */
export class FrameLimiter {
  private acc = 0;
  private last = 0;
  constructor(public fps: 30 | 60 = 30) {}
  /** Returns the delta (seconds) to simulate when a frame is due, otherwise 0. */
  tick(nowMs: number): number {
    if (!this.last) { this.last = nowMs; return 0; }
    const interval = 1000 / Math.min(60, this.fps);
    const elapsed = nowMs - this.last;
    // 60 fps: run on every rAF. 30 fps: skip frames until a full interval has passed (with tolerance for jitter).
    if (elapsed < interval - 3) return 0;
    this.last = elapsed > interval * 4 ? nowMs : nowMs - ((elapsed - interval) % interval) * (this.fps === 60 ? 0 : 1);
    this.acc = elapsed;
    return Math.min(0.1, elapsed / 1000);
  }
  reset(): void {
    this.last = 0;
  }
}

export type ThermalLevel = 0 | 1 | 2 | 3;
export interface QualityState {
  /** resolution scale 0.6..1. */
  scale: number;
  /** effects multiplier 0.3..1. */
  fx: number;
  /** fps cap forced by thermal protection (0 = none). */
  fpsCap: 0 | 30;
  thermal: ThermalLevel;
  avgFps: number;
}

export class AdaptiveQuality {
  state: QualityState = { scale: 1, fx: 1, fpsCap: 0, thermal: 0, avgFps: 0 };
  private samples: number[] = [];
  private lowFor = 0;
  private highFor = 0;
  private baseline = 0;
  private degradedFor = 0;
  private nativeThermal: ThermalLevel = 0;
  /** adaptive steps are only applied in "auto" quality mode; thermal protection always is. */
  auto = true;

  constructor(private onChange: (s: QualityState) => void) {}

  /** Android thermal status (PowerManager): 0 none, 1 light, 2 moderate, 3+ severe. */
  setNativeThermal(status: number): void {
    this.nativeThermal = (status >= 3 ? 3 : status >= 2 ? 2 : status >= 1 ? 1 : 0) as ThermalLevel;
  }

  /** Feed one rendered frame. `dt` in seconds, `targetFps` is the user's cap. */
  frame(dt: number, targetFps: number): void {
    if (dt <= 0 || dt > 0.5) return;
    this.samples.push(dt);
    if (this.samples.length < 45) return;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    const window = avg * this.samples.length;
    this.samples.length = 0;
    const fps = 1 / avg;
    const s = this.state;
    s.avgFps = fps;
    let changed = false;
    if (this.auto) {
      if (fps < targetFps * 0.82) { this.lowFor += window; this.highFor = 0; } else if (fps > targetFps * 0.95) { this.highFor += window; this.lowFor = 0; }
      if (this.lowFor > 2.5 && (s.scale > 0.6 || s.fx > 0.3)) {
        if (s.fx > 0.5) s.fx = Math.max(0.3, s.fx - 0.25); else s.scale = Math.max(0.6, s.scale - 0.15);
        this.lowFor = 0; changed = true;
      } else if (this.highFor > 20 && (s.scale < 1 || s.fx < 1) && s.thermal < 2) {
        if (s.scale < 1) s.scale = Math.min(1, s.scale + 0.15); else s.fx = Math.min(1, s.fx + 0.25);
        this.highFor = 0; changed = true;
      }
    }
    // Thermal heuristic for platforms without a thermal API (iOS webview, browsers):
    // a device that used to hold the target and then degrades for a long time is throttling.
    if (!this.baseline && fps > targetFps * 0.95) this.baseline = fps;
    if (this.baseline && fps < this.baseline * 0.7) this.degradedFor += window; else this.degradedFor = Math.max(0, this.degradedFor - window);
    const heuristic: ThermalLevel = this.degradedFor > 45 ? 2 : this.degradedFor > 20 ? 1 : 0;
    const thermal = Math.max(this.nativeThermal, heuristic) as ThermalLevel;
    if (thermal !== s.thermal) {
      s.thermal = thermal;
      if (thermal >= 2) { s.fx = Math.min(s.fx, 0.4); s.scale = Math.min(s.scale, 0.75); s.fpsCap = 30; }
      else if (thermal === 1) { s.fx = Math.min(s.fx, 0.7); s.fpsCap = 0; }
      else s.fpsCap = 0;
      changed = true;
    }
    if (changed) this.onChange({ ...s });
  }
}
