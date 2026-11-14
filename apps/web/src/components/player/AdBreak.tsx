'use client';

import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import * as Icon from '@/components/icons';
import { hlsSettings } from '@/lib/network';

export interface AdSlot {
  at: number;
  ad: { campaignId: string; headline: string; businessName: string; destinationUrl: string; playbackUrl: string | null; thumbnailUrl: string | null; durationSeconds: number; skipAfterSeconds: number };
}

const post = (path: string, body: object) => fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

/**
 * One ad over the player, before (or part-way through) the video: the ad plays full-frame with a small
 * "Sponsored" label, the business card and "Visit" bottom-left, and "Skip" bottom-right once allowed.
 * Reports that it was shown and how it ended, so businesses see results and creators are paid by ads shown.
 */
export function AdBreak({ slot, videoId, muted, onDone }: { slot: AdSlot; videoId: string; muted: boolean; onDone: () => void }) {
  const el = useRef<HTMLVideoElement>(null);
  const imp = useRef<Promise<string | null> | null>(null);
  const [t, setT] = useState(0);
  const [length, setLength] = useState(slot.ad.durationSeconds);
  const [blocked, setBlocked] = useState(false);
  const [sound, setSound] = useState(!muted);
  const done = useRef(false);
  const finish = (type: 'COMPLETE' | 'SKIP') => {
    if (done.current) return;
    done.current = true;
    void imp.current?.then((id) => { if (id) void post(`/ads/impressions/${id}/events`, { type, ms: Math.round((el.current?.currentTime ?? 0) * 1000) }); });
    onDone();
  };
  const visit = () => { el.current?.pause(); void imp.current?.then((id) => { if (id) void post(`/ads/impressions/${id}/events`, { type: 'CLICK', ms: Math.round(t * 1000) }); }); };

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
      h = new H({ capLevelToPlayerSize: true, maxBufferLength: 20, startFragPrefetch: true, ...hlsSettings('short') });
      h.on(H.Events.ERROR, (_e, d) => { if (d.fatal) finish('SKIP'); });
      h.loadSource(src); h.attachMedia(v);
    });
    v.play().catch(() => { v.muted = true; setSound(false); v.play().catch(() => setBlocked(true)); });
    // An ad that cannot start within 8 seconds is dropped, so the video is never held up.
    const guard = setTimeout(() => { if (!v.currentTime) finish('SKIP'); }, 8000);
    return () => { cancelled = true; clearTimeout(guard); h?.destroy(); v.removeAttribute('src'); v.load(); };
  }, [slot]); // eslint-disable-line react-hooks/exhaustive-deps

  const left = Math.max(0, Math.ceil(slot.ad.skipAfterSeconds - t));
  const remaining = Math.max(0, Math.ceil(length - t));
  const progress = length > 0 ? Math.min(100, (t / length) * 100) : 0;
  const site = host(slot.ad.destinationUrl);

  return (
    <div className="absolute inset-0 z-30 bg-black text-white" role="region" aria-label={`Sponsored: ${slot.ad.businessName}`}>
      <video ref={el} playsInline className="h-full w-full" poster={slot.ad.thumbnailUrl ?? undefined}
        onPlaying={() => { if (!imp.current) imp.current = post('/ads/impressions', { campaignId: slot.ad.campaignId, videoId }).then((r) => r.json()).then((j) => j.impressionId ?? null).catch(() => null); }}
        onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setLength(e.currentTarget.duration); }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onEnded={() => finish('COMPLETE')}
        onClick={() => { const v = el.current; if (v) { if (v.paused) void v.play().catch(() => undefined); else v.pause(); } }} />
      {blocked && <button type="button" onClick={() => { el.current?.play().then(() => setBlocked(false)).catch(() => undefined); }} className="absolute inset-0 grid place-items-center bg-black/40 text-[16px] font-bold">Tap to play</button>}

      {/* Sound: ads start muted where the browser insists; one tap turns the sound on. */}
      <button type="button" onClick={() => { const v = el.current; if (v) { v.muted = !v.muted; setSound(!v.muted); } }} aria-label={sound ? 'Mute ad' : 'Turn ad sound on'}
        className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-black/55 hover:bg-black/75 sm:right-4 sm:top-4">{sound ? <Icon.VolumeHigh size={20} /> : <Icon.VolumeOff size={20} />}</button>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/75 to-transparent" />

      {/* Bottom-left: who is advertising, and where "Visit" goes. */}
      <div className="absolute bottom-4 left-3 flex max-w-[calc(100%-6.5rem)] items-center gap-2 rounded-xl bg-black/60 p-1.5 pr-2 sm:max-w-sm sm:gap-2.5 sm:p-2 sm:pr-2.5 backdrop-blur-sm sm:bottom-5 sm:left-4">
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#e8b04a] font-display text-[16px] font-extrabold text-[#2a1a02]">{slot.ad.businessName.trim().charAt(0).toUpperCase() || 'A'}</span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-bold">{slot.ad.headline}</span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-white/75">
            <span className="rounded bg-[#e8b04a] px-1 text-[10px] font-extrabold uppercase tracking-wide text-[#2a1a02]">Sponsored</span>
            <span className="hidden truncate sm:inline">{site}</span>
            <span className="tabular-nums"><span className="hidden sm:inline">· </span>{clock(remaining)}</span>
          </span>
        </span>
        <a href={slot.ad.destinationUrl} target="_blank" rel="noopener noreferrer nofollow sponsored" onClick={visit}
          className="ml-1 inline-flex h-8 shrink-0 items-center rounded-full bg-[#3ea6ff] px-3.5 text-[12.5px] font-bold text-[#04121f] hover:bg-[#65b8ff]">Visit</a>
      </div>

      {/* Bottom-right: a countdown, then "Skip". */}
      <div className="absolute bottom-4 right-0 sm:bottom-5">
        {left > 0
          ? <span className="flex h-9 items-center rounded-l-md bg-black/65 px-3 text-[12.5px] sm:h-10 sm:px-4 sm:text-[13px] font-semibold tabular-nums text-white/90" aria-live="polite">Skip in {left}</span>
          : <button type="button" onClick={() => finish('SKIP')} className="flex h-9 items-center gap-1.5 rounded-l-md border border-r-0 border-white/40 bg-black/70 px-3 text-[13px] sm:h-10 sm:px-4 sm:text-[14px] font-semibold hover:bg-black/90">Skip <span aria-hidden className="text-[16px]">›|</span></button>}
      </div>

      {/* A thin yellow bar shows how much of the ad is left. */}
      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20" aria-hidden><div className="h-full bg-[#e8b04a] transition-[width] duration-200 ease-linear" style={{ width: `${progress}%` }} /></div>
    </div>
  );
}
