import { cookies, headers } from 'next/headers';
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

/** The visitor's language from Accept-Language, as a valid tag, so server and browser format numbers and dates alike. */
export async function getLocale(): Promise<string> {
  const header = (await headers()).get('accept-language') ?? '';
  for (const part of header.split(',')) {
    try { const tag = part.split(';')[0].trim(); if (tag && tag !== '*') return Intl.getCanonicalLocales(tag)[0]; } catch { /* skip invalid tags */ }
  }
  return 'en';
}

/** The signed-in account, or null for visitors. */
export async function getViewer(): Promise<Viewer | null> {
  return apiGet<Viewer>('/me');
}
