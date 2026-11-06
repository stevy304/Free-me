'use client';

import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';

export interface AdSlot {
  at: number;
  ad: { campaignId: string; headline: string; businessName: string; destinationUrl: string; playbackUrl: string | null; thumbnailUrl: string | null; durationSeconds: number; skipAfterSeconds: number };
}

const post = (path: string, body: object) => fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * One ad over the player: it plays, can be skipped after a few seconds, and "Visit" opens the business's site.
 * Reports that it was shown, and how it ended, so businesses see results and creators are paid by ads shown.
 */
export function AdBreak({ slot, videoId, muted, onDone }: { slot: AdSlot; videoId: string; muted: boolean; onDone: () => void }) {
  const el = useRef<HTMLVideoElement>(null);
  const imp = useRef<Promise<string | null> | null>(null);
  const [t, setT] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const done = useRef(false);
  const finish = (type: 'COMPLETE' | 'SKIP') => {
    if (done.current) return;
    done.current = true;
    void imp.current?.then((id) => { if (id) void post(`/ads/impressions/${id}/events`, { type, ms: Math.round((el.current?.currentTime ?? 0) * 1000) }); });
    onDone();
  };

  useEffect(() => {
    const v = el.current!;
    const src = slot.ad.playbackUrl;
    if (!src) { onDone(); return; }
    let h: Hls | null = null; let cancelled = false;
    v.muted = muted;
    if (v.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) v.src = src;
    else import('hls.js').then(({ default: H }) => {
      if (cancelled) return;
      if (!H.isSupported()) { onDone(); return; }
      h = new H({ capLevelToPlayerSize: true, maxBufferLength: 20 });
      h.on(H.Events.ERROR, (_e, d) => { if (d.fatal) finish('SKIP'); });
      h.loadSource(src); h.attachMedia(v);
    });
    v.play().catch(() => { v.muted = true; v.play().catch(() => setBlocked(true)); });
    // An ad that cannot start within 8 seconds is dropped, so the video is never held up.
    const guard = setTimeout(() => { if (!v.currentTime) finish('SKIP'); }, 8000);
    return () => { cancelled = true; clearTimeout(guard); h?.destroy(); v.removeAttribute('src'); v.load(); };
  }, [slot]); // eslint-disable-line react-hooks/exhaustive-deps

  const left = Math.max(0, Math.ceil(slot.ad.skipAfterSeconds - t));
  const remaining = Math.max(0, Math.ceil((el.current?.duration || slot.ad.durationSeconds) - t));
  return (
    <div className="absolute inset-0 z-30 bg-black" role="region" aria-label={`Ad from ${slot.ad.businessName}`}>
      <video ref={el} playsInline className="h-full w-full" poster={slot.ad.thumbnailUrl ?? undefined}
        onPlaying={() => { if (!imp.current) imp.current = post('/ads/impressions', { campaignId: slot.ad.campaignId, videoId }).then((r) => r.json()).then((j) => j.impressionId ?? null).catch(() => null); }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => finish('COMPLETE')} />
      {blocked && <button type="button" onClick={() => { el.current?.play().then(() => setBlocked(false)).catch(() => undefined); }} className="absolute inset-0 grid place-items-center bg-black/40 text-[16px] font-bold text-white">Tap to play</button>}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pb-6 pt-3 text-white sm:px-5">
        <span className="rounded-md bg-[#f5b95c] px-1.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-[#2a1a02]">Ad</span>
        <span className="truncate text-[13px] font-semibold sm:text-[14px]">{slot.ad.businessName}</span>
        <span className="text-[12px] text-white/70 tabular-nums">· {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-10 sm:px-5 sm:pb-5">
        <div className="min-w-0 flex-1 text-white">
          <p className="truncate text-[14px] font-bold sm:text-[16px]">{slot.ad.headline}</p>
          <a href={slot.ad.destinationUrl} target="_blank" rel="noopener noreferrer nofollow sponsored"
            onClick={() => { el.current?.pause(); void imp.current?.then((id) => { if (id) void post(`/ads/impressions/${id}/events`, { type: 'CLICK', ms: Math.round(t * 1000) }); }); }}
            className="mt-1.5 inline-flex h-9 items-center rounded-xl bg-white px-4 text-[13px] font-bold text-black hover:bg-[#e9efee]">Visit {(() => { try { return new URL(slot.ad.destinationUrl).hostname.replace(/^www\./, ''); } catch { return 'site'; } })()}</a>
        </div>
        <button type="button" disabled={left > 0} onClick={() => finish('SKIP')}
          className="h-10 shrink-0 rounded-xl border border-white/40 bg-black/60 px-4 text-[14px] font-semibold text-white enabled:hover:bg-black/80 disabled:opacity-80">
          {left > 0 ? `Skip in ${left}` : 'Skip ad ›'}
        </button>
      </div>
    </div>
  );
}
