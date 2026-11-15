import { CONFIG } from '../config';
import { Profile, progressScore, sanitizeProfile } from '../meta/profile';
import { sha256Hex } from './hash';
import type { Breaker } from './log';
import { api, cloudConfigured, isOnline } from './net';
import { isNative } from './platform';
import type { SaveService } from './save';
import type { KV } from './storage';

/**
 * Accounts and cloud saves.
 *  - Every install starts as a guest; a guest account is registered lazily when the network is
 *    available. A guest can be upgraded in place (e-mail + password) or linked to Google / Apple,
 *    which makes the same progress reachable from Android and iOS.
 *  - The cloud stores whole-profile revisions. Sync never merges two profiles field by field
 *    (that would allow duplicating currencies) – on a conflict exactly one side wins and the
 *    other is kept as a restorable backup.
 */
export interface AuthState {
  userId: string;
  token: string;
  kind: 'guest' | 'account';
  email?: string;
  links: { google?: boolean; apple?: boolean };
  /** server revision the local profile is based on. */
  baseRev: number;
  /** local profile.rev at the moment of the last successful sync. */
  syncedLocalRev: number;
  lastSyncAt: number;
}
export type SyncStatus = 'disabled' | 'offline' | 'restricted' | 'in_sync' | 'uploaded' | 'downloaded' | 'conflict_kept_local' | 'conflict_took_remote' | 'error';
export interface SyncResult { status: SyncStatus; profile?: Profile }
export interface RemoteSummary { rev: number; updatedAt: number; cleared: number; score: number; playtime: number }

/** Decides which side of a conflict survives. Pure and deterministic – covered by unit tests. */
export function resolveConflict(local: Profile, remote: Profile): 'local' | 'remote' {
  const a = progressScore(local), b = progressScore(remote);
  if (a !== b) return a > b ? 'local' : 'remote';
  if (local.playtime !== remote.playtime) return local.playtime > remote.playtime ? 'local' : 'remote';
  return local.updatedAt >= remote.updatedAt ? 'local' : 'remote';
}

export const summarize = (p: Profile) => ({ cleared: Object.keys(p.campaign).length, score: progressScore(p), playtime: Math.floor(p.playtime) });

export class CloudService {
  auth: AuthState | null = null;
  /** set when the app integrity check failed: uploads are refused, downloads still work. */
  restricted = false;
  lastStatus: SyncStatus = 'disabled';
  private syncing = false;

  constructor(private kv: KV, private save: SaveService, private breaker: Breaker, private now: () => number, private log: (kind: string, msg: unknown) => void) {
    try {
      const a = JSON.parse(kv.get('auth') ?? 'null');
      if (a && typeof a.userId === 'string' && typeof a.token === 'string') this.auth = { links: {}, baseRev: 0, syncedLocalRev: -1, lastSyncAt: 0, kind: 'guest', ...a };
    } catch { this.auth = null; }
  }

  get enabled(): boolean {
    return cloudConfigured();
  }
  private persist(): void {
    if (this.auth) this.kv.set('auth', JSON.stringify(this.auth));
    else this.kv.remove('auth');
  }
  private deviceId(): string {
    return sha256Hex(`dev:${this.kv.get('device') ?? ''}`).slice(0, 32);
  }
  private setAuth(d: any): void {
    const prev = this.auth;
    const sameUser = prev?.userId === d.userId;
    this.auth = {
      userId: d.userId, token: d.token ?? prev?.token ?? '', kind: d.kind === 'account' ? 'account' : 'guest', email: d.email ?? undefined,
      links: { google: !!d.links?.google, apple: !!d.links?.apple },
      baseRev: sameUser ? prev!.baseRev : 0, syncedLocalRev: sameUser ? prev!.syncedLocalRev : -1, lastSyncAt: sameUser ? prev!.lastSyncAt : 0,
    };
    this.persist();
  }

  /** Registers the guest account for this install when possible. Never blocks the game. */
  async ensureGuest(): Promise<boolean> {
    if (this.auth) return true;
    if (!this.enabled || this.breaker.open) return false;
    const r = await api('POST', '/v1/auth/guest', { deviceId: this.deviceId() });
    if (!r.ok || !r.data?.token) { if (r.error !== 'offline') this.breaker.fail(); return false; }
    this.breaker.ok();
    this.setAuth(r.data);
    return true;
  }

  /** Upgrades the current guest to a full account (progress stays attached to the same user). */
  async register(email: string, password: string): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.ensureGuest())) return { ok: false, reason: 'cloud.err.offline' };
    const r = await api('POST', '/v1/auth/register', { email, password }, this.auth!.token);
    if (!r.ok) return { ok: false, reason: r.status === 409 ? 'cloud.err.email_taken' : r.status === 400 ? 'cloud.err.invalid' : 'cloud.err.network' };
    this.setAuth({ ...r.data, token: this.auth!.token });
    return { ok: true };
  }

  /**
   * Signs in to an existing account (e-mail or a Google/Apple identity). Returns the remote save
   * summary so the UI can let the player choose which progress to keep when both sides have one.
   */
  async login(cred: { email: string; password: string } | { provider: 'google' | 'apple'; idToken: string }): Promise<{ ok: boolean; reason?: string; remote?: RemoteSummary | null }> {
    if (!this.enabled) return { ok: false, reason: 'cloud.err.disabled' };
    const path = 'email' in cred ? '/v1/auth/login' : '/v1/auth/oidc';
    const r = await api('POST', path, { ...cred, deviceId: this.deviceId() });
    if (!r.ok) return { ok: false, reason: r.status === 401 || r.status === 404 ? 'cloud.err.credentials' : r.error === 'offline' ? 'cloud.err.offline' : 'cloud.err.network' };
    this.auth = null;
    this.setAuth(r.data);
    const s = await api('GET', '/v1/save', undefined, this.auth!.token);
    const remote = s.ok && s.data?.doc ? sanitizeProfile(s.data.doc, this.now()) : null;
    return { ok: true, remote: remote ? { rev: s.data.rev, updatedAt: s.data.updatedAt, ...summarize(remote) } : null };
  }

  /** Obtains an ID token from the platform's Google / Apple sign-in sheet (native builds only). */
  async providerToken(provider: 'google' | 'apple'): Promise<{ idToken?: string; reason?: string }> {
    if (!isNative()) return { reason: 'cloud.err.native_only' };
    if (provider === 'google' && !CONFIG.auth.googleWebClientId) return { reason: 'cloud.err.not_configured' };
    try {
      const { SocialLogin } = await import('@capgo/capacitor-social-login');
      await SocialLogin.initialize(provider === 'google'
        ? { google: { webClientId: CONFIG.auth.googleWebClientId, iOSClientId: CONFIG.auth.googleIosClientId || undefined } }
        : { apple: { clientId: CONFIG.auth.appleClientId } });
      const res: any = await SocialLogin.login(provider === 'google' ? { provider: 'google', options: { scopes: ['email'] } } : { provider: 'apple', options: { scopes: ['email'] } });
      const idToken = res?.result?.idToken;
      return idToken ? { idToken } : { reason: 'cloud.err.cancelled' };
    } catch (e) {
      this.log('social_login', e);
      return { reason: 'cloud.err.cancelled' };
    }
  }

  /** Links a Google / Apple identity to the current account. */
  async link(provider: 'google' | 'apple', idToken: string): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.ensureGuest())) return { ok: false, reason: 'cloud.err.offline' };
    const r = await api('POST', '/v1/auth/link', { provider, idToken }, this.auth!.token);
    if (!r.ok) return { ok: false, reason: r.status === 409 ? 'cloud.err.identity_taken' : r.status === 401 ? 'cloud.err.credentials' : 'cloud.err.network' };
    this.setAuth({ ...r.data, token: this.auth!.token });
    return { ok: true };
  }

  logoutLocal(): void {
    this.auth = null;
    this.persist();
  }

  /** Server time offset in ms (server - device), or null when unknown. Used to detect clock tampering. */
  async timeOffset(): Promise<number | null> {
    if (!this.enabled || !isOnline()) return null;
    const t0 = this.now();
    const r = await api<{ now: number }>('GET', '/v1/time', undefined, undefined, 6000);
    if (!r.ok || typeof r.data?.now !== 'number') return null;
    const rtt = this.now() - t0;
    return r.data.now + rtt / 2 - this.now();
  }

  /**
   * Two-way sync. `local` is the live profile; when the result carries a `profile` the caller
   * must adopt it (remote won). `prefer` forces one side (used right after login when the
   * player picked which progress to keep).
   */
  async sync(local: Profile, prefer?: 'local' | 'remote'): Promise<SyncResult> {
    const done = (status: SyncStatus, profile?: Profile): SyncResult => { this.lastStatus = status; return { status, profile }; };
    if (!this.enabled) return done('disabled');
    if (!isOnline()) return done('offline');
    if (this.syncing || this.breaker.open) return done('error');
    this.syncing = true;
    try {
      if (!(await this.ensureGuest())) return done(isOnline() ? 'error' : 'offline');
      const a = this.auth!;
      const g = await api('GET', '/v1/save', undefined, a.token);
      if (!g.ok && g.status !== 404) {
        if (g.status === 401) { this.logoutLocal(); return done('error'); }
        this.breaker.fail();
        return done(g.error === 'offline' ? 'offline' : 'error');
      }
      this.breaker.ok();
      const remoteRev: number = g.ok ? g.data?.rev ?? 0 : 0;
      const remote = g.ok && g.data?.doc ? sanitizeProfile(g.data.doc, this.now()) : null;
      const localDirty = local.rev !== a.syncedLocalRev;
      const remoteChanged = !!remote && remoteRev !== a.baseRev;

      const upload = async (status: SyncStatus): Promise<SyncResult> => {
        if (this.restricted) return done('restricted');
        const p = await api('PUT', '/v1/save', { baseRev: remoteRev, doc: local, summary: summarize(local) }, a.token);
        if (!p.ok) return done(p.status === 409 ? 'error' : p.error === 'offline' ? 'offline' : 'error');
        a.baseRev = p.data.rev; a.syncedLocalRev = local.rev; a.lastSyncAt = this.now();
        this.persist();
        return done(status);
      };
      const download = (status: SyncStatus): SyncResult => {
        // The replaced local version stays restorable from the backups screen.
        this.save.snapshot(local, status === 'conflict_took_remote' ? 'bak.alt' : 'bak.pre');
        a.baseRev = remoteRev; a.syncedLocalRev = remote!.rev; a.lastSyncAt = this.now();
        this.persist();
        return done(status, remote!);
      };

      if (!remote) return upload('uploaded');
      if (prefer === 'local') return upload('conflict_kept_local');
      if (prefer === 'remote') return download('conflict_took_remote');
      if (!remoteChanged) return localDirty ? upload('uploaded') : done('in_sync');
      if (!localDirty) return download('downloaded');
      // Both sides changed since the last sync: pick one whole profile, keep the other as a backup.
      const winner = resolveConflict(local, remote);
      this.log('sync_conflict', `local=${progressScore(local)} remote=${progressScore(remote)} -> ${winner}`);
      if (winner === 'local') return upload('conflict_kept_local'); // the server keeps the replaced revision in its history
      return download('conflict_took_remote');
    } catch (e) {
      this.log('sync', e);
      return done('error');
    } finally {
      this.syncing = false;
    }
  }

  async history(): Promise<{ rev: number; updatedAt: number; summary: { cleared: number; score: number; playtime: number } }[]> {
    if (!this.auth) return [];
    const r = await api('GET', '/v1/save/history', undefined, this.auth.token);
    return r.ok && Array.isArray(r.data?.items) ? r.data.items : [];
  }
  /** Fetches an older cloud revision so it can be restored locally (the caller snapshots first). */
  async fetchRevision(rev: number): Promise<Profile | null> {
    if (!this.auth) return null;
    const r = await api('GET', `/v1/save/history/${rev}`, undefined, this.auth.token);
    return r.ok && r.data?.doc ? sanitizeProfile(r.data.doc, this.now()) : null;
  }

  /** Deletes the cloud account with all its saves and identities (store / privacy requirement). */
  async deleteAccount(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.auth) return { ok: true };
    const r = await api('DELETE', '/v1/account', undefined, this.auth.token);
    if (!r.ok && r.status !== 401 && r.status !== 404) return { ok: false, reason: r.error === 'offline' ? 'cloud.err.offline' : 'cloud.err.network' };
    this.logoutLocal();
    return { ok: true };
  }

  async sendTicket(ticket: { category: string; message: string; contact?: string; tech?: string; logs?: string }): Promise<boolean> {
    const r = await api('POST', '/v1/support/ticket', ticket, this.auth?.token);
    return r.ok;
  }
}
