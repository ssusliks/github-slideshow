import { Profile, newProfile, progressScore, sanitizeProfile } from '../meta/profile';
import { hmacHex, randomId, safeEqual, sha256Hex } from './hash';
import type { KV } from './storage';

/**
 * Local persistence with integrity protection and rolling backups.
 *
 * Layout (all keys under the KV prefix):
 *   save        current profile envelope
 *   bak.0..2    previous good versions (rotated at most every BACKUP_INTERVAL)
 *   bak.pre     snapshot taken before a critical operation (cloud overwrite, restore, wipe)
 *   bak.alt     the "other side" of a resolved cloud conflict
 *   corrupt     last unreadable blob, kept for support
 *   device      per-install secret used to sign envelopes
 *
 * The signature stops casual save editing and detects corruption. It cannot stop a determined
 * attacker who extracts the key from the device – server-side checks cover what matters online.
 */
const APP_SALT = 'rune-bastion/v1/5f1c0a';
const ROLLING = ['bak.0', 'bak.1', 'bak.2'];
export const BACKUP_INTERVAL = 5 * 60 * 1000;

export interface Envelope { v: 1; savedAt: number; data: Profile; mac: string }
export type LoadStatus = 'new' | 'ok' | 'restored_backup' | 'unsigned_sanitized';
export interface LoadResult { profile: Profile; status: LoadStatus; incidents: string[] }
export interface BackupInfo { slot: string; savedAt: number; score: number; cleared: number; gold: number; gems: number }

export class SaveService {
  private key: string;
  private lastBackupAt = 0;
  /** set when a write failed (quota, storage error) so the UI can warn the player. */
  writeFailed = false;

  constructor(private kv: KV, private now: () => number = Date.now) {
    let dev = kv.get('device');
    if (!dev || dev.length < 32) {
      dev = randomId(32);
      kv.set('device', dev);
    }
    this.key = sha256Hex(`${dev}:${APP_SALT}`);
  }

  private sign(data: Profile, savedAt: number): string {
    return hmacHex(this.key, `${savedAt}:${JSON.stringify(data)}`);
  }
  private encode(p: Profile): string {
    const savedAt = this.now();
    const env: Envelope = { v: 1, savedAt, data: p, mac: this.sign(p, savedAt) };
    return JSON.stringify(env);
  }
  /** Parses + verifies an envelope. `signed` tells whether the MAC matched. */
  private decode(raw: string | null): { profile: Profile; savedAt: number; signed: boolean } | null {
    if (!raw) return null;
    let env: Envelope;
    try { env = JSON.parse(raw); } catch { return null; }
    if (!env || typeof env !== 'object' || !env.data || typeof env.mac !== 'string' || typeof env.savedAt !== 'number') return null;
    const signed = safeEqual(this.sign(env.data, env.savedAt), env.mac);
    const profile = sanitizeProfile(env.data, this.now());
    if (!profile) return null;
    return { profile, savedAt: env.savedAt, signed };
  }

  load(): LoadResult {
    const incidents: string[] = [];
    const raw = this.kv.get('save');
    if (raw === null && !ROLLING.some((k) => this.kv.get(k) !== null)) {
      return { profile: newProfile(randomId(12), this.now()), status: 'new', incidents };
    }
    const main = this.decode(raw);
    if (main?.signed) return { profile: main.profile, status: 'ok', incidents };
    if (raw !== null) {
      incidents.push(main ? 'save_signature_mismatch' : 'save_unreadable');
      this.kv.set('corrupt', raw.slice(0, 200000));
    } else incidents.push('save_missing');
    // Fall back to the newest backup that still verifies.
    for (const slot of [...ROLLING, 'bak.pre']) {
      const b = this.decode(this.kv.get(slot));
      if (b?.signed) {
        b.profile.flags.restored++;
        incidents.push(`restored_from_${slot}`);
        return { profile: b.profile, status: 'restored_backup', incidents };
      }
    }
    if (main) {
      // Readable but unsigned and no valid backup: keep the (clamped) progress rather than
      // wiping an honest player, but remember the incident.
      main.profile.flags.tamper++;
      return { profile: main.profile, status: 'unsigned_sanitized', incidents };
    }
    incidents.push('no_valid_save');
    return { profile: newProfile(randomId(12), this.now()), status: 'new', incidents };
  }

  /** Synchronous save. `forceBackup` rotates the rolling backups regardless of the interval. */
  save(p: Profile, forceBackup = false): boolean {
    const now = this.now();
    if (forceBackup || now - this.lastBackupAt >= BACKUP_INTERVAL) this.rotate();
    let ok = this.kv.set('save', this.encode(p));
    if (!ok) {
      // Most likely a quota problem: free the oldest backup and retry once.
      this.kv.remove(ROLLING[ROLLING.length - 1]);
      this.kv.remove('corrupt');
      ok = this.kv.set('save', this.encode(p));
    }
    this.writeFailed = !ok;
    return ok;
  }

  private rotate(): void {
    const cur = this.kv.get('save');
    if (!cur) return;
    const d = this.decode(cur);
    if (!d?.signed) return; // never push a bad version into the backup chain
    for (let i = ROLLING.length - 1; i > 0; i--) {
      const prev = this.kv.get(ROLLING[i - 1]);
      if (prev) this.kv.set(ROLLING[i], prev);
    }
    this.kv.set(ROLLING[0], cur);
    this.lastBackupAt = this.now();
  }

  /** Snapshot before a critical operation; `slot` is 'bak.pre' or 'bak.alt'. */
  snapshot(p: Profile, slot: 'bak.pre' | 'bak.alt' = 'bak.pre'): void {
    this.kv.set(slot, this.encode(p));
  }

  backups(): BackupInfo[] {
    const out: BackupInfo[] = [];
    for (const slot of [...ROLLING, 'bak.pre', 'bak.alt']) {
      const b = this.decode(this.kv.get(slot));
      if (!b?.signed) continue;
      out.push({ slot, savedAt: b.savedAt, score: progressScore(b.profile), cleared: Object.keys(b.profile.campaign).length, gold: b.profile.gold, gems: b.profile.gems });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }
  readBackup(slot: string): Profile | null {
    if (![...ROLLING, 'bak.pre', 'bak.alt'].includes(slot)) return null;
    const b = this.decode(this.kv.get(slot));
    return b?.signed ? b.profile : null;
  }

  /** Removes the local profile and every backup (the install secret is regenerated too). */
  wipe(): void {
    for (const k of ['save', ...ROLLING, 'bak.pre', 'bak.alt', 'corrupt', 'run', 'pending', 'auth', 'device', 'log']) this.kv.remove(k);
  }
}
