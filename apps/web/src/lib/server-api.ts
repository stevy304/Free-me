import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { LANG_COOKIE, langOf, pickLang, translator, type Lang, type T } from '@/i18n';
import type { Viewer } from './types';

const API = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export class ApiUnavailable extends Error {}

/**
 * Server-side GET to the API with the visitor's cookies and language. null for 404 (and 401 unless `throwOn401`).
 * Data is never cached across visitors.
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  const r = await apiFetch<T>(path);
  if (r.status === 404 || r.status === 401) return null;
  if (!r.ok) throw new Error(`API ${path} answered ${r.status}`);
  return r.data as T;
}

/** Like apiGet, but returns the status and the API's message too (e.g. 410 for a removed video). */
export async function apiFetch<T>(path: string): Promise<{ ok: boolean; status: number; data: T | null; message: string | null }> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  let res: Response;
  try {
    res = await fetch(`${API}/api${path}`, { cache: 'no-store', headers: { cookie: c.toString(), 'accept-language': h.get('accept-language') ?? '', 'x-forwarded-for': h.get('x-forwarded-for') ?? '' } });
  } catch {
    throw new ApiUnavailable('The Free Me API is not reachable.');
  }
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data: res.ok ? body as T : null, message: !res.ok && typeof body?.message === 'string' ? body.message : null };
}

/** The signed-in account, or null for visitors (once per request). */
export const getViewer = cache(async (): Promise<Viewer | null> => apiGet<Viewer>('/me'));

/** The interface language: the language switcher's cookie, the account's language, then Accept-Language. */
export const getLang = cache(async (): Promise<Lang> => {
  const [c, h, viewer] = await Promise.all([cookies(), headers(), getViewer().catch(() => null)]);
  return pickLang(c.get(LANG_COOKIE)?.value, viewer?.profile?.preferredLanguage, h.get('accept-language') ?? '');
});

/** Translations for server components: `const t = await getT(); t('home.title')`. */
export async function getT(): Promise<T> { return translator(await getLang()); }

/**
 * The locale for numbers and dates (same on server and browser): the visitor's Accept-Language tag when it is in the
 * interface language ("fr-FR"), otherwise the interface language itself ("rw"), so a Kinyarwanda page shows
 * Kinyarwanda month names.
 */
export const getLocale = cache(async (): Promise<string> => {
  const [h, lang] = await Promise.all([headers(), getLang()]);
  for (const part of (h.get('accept-language') ?? '').split(',')) {
    try {
      const tag = part.split(';')[0].trim();
      if (tag && tag !== '*') { const canonical = Intl.getCanonicalLocales(tag)[0]; if (langOf(canonical) === lang && canonical.toLowerCase().split('-')[0] === lang) return canonical; }
    } catch { /* skip invalid tags */ }
  }
  return lang;
});

/** The site's public origin (https://freeme.example): APP_URL when set, else the address this request came to. */
export async function siteOrigin(): Promise<string> {
  const env = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (env) return env;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
