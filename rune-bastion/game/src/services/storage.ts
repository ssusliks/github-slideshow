/**
 * Key-value storage abstraction. The game talks to a synchronous interface (so saves can be
 * flushed inside lifecycle handlers); on native builds every write is mirrored to
 * Capacitor Preferences, which survives WebView storage eviction, and restored on boot.
 */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
  keys(): string[];
}

export class MemoryKV implements KV {
  map = new Map<string, string>();
  /** when set, writes fail (tests for quota / storage errors). */
  failWrites = false;
  get(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  set(k: string, v: string) { if (this.failWrites) return false; this.map.set(k, v); return true; }
  remove(k: string) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}

interface PreferencesLike {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

export class BrowserKV implements KV {
  private mem = new Map<string, string>();
  private ls: Storage | null = null;
  private prefs: PreferencesLike | null = null;
  constructor(private prefix = 'rb.') {
    try {
      const t = `${prefix}__t`;
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      this.ls = window.localStorage;
    } catch {
      this.ls = null; // private mode / blocked storage: fall back to memory for this session
    }
  }
  /** Connects the durable native mirror and restores keys missing from localStorage. */
  async attachNative(prefs: PreferencesLike): Promise<void> {
    this.prefs = prefs;
    try {
      const { keys } = await prefs.keys();
      for (const k of keys) {
        if (!k.startsWith(this.prefix)) continue;
        if (this.get(k.slice(this.prefix.length)) === null) {
          const { value } = await prefs.get({ key: k });
          if (value !== null) this.writeLocal(k, value);
        }
      }
    } catch (e) {
      console.warn('native storage mirror unavailable', e);
    }
  }
  private writeLocal(full: string, v: string): boolean {
    this.mem.set(full, v);
    if (!this.ls) return true;
    try { this.ls.setItem(full, v); return true; } catch { return false; }
  }
  get(k: string): string | null {
    const full = this.prefix + k;
    if (this.ls) { try { const v = this.ls.getItem(full); if (v !== null) return v; } catch { /* fall through */ } }
    return this.mem.get(full) ?? null;
  }
  set(k: string, v: string): boolean {
    const full = this.prefix + k;
    const ok = this.writeLocal(full, v);
    this.prefs?.set({ key: full, value: v }).catch(() => undefined);
    return ok || !!this.prefs;
  }
  remove(k: string): void {
    const full = this.prefix + k;
    this.mem.delete(full);
    try { this.ls?.removeItem(full); } catch { /* ignore */ }
    this.prefs?.remove({ key: full }).catch(() => undefined);
  }
  keys(): string[] {
    const out = new Set<string>();
    for (const k of this.mem.keys()) out.add(k.slice(this.prefix.length));
    try { if (this.ls) for (let i = 0; i < this.ls.length; i++) { const k = this.ls.key(i)!; if (k.startsWith(this.prefix)) out.add(k.slice(this.prefix.length)); } } catch { /* ignore */ }
    return [...out];
  }
}
