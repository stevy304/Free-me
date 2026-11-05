'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { Avatar } from '@/components/Avatar';
import { useShell } from '@/components/shell/ShellContext';
import { viewsLabel } from '@/lib/format';
import type { VideoCardData, VideoPage } from '@/lib/types';

/** One Moment: plays when it fills the screen, pauses when scrolled away, reports a view after real watching. */
function Moment({ v, muted, setMuted, active }: { v: VideoCardData; muted: boolean; setMuted: (m: boolean) => void; active: boolean }) {
  const el = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const watched = useRef(0); const last = useRef(0); const sent = useRef(false);
  const { locale } = useShell();

  useEffect(() => {
    const video = el.current; if (!video || !v.playbackUrl) return;
    if (!active) { video.pause(); return; }
    let cancelled = false;
    const go = () => { video.muted = muted; void video.play().catch(() => { video.muted = true; setMuted(true); void video.play().catch(() => undefined); }); };
    if (video.src || hls.current) { go(); return; }
    if (video.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) { video.src = v.playbackUrl; go(); }
    else import('hls.js').then(({ default: H }) => {
      if (cancelled || !H.isSupported()) return;
      const h = new H({ capLevelToPlayerSize: true, maxBufferLength: 15 });
      hls.current = h; h.loadSource(v.playbackUrl!); h.attachMedia(video); go();
    });
    return () => { cancelled = true; };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (el.current) el.current.muted = muted; }, [muted]);
  useEffect(() => () => { hls.current?.destroy(); }, []);

  const onTime = () => {
    const video = el.current!; const d = video.duration || v.durationSeconds;
    setProgress(d ? video.currentTime / d : 0);
    const delta = video.currentTime - last.current;
    if (!video.paused && delta > 0 && delta < 2) watched.current += delta;
    last.current = video.currentTime;
    if (!sent.current && d && watched.current >= Math.min(30, d * 0.5)) {
      sent.current = true;
      fetch(`/api/videos/${v.id}/views`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: Math.round(watched.current) }) }).catch(() => undefined);
    }
  };
  const share = async () => { const url = `${location.origin}/watch?v=${v.id}`; try { if (navigator.share) await navigator.share({ title: v.title, url }); else await navigator.clipboard.writeText(url); } catch { /* dismissed */ } };

  return (
    <section className="flex h-full snap-start snap-always items-center justify-center gap-3 py-3" aria-label={v.title}>
      <div className="relative h-full max-h-[calc(100dvh-7rem)] aspect-[9/16] overflow-hidden rounded-2xl bg-black">
        <video ref={el} loop playsInline poster={v.thumbnailUrl ?? undefined} className="h-full w-full object-cover"
          onClick={() => { const x = el.current!; if (x.paused) void x.play(); else x.pause(); }} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onTimeUpdate={onTime} />
        <div className="absolute inset-x-0 top-0 flex justify-between p-3">
          <button type="button" onClick={() => { const x = el.current!; if (x.paused) void x.play(); else x.pause(); }} aria-label={paused ? 'Play' : 'Pause'} className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white">{paused ? <Icon.Play size={20} /> : <Icon.Pause size={20} />}</button>
          <button type="button" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white">{muted ? <Icon.VolumeOff size={20} /> : <Icon.VolumeHigh size={20} />}</button>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-16 text-white">
          <Link href={`/@${v.channel.handle}`} className="flex items-center gap-2 text-[14px] font-semibold"><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={32} />@{v.channel.handle}</Link>
          <p className="mt-2 line-clamp-2 text-[14px]">{v.title}</p>
          <p className="mt-1 text-[12px] opacity-80" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)}</p>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/30"><div className="h-full bg-white" style={{ width: `${progress * 100}%` }} /></div>
      </div>
      <div className="hidden flex-col items-center gap-1 self-end pb-6 sm:flex">
        <button type="button" onClick={share} aria-label="Share" className="grid h-12 w-12 place-items-center rounded-full bg-surface hover:bg-surface-hover"><Icon.Share size={22} /></button>
        <span className="text-[12px]">Share</span>
      </div>
    </section>
  );
}

/** Vertical feed: scroll, swipe or use the arrow keys; the Moment on screen plays, the others pause. */
export function MomentsFeed({ first }: { first: VideoPage }) {
  const [items, setItems] = useState(first.videos);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = box.current!;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index));
    }, { root, threshold: 0.6 });
    root.querySelectorAll('[data-index]').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [items.length]);
  // /moments#<id> opens at that Moment.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const i = items.findIndex((v) => v.id === id);
    if (i > 0) box.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cursor || active < items.length - 3) return;
    fetch(`/api/videos?moments=true&limit=12&cursor=${encodeURIComponent(cursor)}`).then((r) => r.json()).then((d: VideoPage) => { setItems((x) => [...x, ...d.videos]); setCursor(d.nextCursor); }).catch(() => undefined);
  }, [active, cursor, items.length]);
  const go = (d: number) => box.current?.querySelector(`[data-index="${Math.max(0, Math.min(items.length - 1, active + d))}"]`)?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest('input, textarea')) return; if (e.key === 'ArrowDown') { e.preventDefault(); go(1); } if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });

  return (
    <div className="relative">
      <div ref={box} className="no-scrollbar mx-auto h-[calc(100dvh-3.5rem-3rem)] snap-y snap-mandatory overflow-y-auto md:h-[calc(100dvh-3.5rem)]">
        {items.map((v, i) => <div key={v.id} data-index={i} className="h-full"><Moment v={v} muted={muted} setMuted={setMuted} active={i === active} /></div>)}
      </div>
      <div className="absolute right-6 top-1/2 hidden -translate-y-1/2 flex-col gap-3 lg:flex">
        <button type="button" onClick={() => go(-1)} disabled={active === 0} aria-label="Previous Moment" className="grid h-12 w-12 place-items-center rounded-full bg-surface hover:bg-surface-hover disabled:opacity-30"><Icon.ChevronUp size={24} /></button>
        <button type="button" onClick={() => go(1)} disabled={active >= items.length - 1} aria-label="Next Moment" className="grid h-12 w-12 place-items-center rounded-full bg-surface hover:bg-surface-hover disabled:opacity-30"><Icon.ChevronDown size={24} /></button>
      </div>
    </div>
  );
}
