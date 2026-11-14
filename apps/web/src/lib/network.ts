'use client';

import type { HlsConfig } from 'hls.js';

/**
 * Playing on weak connections (2G/3G, a busy cell, "save data"): every player takes its hls.js settings from here.
 *
 * - Weak: start at the lowest quality (the first picture comes fast, then it climbs), assume a low speed until it is
 *   measured, climb only on a clear margin, keep more seconds in hand to ride out drops, and wait longer and retry
 *   more before giving up on a piece of video.
 * - Everywhere: retries back off (1 s, 2 s, 4 s… up to 8 s) instead of hammering a struggling network.
 */
interface Connection { saveData?: boolean; effectiveType?: string; downlink?: number; rtt?: number }
const connection = (): Connection | undefined => (typeof navigator !== 'undefined' ? (navigator as { connection?: Connection }).connection : undefined);

/** Weak: the device says so (save data, 2G/3G), or it measures under 1.5 Mb/s or a round trip over 400 ms. */
export function weakConnection(): boolean {
  const c = connection();
  if (!c) return false;
  return c.saveData === true || ['slow-2g', '2g', '3g'].includes(c.effectiveType ?? '') || (c.downlink !== undefined && c.downlink > 0 && c.downlink < 1.5) || (c.rtt !== undefined && c.rtt > 400);
}

/** What the device measured, in bits per second, a little under (null when the browser does not say). */
function measuredBps(): number | null {
  const d = connection()?.downlink;
  return d && d > 0 ? Math.round(d * 1_000_000 * 0.8) : null;
}

const policy = (firstByteMs: number, loadMs: number, retries: number) => ({
  default: {
    maxTimeToFirstByteMs: firstByteMs, maxLoadTimeMs: loadMs,
    timeoutRetry: { maxNumRetry: retries, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' as const },
    errorRetry: { maxNumRetry: retries, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' as const },
  },
});

/**
 * hls.js settings for a kind of playback on this connection: `vod` (the watch page), `short` (Moments and short ads:
 * small buffers, they are swiped away) or `live`.
 */
export function hlsSettings(kind: 'vod' | 'short' | 'live'): Partial<HlsConfig> {
  const weak = weakConnection();
  const bps = measuredBps();
  const base: Partial<HlsConfig> = {
    fragLoadPolicy: weak ? policy(20_000, 120_000, 8) : policy(10_000, 60_000, 5),
    playlistLoadPolicy: weak ? policy(15_000, 30_000, 6) : policy(10_000, 20_000, 4),
    manifestLoadPolicy: weak ? policy(15_000, 30_000, 6) : policy(10_000, 20_000, 4),
    ...(bps ? { abrEwmaDefaultEstimate: Math.max(100_000, bps) } : {}),
  };
  if (!weak) return base;
  return {
    ...base,
    ...(kind === 'live' ? {} : { startLevel: 0 }),
    abrEwmaDefaultEstimate: Math.max(100_000, Math.min(bps ?? 300_000, 600_000)),
    // Climb only when the measured speed is clearly enough; drop quickly when it is not.
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.5,
    maxBufferLength: kind === 'vod' ? 60 : kind === 'short' ? 20 : 30,
    maxMaxBufferLength: kind === 'vod' ? 120 : 40,
  };
}

/** How many times a player restarts loading after hls.js gave up, before showing the connection problem. */
export const networkRecoveries = () => (weakConnection() ? 8 : 3);
