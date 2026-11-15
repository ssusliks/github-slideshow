import type { KV } from './storage';

/**
 * Diagnostics + fault isolation. Keeps a small ring buffer of technical events (no personal
 * data), installs global error handlers, and provides circuit breakers so a misbehaving
 * subsystem (ads SDK, store, network) is switched off instead of taking the game down.
 */
export interface LogEntry { t: number; kind: string; msg: string }

export class Breaker {
  private fails = 0;
  private openUntil = 0;
  constructor(readonly name: string, private limit = 3, private coolMs = 120000, private now: () => number = Date.now) {}
  get open(): boolean {
    return this.now() < this.openUntil;
  }
  ok(): void {
    this.fails = 0;
  }
  fail(): void {
    if (++this.fails >= this.limit) {
      this.openUntil = this.now() + this.coolMs;
      this.fails = 0;
    }
  }
}

export class TimeoutError extends Error {
  constructor(label: string) {
    super(`timeout: ${label}`);
  }
}
/** Rejects when `p` does not settle in time – guards against endless loading states. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new TimeoutError(label)), ms);
    p.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });
}

export class Log {
  entries: LogEntry[] = [];
  private breakers = new Map<string, Breaker>();
  /** called for errors the player should hear about (kind, message). */
  onFatal: ((kind: string, msg: string) => void) | null = null;
  private lastBeat = Date.now();
  private hangReported = false;

  constructor(private kv: KV | null, private max = 120) {
    try {
      const raw = kv?.get('log');
      if (raw) this.entries = JSON.parse(raw).slice(-max);
    } catch { this.entries = []; }
  }

  add(kind: string, msg: unknown): void {
    const text = msg instanceof Error ? `${msg.name}: ${msg.message}\n${(msg.stack ?? '').split('\n').slice(0, 4).join('\n')}` : String(msg);
    this.entries.push({ t: Date.now(), kind, msg: text.slice(0, 600) });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    try { this.kv?.set('log', JSON.stringify(this.entries)); } catch { /* logging must never throw */ }
  }

  breaker(name: string): Breaker {
    let b = this.breakers.get(name);
    if (!b) this.breakers.set(name, (b = new Breaker(name)));
    return b;
  }

  /** Runs `fn`; an exception is logged and swallowed, returning `fallback`. */
  guard<T>(kind: string, fn: () => T, fallback: T): T {
    try { return fn(); } catch (e) { this.add(kind, e); return fallback; }
  }

  installGlobalHandlers(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (e) => {
      this.add('error', e.error ?? e.message);
      this.onFatal?.('error', String(e.message));
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.add('rejection', (e as PromiseRejectionEvent).reason);
    });
    // Watchdog: the frame loop calls beat(); a long silence while visible is recorded as a hang.
    setInterval(() => {
      if (document.visibilityState !== 'visible') { this.lastBeat = Date.now(); return; }
      const gap = Date.now() - this.lastBeat;
      if (gap > 6000 && !this.hangReported) { this.hangReported = true; this.add('hang', `main loop silent for ${gap}ms`); }
      if (gap < 2000) this.hangReported = false;
    }, 2000);
  }
  beat(): void {
    this.lastBeat = Date.now();
  }

  /** Technical report attached to support tickets (only with the player's consent). */
  report(extra: Record<string, unknown>): string {
    return JSON.stringify({ ...extra, entries: this.entries.slice(-60) });
  }
  clear(): void {
    this.entries = [];
    this.kv?.remove('log');
  }
}
