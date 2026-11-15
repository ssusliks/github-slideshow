import en from '../i18n/en.json';
import kk from '../i18n/kk.json';
import ru from '../i18n/ru.json';
import type { Lang } from './settings';

/**
 * Localisation. All player-facing text lives in src/i18n/<lang>.json; code only references keys.
 * Adding a language = adding a JSON file and one entry in DICTS / LANGS.
 */
export const DICTS: Record<string, Record<string, string>> = { en, ru, kk };
export const LANGS: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
  { id: 'kk', name: 'Қазақша' },
];

let current: Lang = 'en';
const listeners = new Set<() => void>();

export function setLang(l: Lang): void {
  current = DICTS[l] ? l : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  listeners.forEach((f) => f());
}
export const getLang = (): Lang => current;
export const onLangChange = (f: () => void) => listeners.add(f);

/** Translates `key`; `{name}` placeholders are replaced from `params`. Falls back to English, then to the key. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = DICTS[current][key] ?? DICTS.en[key];
  if (s === undefined) return key;
  if (params) for (const k of Object.keys(params)) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
}
export const hasKey = (key: string): boolean => DICTS.en[key] !== undefined;
