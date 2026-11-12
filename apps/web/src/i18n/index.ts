import { en, type Key } from './en';
import { fr } from './fr';
import { rw } from './rw';

/**
 * Languages of the interface. The chosen one comes from the `fm_lang` cookie (the language switcher), then the
 * account's language, then the browser's; English otherwise. Text not yet translated falls back to English.
 */
export const LANGS = [
  { code: 'en', name: 'English' },
  { code: 'rw', name: 'Kinyarwanda' },
  { code: 'fr', name: 'Français' },
] as const;
export type Lang = (typeof LANGS)[number]['code'];
export type { Key };
export const LANG_COOKIE = 'fm_lang';

const DICTS: Record<Lang, Partial<Record<Key, string>>> = { en, rw, fr };

export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'rw' || v === 'fr';

/** The interface language of a locale tag ("rw-RW" → rw, "fr-FR" → fr, anything else → en). */
export const langOf = (locale: string | null | undefined): Lang => {
  const base = (locale ?? '').toLowerCase().split('-')[0];
  return isLang(base) ? base : 'en';
};

/** Picks the interface language: the switcher's cookie, the account's language, then the browser's languages. */
export function pickLang(cookie: string | undefined, account: string | null | undefined, acceptLanguage: string): Lang {
  if (isLang(cookie)) return cookie;
  if (isLang(account)) return account;
  for (const part of acceptLanguage.split(',')) {
    const base = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

export type T = (key: Key, vars?: Record<string, string | number>) => string;

/** `t('home.left', { time: '3:20' })` in one language, with English for anything not yet translated. */
export function translator(lang: Lang): T {
  const dict = DICTS[lang];
  return (key, vars) => {
    let s: string = dict[key] ?? en[key];
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

// Kinyarwanda relative time ("hashize iminsi 3"): the browser's own formatter only gives "-3 d".
const RW_UNITS: Record<string, [string, string]> = {
  year: ['umwaka', 'imyaka'], month: ['ukwezi', 'amezi'], week: ['icyumweru', 'ibyumweru'], day: ['umunsi', 'iminsi'],
  hour: ['isaha', 'amasaha'], minute: ['umunota', 'iminota'], second: ['isegonda', 'amasegonda'],
};
export function rwAgo(value: number, unit: string): string {
  const n = Math.abs(value);
  const [one, many] = RW_UNITS[unit] ?? [unit, unit];
  return value <= 0 ? `hashize ${n === 1 ? one : many} ${n}` : `mu ${n === 1 ? one : many} ${n}`;
}

/** A topic's name in the interface language, from its slug; the stored (English) name for a topic not translated. */
export function topicName(t: T, slug: string, stored: string): string {
  const key = `topic.${slug}` as Key;
  return key in en ? t(key) : stored;
}
