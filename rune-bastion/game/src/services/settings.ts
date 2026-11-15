import type { KV } from './storage';

export type Lang = 'en' | 'ru' | 'kk';
export interface Settings {
  lang: Lang;
  music: number;
  sfx: number;
  vibration: boolean;
  shake: boolean;
  /** effects intensity 0..1. */
  fx: number;
  fps: 30 | 60;
  quality: 'auto' | 'low' | 'medium' | 'high';
  /** consent to attach technical logs to support requests. */
  logsConsent: boolean;
  speed: 1 | 2;
}

export function detectLang(): Lang {
  const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
  if (l.startsWith('ru')) return 'ru';
  if (l.startsWith('kk')) return 'kk';
  return 'en';
}

export const DEFAULT_SETTINGS = (): Settings => ({ lang: detectLang(), music: 0.5, sfx: 0.8, vibration: true, shake: true, fx: 1, fps: 30, quality: 'auto', logsConsent: false, speed: 1 });

export function loadSettings(kv: KV): Settings {
  const d = DEFAULT_SETTINGS();
  try {
    const r = JSON.parse(kv.get('settings') ?? '{}');
    const n01 = (v: unknown, def: number) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : def);
    return {
      lang: ['en', 'ru', 'kk'].includes(r.lang) ? r.lang : d.lang,
      music: n01(r.music, d.music), sfx: n01(r.sfx, d.sfx),
      vibration: typeof r.vibration === 'boolean' ? r.vibration : d.vibration,
      shake: typeof r.shake === 'boolean' ? r.shake : d.shake,
      fx: n01(r.fx, d.fx), fps: r.fps === 60 ? 60 : 30,
      quality: ['auto', 'low', 'medium', 'high'].includes(r.quality) ? r.quality : d.quality,
      logsConsent: !!r.logsConsent, speed: r.speed === 2 ? 2 : 1,
    };
  } catch {
    return d;
  }
}
export function saveSettings(kv: KV, s: Settings): void {
  kv.set('settings', JSON.stringify(s));
}
