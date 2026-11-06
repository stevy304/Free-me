'use client';

/**
 * Loads the very beginning of a video in advance (its master playlist, the lowest quality's playlist and first
 * segment, and the same for the audio), so that when the viewer moves on to it, it starts at once from the browser
 * cache and the CDN. Each video once per page; silent on any error.
 */
const warmed = new Set<string>();

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const resolve = (base: string, ref: string) => new URL(ref, base).toString();
const get = (url: string) => fetch(url, { credentials: 'same-origin', priority: 'low' } as RequestInit);

async function firstPieces(playlistUrl: string) {
  const res = await get(playlistUrl);
  if (!res.ok) return;
  const text = await res.text();
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
  const first = lines(text).find((l) => !l.startsWith('#'));
  await Promise.all([init, first].filter((x): x is string => !!x).map((u) => get(resolve(playlistUrl, u)).then((r) => r.arrayBuffer()).catch(() => undefined)));
}

export async function warmUp(masterUrl: string | null | undefined) {
  if (!masterUrl || warmed.has(masterUrl) || typeof window === 'undefined') return;
  // Not on slow or metered connections: the viewer may not go to the next video at all.
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return;
  warmed.add(masterUrl);
  try {
    const url = resolve(window.location.href, masterUrl);
    const res = await get(url);
    if (!res.ok) return;
    const text = await res.text();
    const all = lines(text);
    // Renditions are listed lowest first; players start low.
    const variant = all.find((l, i) => !l.startsWith('#') && all[i - 1]?.startsWith('#EXT-X-STREAM-INF'));
    const audio = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/.exec(text)?.[1];
    await Promise.all([variant, audio].filter((x): x is string => !!x).map((p) => firstPieces(resolve(url, p)).catch(() => undefined)));
  } catch { /* best effort */ }
}

/** Origin of a media address, for an early connection to the CDN (null when it is this site). */
export function mediaOrigin(url: string | null | undefined): string | null {
  if (!url || typeof window === 'undefined') return url && /^https?:\/\//.test(url) ? new URL(url).origin : null;
  const o = new URL(url, window.location.href).origin;
  return o === window.location.origin ? null : o;
}
