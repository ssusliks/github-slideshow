import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { BOOSTS } from '../src/data/boosts';
import { ENEMIES } from '../src/data/enemies';
import { ACHIEVEMENTS, COSMETICS, DAILY_QUESTS, GEM_SHOP, IAP_PRODUCTS, RESEARCH, WEEKLY_QUESTS } from '../src/data/meta';
import { FORBIDDEN, REACTIONS, TOWERS } from '../src/data/towers';
import { ABILITIES, WORLDS } from '../src/data/worlds';
import { Game } from '../src/meta/game';
import { Profile, newProfile } from '../src/meta/profile';
import { AdProvider, AdService } from '../src/services/ads';
import { CloudService, resolveConflict } from '../src/services/cloud';
import { hex, hmacHex, safeEqual, sha256, sha256Hex, utf8 } from '../src/services/hash';
import { DICTS, setLang, t } from '../src/services/i18n';
import { BillingProvider, PurchaseService, SandboxBilling, StoreTx } from '../src/services/iap';
import { Breaker, Log, TimeoutError, withTimeout } from '../src/services/log';
import { AdaptiveQuality, FrameLimiter } from '../src/services/perf';
import { BACKUP_INTERVAL, SaveService } from '../src/services/save';
import { loadSettings, saveSettings } from '../src/services/settings';
import { MemoryKV } from '../src/services/storage';
// The real backend, started in-process for sync / purchase tests.
// @ts-ignore – plain ESM module without types
import { createApp } from '../../server/src/app.mjs';
// @ts-ignore
import { createStore } from '../../server/src/store.mjs';

let clock = 1_800_000_000_000;
const now = () => clock;
const mkGame = (p: Profile, onChange: () => void = () => undefined) => new Game(p, { now, onChange, log: () => undefined });

describe('hashing', () => {
  it('matches SHA-256 and HMAC-SHA256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(hex(sha256(utf8('a'.repeat(1000))))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(hmacHex('key', 'The quick brown fox jumps over the lazy dog')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(hmacHex('k'.repeat(100), 'x')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});

describe('local saves', () => {
  let kv: MemoryKV, svc: SaveService, p: Profile;
  beforeEach(() => { clock = 1_800_000_000_000; kv = new MemoryKV(); svc = new SaveService(kv, now); p = newProfile('local-1', clock); });

  it('a fresh install yields a new profile; saving and loading round-trips', () => {
    expect(svc.load().status).toBe('new');
    p.gold = 4321; p.campaign['1-1'] = { stars: 3, clears: 2 };
    expect(svc.save(p)).toBe(true);
    const l = new SaveService(kv, now).load();
    expect(l.status).toBe('ok');
    expect(l.profile).toEqual(p);
    expect(l.incidents).toEqual([]);
  });
  it('an edited save is detected and the last good backup is restored', () => {
    p.gold = 100; svc.save(p, true);
    clock += 1000; p.gold = 200; svc.save(p, true); // bak.0 now holds the 100-gold version
    const env = JSON.parse(kv.get('save')!);
    env.data.gold = 999999999; env.data.gems = 5000000;
    kv.set('save', JSON.stringify(env));
    const l = new SaveService(kv, now).load();
    expect(l.status).toBe('restored_backup');
    expect(l.profile.gold).toBe(100);
    expect(l.profile.flags.restored).toBe(1);
    expect(l.incidents).toContain('save_signature_mismatch');
    expect(kv.get('corrupt')).toBeTruthy();
  });
  it('a truncated / garbage save falls back to a backup; with no backup a new profile starts', () => {
    p.gold = 777; svc.save(p, true); clock += 1000; svc.save(p, true);
    kv.set('save', '{"v":1,"savedAt":17,"data":{"id":"local-1","go');
    expect(new SaveService(kv, now).load()).toMatchObject({ status: 'restored_backup', profile: { gold: 777 } });
    const kv2 = new MemoryKV();
    const s2 = new SaveService(kv2, now);
    kv2.set('save', 'garbage');
    const l = s2.load();
    expect(l.status).toBe('new');
    expect(l.incidents).toContain('no_valid_save');
  });
  it('an unsigned but readable save without backups is kept, clamped and flagged (no wipe for honest players)', () => {
    svc.save(p);
    const env = JSON.parse(kv.get('save')!);
    env.data.gold = 1e99; env.data.campaign['1-1'] = { stars: 3, clears: 1 };
    kv.set('save', JSON.stringify(env));
    const l = new SaveService(kv, now).load();
    expect(l.status).toBe('unsigned_sanitized');
    expect(l.profile.gold).toBe(1e10);
    expect(l.profile.campaign['1-1'].stars).toBe(3);
    expect(l.profile.flags.tamper).toBe(1);
  });
  it('a save copied from another install (different device key) is not trusted as signed', () => {
    p.gold = 5; svc.save(p);
    const other = new MemoryKV();
    const otherSvc = new SaveService(other, now);
    other.set('save', kv.get('save')!);
    expect(otherSvc.load().status).toBe('unsigned_sanitized');
  });
  it('keeps several previous versions and rotates them on an interval', () => {
    for (let i = 1; i <= 6; i++) { p.gold = i * 10; svc.save(p); clock += BACKUP_INTERVAL + 1; }
    const b = svc.backups().filter((x) => x.slot.startsWith('bak.') && !['bak.pre', 'bak.alt'].includes(x.slot));
    expect(b.map((x) => x.gold)).toEqual([50, 40, 30]);
    expect(svc.readBackup('bak.1')!.gold).toBe(40);
    expect(svc.readBackup('save')).toBeNull();
    // frequent saves inside the interval do not churn the backups
    svc.save(p);
    const before = kv.get('bak.0');
    for (let i = 0; i < 5; i++) { p.gold++; svc.save(p); clock += 1000; }
    expect(kv.get('bak.0')).toBe(before);
  });
  it('snapshots before critical operations are restorable', () => {
    p.gold = 42; svc.snapshot(p, 'bak.pre');
    const alt = newProfile('alt', clock); alt.gold = 7; svc.snapshot(alt, 'bak.alt');
    expect(svc.readBackup('bak.pre')!.gold).toBe(42);
    expect(svc.readBackup('bak.alt')!.id).toBe('alt');
    expect(svc.backups().map((b) => b.slot).sort()).toEqual(['bak.alt', 'bak.pre']);
  });
  it('a failing storage is reported instead of silently losing data', () => {
    svc.save(p);
    kv.failWrites = true;
    p.gold = 1;
    expect(svc.save(p)).toBe(false);
    expect(svc.writeFailed).toBe(true);
    kv.failWrites = false;
    expect(svc.save(p)).toBe(true);
    expect(svc.writeFailed).toBe(false);
  });
  it('wipe removes the profile, backups and the install secret', () => {
    svc.save(p, true); svc.snapshot(p);
    svc.wipe();
    expect(kv.keys().filter((k) => k !== 'settings')).toEqual([]);
    expect(new SaveService(kv, now).load().status).toBe('new');
  });
  it('settings load with defaults and reject garbage', () => {
    expect(loadSettings(kv)).toMatchObject({ fps: 30, quality: 'auto', vibration: true });
    kv.set('settings', JSON.stringify({ fps: 144, quality: 'ultra', music: 7, lang: 'xx', shake: false }));
    expect(loadSettings(kv)).toMatchObject({ fps: 30, quality: 'auto', music: 0.5, shake: false });
    const s = loadSettings(kv); s.fps = 60; s.lang = 'kk'; saveSettings(kv, s);
    expect(loadSettings(kv)).toMatchObject({ fps: 60, lang: 'kk' });
  });
});

describe('fault isolation', () => {
  it('circuit breaker opens after repeated failures and closes after the cool-down', () => {
    let t0 = 0;
    const b = new Breaker('x', 3, 1000, () => t0);
    b.fail(); b.fail();
    expect(b.open).toBe(false);
    b.ok(); b.fail(); b.fail();
    expect(b.open).toBe(false);
    b.fail();
    expect(b.open).toBe(true);
    t0 = 1001;
    expect(b.open).toBe(false);
  });
  it('withTimeout rejects hung operations', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, 'hang')).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(5), 20, 'ok')).resolves.toBe(5);
    await expect(withTimeout(Promise.reject(new Error('boom')), 20, 'err')).rejects.toThrow('boom');
  });
  it('the log is bounded, persistent and never throws', () => {
    const kv = new MemoryKV();
    const log = new Log(kv, 10);
    for (let i = 0; i < 25; i++) log.add('k', new Error(`e${i}`));
    expect(log.entries.length).toBe(10);
    expect(new Log(kv, 10).entries.length).toBe(10);
    expect(log.guard('g', () => { throw new Error('x'); }, 'fallback')).toBe('fallback');
    kv.failWrites = true;
    expect(() => log.add('k', 'still fine')).not.toThrow();
    expect(JSON.parse(log.report({ v: 1 })).v).toBe(1);
  });
  it('ad service survives a crashing / hanging / failing SDK', async () => {
    const mk = (p: Partial<AdProvider>) => new AdService({ name: 'fake', init: async () => undefined, showRewarded: async () => ({ completed: true }), ...p }, new Breaker('ads', 2, 60000), () => undefined);
    const good = mk({}); await good.init();
    expect(await good.showRewarded('x')).toEqual({ completed: true });
    const throws = mk({ showRewarded: async () => { throw new Error('sdk exploded'); } }); await throws.init();
    expect((await throws.showRewarded('x')).completed).toBe(false);
    expect((await throws.showRewarded('x')).completed).toBe(false);
    expect(throws.available).toBe(false); // breaker opened: the feature is switched off, the game goes on
    const badInit = mk({ init: async () => { throw new Error('no sdk'); } }); await badInit.init();
    expect(badInit.available).toBe(false);
    expect(await badInit.showRewarded('x')).toEqual({ completed: false, reason: 'unavailable' });
    const none = new AdService(null, new Breaker('a'), () => undefined);
    expect((await none.showRewarded('x')).completed).toBe(false);
    // two overlapping requests: only one ad is shown
    let shown = 0;
    const slow = mk({ showRewarded: () => new Promise((r) => { shown++; setTimeout(() => r({ completed: true }), 30); }) }); await slow.init();
    const [a, b] = await Promise.all([slow.showRewarded('x'), slow.showRewarded('x')]);
    expect(shown).toBe(1);
    expect([a.completed, b.completed].sort()).toEqual([false, true]);
  });
});

describe('frame pacing and adaptive quality', () => {
  it('caps at 30 fps on a 60 Hz display and never exceeds 60', () => {
    const count = (fps: 30 | 60, hz: number) => { const l = new FrameLimiter(fps); let n = 0; for (let i = 0; i <= hz; i++) if (l.tick(1000 + (i * 1000) / hz) > 0) n++; return n; };
    expect(count(30, 60)).toBeGreaterThanOrEqual(29); expect(count(30, 60)).toBeLessThanOrEqual(31);
    expect(count(60, 60)).toBeGreaterThanOrEqual(59); expect(count(60, 60)).toBeLessThanOrEqual(60);
    expect(count(60, 120)).toBeLessThanOrEqual(61);
    expect(count(30, 120)).toBeLessThanOrEqual(31);
  });
  it('lowers effects / resolution when the device is slow and restores them later', () => {
    const states: number[] = [];
    const q = new AdaptiveQuality((s) => states.push(s.scale * s.fx));
    for (let i = 0; i < 60 * 30; i++) q.frame(1 / 14, 30); // struggling at 14 fps
    expect(q.state.fx).toBeLessThan(1);
    expect(q.state.scale).toBeLessThan(1);
    expect(q.state.scale).toBeGreaterThanOrEqual(0.6);
    const low = q.state.scale * q.state.fx;
    for (let i = 0; i < 60 * 240; i++) q.frame(1 / 30, 30);
    expect(q.state.scale * q.state.fx).toBeGreaterThan(low);
  });
  it('manual presets are respected, thermal protection always applies', () => {
    const q = new AdaptiveQuality(() => undefined);
    q.auto = false;
    for (let i = 0; i < 60 * 30; i++) q.frame(1 / 14, 30);
    expect(q.state.scale).toBe(1);
    q.setNativeThermal(3);
    for (let i = 0; i < 100; i++) q.frame(1 / 30, 30);
    expect(q.state).toMatchObject({ thermal: 3, fpsCap: 30 });
    expect(q.state.fx).toBeLessThanOrEqual(0.4);
    q.setNativeThermal(0);
    for (let i = 0; i < 100; i++) q.frame(1 / 30, 30);
    expect(q.state.fpsCap).toBe(0);
  });
  it('sustained degradation after a good start is treated as overheating', () => {
    const q = new AdaptiveQuality(() => undefined);
    q.auto = false;
    for (let i = 0; i < 300; i++) q.frame(1 / 60, 60);
    for (let i = 0; i < 60 * 40; i++) q.frame(1 / 30, 60);
    expect(q.state.thermal).toBeGreaterThanOrEqual(1);
  });
});

describe('localisation', () => {
  const langs = Object.keys(DICTS);
  it('ships English, Russian and Kazakh with identical key sets and placeholders', () => {
    expect(langs.sort()).toEqual(['en', 'kk', 'ru']);
    const keys = Object.keys(DICTS.en).sort();
    expect(keys.length).toBeGreaterThan(500);
    for (const l of langs) {
      expect(Object.keys(DICTS[l]).sort()).toEqual(keys);
      for (const k of keys) {
        expect(DICTS[l][k].trim().length, `${l}:${k}`).toBeGreaterThan(0);
        const ph = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join();
        expect(ph(DICTS[l][k]), `${l}:${k}`).toBe(ph(DICTS.en[k]));
      }
    }
  });
  it('Russian and Kazakh are real translations, not copies of English', () => {
    const cyr = /[А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/;
    for (const l of ['ru', 'kk']) {
      const translated = Object.keys(DICTS[l]).filter((k) => cyr.test(DICTS[l][k])).length;
      expect(translated / Object.keys(DICTS[l]).length).toBeGreaterThan(0.97);
    }
    expect(Object.keys(DICTS.kk).filter((k) => /[ӘәҒғҚқҢңӨөҰұҮүІі]/.test(DICTS.kk[k])).length).toBeGreaterThan(300);
  });
  it('every key referenced by code or data exists', () => {
    const need = new Set<string>();
    const walk = (dir: string) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f)) { const src = fs.readFileSync(p, 'utf8'); for (const m of src.matchAll(/\bt\('([a-z][a-zA-Z0-9_.]*\.[a-zA-Z0-9_.]+)'/g)) need.add(m[1]); for (const m of src.matchAll(/'((?:act\.err|merge\.err|merge\.forbid|err|cloud\.err|research\.need_[a-z]+|nav|hint|tut)\.[a-z_0-9.]+)'/g)) need.add(m[1]); } } };
    walk(path.join(__dirname, '..', 'src'));
    for (const d of Object.values(TOWERS)) { need.add(`tower.${d.id}.name`); need.add(`tower.${d.id}.desc`); need.add(`el.${d.element}`); need.add(`rarity.${d.rarity}`); need.add(`attack.${d.attack.kind}`); for (const b of d.branches ?? []) { need.add(`branch.${b.id}.name`); need.add(`branch.${b.id}.desc`); } }
    for (const e of Object.values(ENEMIES)) { need.add(`enemy.${e.id}.name`); need.add(`enemy.${e.id}.desc`); }
    for (const b of BOOSTS) { need.add(`boost.${b.id}.name`); need.add(`boost.${b.id}.desc`); need.add(`rarity.${b.rarity}`); }
    for (const a of Object.values(ABILITIES)) { need.add(`ability.${a.id}.name`); need.add(`ability.${a.id}.desc`); }
    for (const w of WORLDS) { need.add(`world.${w.key}.name`); need.add(`world.${w.key}.story`); }
    for (const r of RESEARCH) { need.add(`research.${r.id}.name`); need.add(`research.${r.id}.desc`); }
    for (const q of [...DAILY_QUESTS, ...WEEKLY_QUESTS]) need.add(`quest.${q.stat}`);
    for (const a of ACHIEVEMENTS) need.add(`ach.${a.stat}`);
    for (const r of REACTIONS) need.add(`reaction.${r.id}`);
    for (const f of FORBIDDEN) need.add(f.reason);
    for (const p of IAP_PRODUCTS) need.add(`iap.${p.id}.name`);
    for (const i of GEM_SHOP) if (!i.cosmetic) need.add(`gem.${i.id}`);
    for (const c of COSMETICS) { need.add(`cos.${c}`); need.add(`cos.${c}.how`); }
    for (const s of ['disabled', 'offline', 'restricted', 'in_sync', 'uploaded', 'downloaded', 'conflict_kept_local', 'conflict_took_remote', 'error']) need.add(`cloud.status.${s}`);
    for (const s of ['bak.0', 'bak.1', 'bak.2', 'bak.pre', 'bak.alt']) need.add(`backup.${s}`);
    for (const s of ['unavailable', 'verify_failed', 'pending', 'error']) need.add(`shop.err.${s}`);
    for (const s of ['free_gold', 'free_shards']) need.add(`shop.${s}`);
    for (const s of ['daily', 'weekly', 'ach', 'login']) need.add(`quests.${s}`);
    for (const s of ['bug', 'purchase', 'progress', 'other']) need.add(`support.cat.${s}`);
    for (const s of ['goldrush', 'week']) { need.add(`event.${s}.name`); need.add(`event.${s}.desc`); }
    const missing = [...need].filter((k) => DICTS.en[k] === undefined);
    expect(missing).toEqual([]);
  });
  it('t() substitutes parameters and falls back safely', () => {
    setLang('ru');
    expect(t('ui.wave_of', { n: 2, total: 5 })).toBe('Волна 2/5');
    setLang('kk');
    expect(t('ui.wave_n', { n: 3 })).toBe('3-толқын');
    setLang('xx' as any);
    expect(t('ui.cancel')).toBe('Cancel');
    expect(t('no.such.key')).toBe('no.such.key');
    setLang('en');
  });
});

// ------------------------------------------------------------------ backend-backed tests
describe('cloud sync and purchases against the real backend', () => {
  let server: any, base = '';
  const devices: { kv: MemoryKV; save: SaveService; cloud: CloudService }[] = [];
  const mkDevice = () => {
    const kv = new MemoryKV();
    const save = new SaveService(kv, now);
    const cloud = new CloudService(kv, save, new Breaker('cloud', 50), now, () => undefined);
    const d = { kv, save, cloud };
    devices.push(d);
    return d;
  };
  beforeAll(async () => {
    const app = createApp({ store: createStore(null), iapVerifiers: { sandbox: async ({ purchaseToken, productId }: any) => ({ valid: purchaseToken === `sandbox:${productId}` }) }, rate: { window: 60000, max: 100000, authMax: 100000 } });
    server = app.server();
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
    CONFIG.apiUrl = base;
    CONFIG.dev = true;
  });
  afterAll(async () => { CONFIG.apiUrl = ''; await new Promise((r) => server.close(r)); });

  const progress = (id: string, levels: number, playtime = levels * 300): Profile => {
    const p = newProfile(id, clock);
    for (let i = 0; i < levels; i++) p.campaign[`1-${i + 1}`] = { stars: 3, clears: 1 };
    p.playtime = playtime; p.rev = levels + 1; p.gold = 100 + levels * 50;
    return p;
  };

  it('conflict resolution is deterministic and never mixes two profiles', () => {
    expect(resolveConflict(progress('a', 5), progress('b', 3))).toBe('local');
    expect(resolveConflict(progress('a', 2), progress('b', 3))).toBe('remote');
    expect(resolveConflict(progress('a', 3, 100), progress('b', 3, 100.5))).toBe('remote');
    const older = progress('a', 3, 100); const newer = progress('b', 3, 100); newer.updatedAt += 5;
    expect(resolveConflict(older, newer)).toBe('remote');
    expect(resolveConflict(newer, older)).toBe('local');
  });

  it('a guest uploads, edits and stays in sync', async () => {
    const d = mkDevice();
    const p = progress('guest-1', 2);
    expect((await d.cloud.sync(p)).status).toBe('uploaded');
    expect(d.cloud.auth?.kind).toBe('guest');
    expect((await d.cloud.sync(p)).status).toBe('in_sync');
    p.gold += 10; p.rev++;
    expect((await d.cloud.sync(p)).status).toBe('uploaded');
    expect((await d.cloud.history()).length).toBe(1);
  });

  it('Android → account → iOS: progress moves between devices and conflicts keep a backup', async () => {
    const android = mkDevice(), ios = mkDevice();
    let pa = progress('android', 4);
    await android.cloud.sync(pa);
    expect((await android.cloud.register('cross@example.com', 'password123')).ok).toBe(true);
    expect(android.cloud.auth).toMatchObject({ kind: 'account', email: 'cross@example.com' });
    expect((await android.cloud.register('cross@example.com', 'password123')).ok).toBe(true); // idempotent for the owner

    // iOS starts as a fresh install and signs in
    const fresh = progress('ios-fresh', 0);
    expect((await ios.cloud.login({ email: 'cross@example.com', password: 'wrong-password' })).reason).toBe('cloud.err.credentials');
    const login = await ios.cloud.login({ email: 'cross@example.com', password: 'password123' });
    expect(login.ok).toBe(true);
    expect(login.remote).toMatchObject({ cleared: 4 });
    const down = await ios.cloud.sync(fresh, 'remote');
    expect(down.status).toBe('conflict_took_remote');
    expect(down.profile!.id).toBe('android');
    expect(Object.keys(down.profile!.campaign).length).toBe(4);
    expect(ios.save.readBackup('bak.alt')!.id).toBe('ios-fresh'); // the replaced device progress is restorable
    let pi = down.profile!;

    // iOS plays further and uploads; Android (unchanged) simply downloads
    pi.campaign['1-5'] = { stars: 2, clears: 1 }; pi.rev++; pi.gold = 999;
    expect((await ios.cloud.sync(pi)).status).toBe('uploaded');
    const a2 = await android.cloud.sync(pa);
    expect(a2.status).toBe('downloaded');
    expect(a2.profile!.gold).toBe(999);
    pa = a2.profile!;

    // both devices play offline, then sync: the further one wins as a whole, no currency merging
    pa.campaign['1-6'] = { stars: 3, clears: 1 }; pa.campaign['2-1'] = { stars: 3, clears: 1 }; pa.rev += 2; pa.gold = 5000;
    pi.rev++; pi.gold = 7777; pi.gems = 4444;
    expect((await android.cloud.sync(pa)).status).toBe('uploaded');
    const conflict = await ios.cloud.sync(pi);
    expect(conflict.status).toBe('conflict_took_remote');
    expect(conflict.profile!.gold).toBe(5000);
    expect(conflict.profile!.gems).toBe(pa.gems);
    expect(ios.save.readBackup('bak.alt')!.gold).toBe(7777);

    // the opposite case: the local device is further ahead and overwrites the cloud
    const pi2 = conflict.profile!;
    pi2.campaign['2-2'] = { stars: 3, clears: 1 }; pi2.campaign['2-3'] = { stars: 3, clears: 1 }; pi2.rev += 2;
    pa.rev++; pa.gold = 1;
    expect((await android.cloud.sync(pa)).status).toBe('uploaded');
    expect((await ios.cloud.sync(pi2)).status).toBe('conflict_kept_local');
    const hist = await ios.cloud.history();
    expect(hist.length).toBeGreaterThanOrEqual(3);
    const old = await ios.cloud.fetchRevision(hist[0].rev);
    expect(old!.gold).toBe(1); // the replaced cloud version is still restorable from history
  });

  it('a modified build may download but not upload', async () => {
    const d = mkDevice();
    d.cloud.restricted = true;
    expect((await d.cloud.sync(progress('modded', 9))).status).toBe('restricted');
    expect((await d.cloud.history()).length).toBe(0);
  });

  it('works offline: unreachable server never throws and reports a status', async () => {
    const d = mkDevice();
    CONFIG.apiUrl = 'http://127.0.0.1:9';
    expect(['error', 'offline']).toContain((await d.cloud.sync(progress('off', 1))).status);
    expect(await d.cloud.timeOffset()).toBeNull();
    CONFIG.apiUrl = '';
    expect((await d.cloud.sync(progress('off', 1))).status).toBe('disabled');
    CONFIG.apiUrl = base;
    expect(Math.abs((await d.cloud.timeOffset())! - (Date.now() - clock))).toBeLessThan(5000);
  });

  it('deleting the cloud account removes it from the server', async () => {
    const d = mkDevice();
    await d.cloud.sync(progress('to-delete', 1));
    await d.cloud.register('delete-me@example.com', 'password123');
    expect((await d.cloud.deleteAccount()).ok).toBe(true);
    expect(d.cloud.auth).toBeNull();
    expect((await mkDevice().cloud.login({ email: 'delete-me@example.com', password: 'password123' })).ok).toBe(false);
  });

  it('support tickets reach the server', async () => {
    const d = mkDevice();
    expect(await d.cloud.sendTicket({ category: 'bug', message: 'tower disappeared', tech: '{}' })).toBe(true);
    expect(await d.cloud.sendTicket({ category: 'bug', message: '  ' })).toBe(false);
  });

  // ---------------- purchases ----------------
  const mkShop = (provider: BillingProvider, game: Game, kv = new MemoryKV(), token?: string) => {
    let flushed = 0;
    const svc = new PurchaseService(provider, () => game, kv, new Breaker('iap', 50), () => token, () => undefined, () => { flushed++; });
    return { svc, kv, flushed: () => flushed };
  };
  let idc = 0;
  const sandbox = (confirm = true) => new SandboxBilling(async () => confirm, () => `t${++idc}`);

  it('sandbox purchase: verified by the server, delivered once, save flushed before finishing', async () => {
    const d = mkDevice();
    await d.cloud.ensureGuest();
    const game = mkGame(newProfile('buyer', clock));
    const provider = sandbox();
    const { svc, flushed } = mkShop(provider, game, d.kv, d.cloud.auth!.token);
    await svc.init();
    expect(svc.available).toBe(true);
    expect(svc.priceOf('gems_small')).toBe('$0.99');
    const gems = game.p.gems;
    expect(await svc.buy('gems_small')).toEqual({ ok: true, granted: true });
    expect(game.p.gems).toBe(gems + 80);
    expect(flushed()).toBe(1);
    expect(await provider.outstanding()).toEqual([]);
    expect(JSON.parse(d.kv.get('pending')!)).toEqual([]);
    expect((await svc.buy('nope')).ok).toBe(false);
  });

  it('a cancelled purchase changes nothing', async () => {
    const game = mkGame(newProfile('c', clock));
    const { svc, kv } = mkShop(sandbox(false), game);
    await svc.init();
    const before = JSON.stringify(game.p);
    expect(await svc.buy('gems_medium')).toEqual({ ok: false, reason: 'cancelled' });
    expect(JSON.stringify(game.p)).toBe(before);
    expect(JSON.parse(kv.get('pending') ?? '[]')).toEqual([]);
  });

  it('crash between payment and delivery: the purchase is recovered on the next start, exactly once', async () => {
    const d = mkDevice();
    await d.cloud.ensureGuest();
    const game = mkGame(newProfile('crashy', clock));
    const gems = game.p.gems;
    // The store took the money, the journal was written, then the app died before delivery.
    const tx: StoreTx = { transactionId: 'sbx-crash-1', productId: 'gems_medium', platform: 'sandbox', purchaseToken: 'sandbox:gems_medium' };
    d.kv.set('pending', JSON.stringify([tx]));
    const { svc } = mkShop(sandbox(), game, d.kv, d.cloud.auth!.token);
    await svc.init(); // init() runs recover()
    expect(game.p.gems).toBe(gems + 500);
    expect(JSON.parse(d.kv.get('pending')!)).toEqual([]);
    // a duplicated store callback / second recovery delivers nothing more
    d.kv.set('pending', JSON.stringify([tx]));
    expect(await svc.recover()).toBe(0);
    expect(game.p.gems).toBe(gems + 500);
  });

  it('forged and replayed receipts are refused', async () => {
    const a = mkDevice(), b = mkDevice();
    await a.cloud.ensureGuest(); await b.cloud.ensureGuest();
    const gameA = mkGame(newProfile('A', clock)), gameB = mkGame(newProfile('B', clock));
    const forged: StoreTx = { transactionId: 'sbx-forged', productId: 'gems_large', platform: 'sandbox', purchaseToken: 'i-did-not-pay' };
    a.kv.set('pending', JSON.stringify([forged]));
    const shopA = mkShop(sandbox(), gameA, a.kv, a.cloud.auth!.token);
    await shopA.svc.init();
    expect(gameA.p.gems).toBe(20);
    expect(JSON.parse(a.kv.get('pending')!)).toEqual([]);
    // a genuine receipt of player A replayed on player B's account
    const real: StoreTx = { transactionId: 'sbx-real-9', productId: 'gems_small', platform: 'sandbox', purchaseToken: 'sandbox:gems_small' };
    a.kv.set('pending', JSON.stringify([real]));
    await shopA.svc.recover();
    expect(gameA.p.gems).toBe(100);
    b.kv.set('pending', JSON.stringify([real]));
    const shopB = mkShop(sandbox(), gameB, b.kv, b.cloud.auth!.token);
    await shopB.svc.init();
    expect(gameB.p.gems).toBe(20);
  });

  it('when the verifier is unreachable the purchase stays pending and is delivered later', async () => {
    const d = mkDevice();
    await d.cloud.ensureGuest();
    const game = mkGame(newProfile('late', clock));
    const provider = sandbox();
    const { svc } = mkShop(provider, game, d.kv, d.cloud.auth!.token);
    await svc.init();
    // real-store transaction while no store verifier is configured on the server (answers 503)
    const tx: StoreTx = { transactionId: 'GPA.1234', productId: 'gems_small', platform: 'android', purchaseToken: 'tok' };
    d.kv.set('pending', JSON.stringify([tx]));
    expect(await svc.recover()).toBe(0);
    expect(game.p.gems).toBe(20);
    expect(JSON.parse(d.kv.get('pending')!).length).toBe(1); // not lost, not granted
    CONFIG.apiUrl = 'http://127.0.0.1:9';
    expect(await svc.recover()).toBe(0);
    expect(JSON.parse(d.kv.get('pending')!).length).toBe(1);
    CONFIG.apiUrl = base;
  });

  it('non-consumables restore on a new device without double rewards', async () => {
    const game = mkGame(newProfile('restore', clock));
    const owned: StoreTx = { transactionId: 'sbx-prem', productId: 'premium', platform: 'sandbox', purchaseToken: 'sandbox:premium' };
    const provider: BillingProvider = { name: 'fake', init: async () => true, prices: async () => ({}), purchase: async () => null, outstanding: async () => [owned], finish: async () => undefined };
    const d = mkDevice();
    await d.cloud.ensureGuest();
    const { svc } = mkShop(provider, game, d.kv, d.cloud.auth!.token);
    await svc.init();
    expect(game.isPremium()).toBe(true);
    const gems = game.p.gems;
    await svc.recover(); await svc.recover();
    expect(game.p.gems).toBe(gems);
  });

  it('a store SDK that throws is contained', async () => {
    const game = mkGame(newProfile('boom', clock));
    const bad: BillingProvider = { name: 'bad', init: async () => { throw new Error('billing unavailable'); }, prices: async () => ({}), purchase: async () => null, outstanding: async () => [], finish: async () => undefined };
    const { svc } = mkShop(bad, game);
    await svc.init();
    expect(svc.available).toBe(false);
    expect(await svc.buy('gems_small')).toEqual({ ok: false, reason: 'unavailable' });
    const throwing: BillingProvider = { name: 'bad2', init: async () => true, prices: async () => ({}), purchase: async () => { throw new Error('crash in SDK'); }, outstanding: async () => [], finish: async () => undefined };
    const s2 = mkShop(throwing, game);
    await s2.svc.init();
    expect(await s2.svc.buy('gems_small')).toEqual({ ok: false, reason: 'error' });
    expect(game.p.gems).toBe(20);
  });
});
