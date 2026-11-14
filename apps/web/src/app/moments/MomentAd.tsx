'use client';

import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import * as Icon from '@/components/icons';

export interface MomentAdData { campaignId: string; headline: string; businessName: string; destinationUrl: string; playbackUrl: string | null; thumbnailUrl: string | null; durationSeconds: number }

const post = (path: string, body: object) => fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

/**
 * An ad between Moments (like ads between Shorts): full screen, "Sponsored", the business and "Visit". Viewers skip it
 * by scrolling on. It reports that it was shown (after the Moment `after`) and how it ended. Creators are paid from
 * the Moments pool by their Moments views, not by which Moment the ad followed.
 */
export function MomentAd({ ad, after, active, muted, setMuted }: { ad: MomentAdData; after: string; active: boolean; muted: boolean; setMuted: (m: boolean) => void }) {
  const el = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const imp = useRef<Promise<string | null> | null>(null);
  const ended = useRef(false);
  const [progress, setProgress] = useState(0);

  const report = (type: 'COMPLETE' | 'SKIP' | 'CLICK') => void imp.current?.then((id) => {
    if (id) void post(`/ads/impressions/${id}/events`, { type, ms: Math.round((el.current?.currentTime ?? 0) * 1000) }).catch(() => undefined);
  });

  useEffect(() => {
    const video = el.current; if (!video || !ad.playbackUrl) return;
    if (!active) {
      video.pause();
      // Scrolled past before the end: skipped.
      if (imp.current && !ended.current) { ended.current = true; report('SKIP'); }
      return;
    }
    let cancelled = false;
    const go = () => { video.muted = muted; void video.play().catch(() => { video.muted = true; setMuted(true); void video.play().catch(() => undefined); }); };
    if (video.src || hls.current) { go(); return; }
    if (video.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) { video.src = ad.playbackUrl; go(); }
    else import('hls.js').then(({ default: H }) => {
      if (cancelled || !H.isSupported()) return;
      const h = new H({ capLevelToPlayerSize: true, maxBufferLength: 15 });
      hls.current = h; h.loadSource(ad.playbackUrl!); h.attachMedia(video); go();
    });
    return () => { cancelled = true; };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (el.current) el.current.muted = muted; }, [muted]);
  useEffect(() => () => { hls.current?.destroy(); }, []);

  return (
    <section aria-label={`Sponsored: ${ad.headline}`} className="relative flex h-full snap-start snap-always items-center justify-center sm:py-3">
      <div className="relative h-full w-full overflow-hidden bg-black text-white sm:aspect-[9/16] sm:w-auto sm:max-h-[calc(100dvh-6.5rem)] sm:rounded-2xl sm:shadow-[var(--shadow)]">
      <video ref={el} playsInline loop={false} poster={ad.thumbnailUrl ?? undefined} className="h-full w-full object-contain"
        onPlaying={() => { if (!imp.current) imp.current = post('/ads/impressions', { campaignId: ad.campaignId, videoId: after, placement: 'MOMENTS' }).then((r) => r.json()).then((j) => j.impressionId ?? null).catch(() => null); }}
        onTimeUpdate={(e) => { const d = e.currentTarget.duration || ad.durationSeconds; setProgress(d ? e.currentTarget.currentTime / d : 0); }}
        onEnded={() => { if (!ended.current) { ended.current = true; report('COMPLETE'); } }}
        onClick={() => { const v = el.current; if (v) { if (v.paused) void v.play().catch(() => undefined); else v.pause(); } }} />
      <button type="button" onClick={() => setMuted(!muted)} aria-label={muted ? 'Turn sound on' : 'Mute'} className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-black/55 hover:bg-black/75">
        {muted ? <Icon.VolumeOff size={20} /> : <Icon.VolumeHigh size={20} />}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 to-transparent" />
      <div className="absolute inset-x-3 bottom-5 flex items-end gap-3">
        <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#e8b04a] font-display text-[18px] font-extrabold text-[#2a1a02]">{ad.businessName.trim().charAt(0).toUpperCase() || 'A'}</span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[15px] font-bold">{ad.businessName}</p>
          <p className="line-clamp-2 text-[14px] text-white/90">{ad.headline}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-white/75">
            <span className="rounded bg-[#e8b04a] px-1 text-[10px] font-extrabold uppercase tracking-wide text-[#2a1a02]">Sponsored</span>
            <span className="truncate">{host(ad.destinationUrl)}</span>
          </p>
        </div>
        <a href={ad.destinationUrl} target="_blank" rel="noopener noreferrer nofollow sponsored" onClick={() => { el.current?.pause(); report('CLICK'); }}
          className="inline-flex h-10 shrink-0 items-center rounded-full bg-[#3ea6ff] px-4 text-[14px] font-bold text-[#04121f] hover:bg-[#65b8ff]">Visit</a>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20"><div className="h-full bg-[#e8b04a]" style={{ width: `${progress * 100}%` }} /></div>
      </div>
    </section>
  );
}
