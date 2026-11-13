'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MomentAd, type MomentAdData } from './MomentAd';
import type Hls from 'hls.js';
import { Avatar } from '@/components/Avatar';
import { useShell } from '@/components/shell/ShellContext';
import { compactNumber, viewsLabel } from '@/lib/format';
import type { VideoCardData, VideoPage } from '@/lib/types';

/** One Moment: plays when it fills the screen, pauses when scrolled away, reports a view after real watching. */
function Moment({ v, muted, setMuted, active }: { v: VideoCardData; muted: boolean; setMuted: (m: boolean) => void; active: boolean }) {
  const el = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const watched = useRef(0); const last = useRef(0); const sent = useRef(false);
  const ticket = useRef<Promise<string | null> | null>(null);
  const { locale, viewer } = useShell();

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
    if (!video.paused && delta > 0 && delta < 2) {
      // Playback really started: the play ticket the view needs.
      if (!ticket.current) ticket.current = fetch(`/api/videos/${v.id}/play`, { method: 'POST', credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.ticket ?? null).catch(() => null);
      watched.current += delta;
    }
    last.current = video.currentTime;
    if (!sent.current && d && watched.current >= Math.min(30, d * 0.5)) {
      sent.current = true;
      const seconds = Math.round(watched.current);
      void (ticket.current ?? Promise.resolve(null)).then((t) => fetch(`/api/videos/${v.id}/views`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: seconds, ...(t ? { ticket: t } : {}) }) })).catch(() => undefined);
    }
  };
  const share = async () => { const url = `${location.origin}/watch?v=${v.id}`; try { if (navigator.share) await navigator.share({ title: v.title, url }); else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } } catch { /* dismissed */ } };
  // Likes and dislikes (both shown on Moments) are read the first time this Moment comes on screen.
  const [votes, setVotes] = useState<{ mine: 'like' | 'dislike' | 'none'; likes: number; dislikes: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!active || votes) return;
    fetch(`/api/videos/${v.id}`).then((r) => r.ok ? r.json() : null).then((d) => d && setVotes({ mine: d.viewer?.reaction ?? 'none', likes: d.video.likeCount, dislikes: d.video.dislikeCount ?? 0 })).catch(() => undefined);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const signIn = () => { window.location.href = `/login?returnTo=${encodeURIComponent(`/moments#${v.id}`)}`; };
  const vote = async (value: 'like' | 'dislike') => {
    if (!viewer) { signIn(); return; }
    const cur = votes ?? { mine: 'none' as const, likes: 0, dislikes: 0 };
    const mine: 'like' | 'dislike' | 'none' = cur.mine === value ? 'none' : value;
    // Shown at once; the server's counts replace the guess.
    const next = { mine, likes: cur.likes + (mine === 'like' ? 1 : 0) - (cur.mine === 'like' ? 1 : 0), dislikes: cur.dislikes + (mine === 'dislike' ? 1 : 0) - (cur.mine === 'dislike' ? 1 : 0) };
    setVotes(next);
    const at = el.current?.currentTime;
    const r = await fetch(`/api/videos/${v.id}/reaction`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: mine, ...(mine === 'like' && at !== undefined ? { at: Math.floor(at) } : {}) }) }).catch(() => null);
    if (r?.ok) { const d = await r.json(); setVotes({ mine, likes: d.likeCount, dislikes: d.dislikeCount ?? next.dislikes }); } else setVotes(cur);
  };
  /** Opens (or starts) a conversation with whoever posted this Moment. */
  const message = async () => {
    if (!viewer) { signIn(); return; }
    window.location.href = `/messages?to=${encodeURIComponent(v.channel.handle)}`;
  };
  const action = 'grid h-12 w-12 place-items-center rounded-2xl backdrop-blur';

  return (
    <section className="relative flex h-full snap-start snap-always items-center justify-center gap-4 py-3" aria-label={v.title}>
      <div className="relative aspect-[9/16] h-full max-h-[calc(100dvh-8rem)] overflow-hidden rounded-[26px] bg-black shadow-[var(--shadow)]">
        <video ref={el} loop playsInline poster={v.thumbnailUrl ?? undefined} className="h-full w-full object-cover"
          onClick={() => { const x = el.current!; if (x.paused) x.play().catch(() => undefined); else x.pause(); }} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onTimeUpdate={onTime} />
        <div className="absolute inset-x-0 top-0 flex justify-between p-3">
          <button type="button" onClick={() => { const x = el.current!; if (x.paused) x.play().catch(() => undefined); else x.pause(); }} aria-label={paused ? 'Play' : 'Pause'} className="grid h-10 w-10 place-items-center rounded-xl bg-[rgb(16_32_31/0.55)] text-white backdrop-blur">{paused ? <Icon.Play size={20} /> : <Icon.Pause size={20} />}</button>
          <button type="button" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} className="grid h-10 w-10 place-items-center rounded-xl bg-[rgb(16_32_31/0.55)] text-white backdrop-blur">{muted ? <Icon.VolumeOff size={20} /> : <Icon.VolumeHigh size={20} />}</button>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 pt-16 text-white">
          <div className="flex items-center gap-2">
            <Link href={`/@${v.channel.handle}`} className="flex min-w-0 items-center gap-2 text-[14px] font-semibold"><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={32} /><span className="truncate">@{v.channel.handle}</span></Link>
            {viewer?.channel?.handle !== v.channel.handle && (
              <button type="button" onClick={message} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3 text-[12.5px] font-semibold backdrop-blur hover:bg-white/25">
                <Icon.Message size={16} />Message
              </button>
            )}
          </div>
          <p className="mt-2 line-clamp-2 text-[14px]">{v.title}</p>
          <p className="mt-1 text-[12px] opacity-80" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)}</p>
        </div>
        <div className="absolute inset-x-4 bottom-2 h-1 overflow-hidden rounded-full bg-white/25"><div className="h-full rounded-full bg-[#f5b95c]" style={{ width: `${progress * 100}%` }} /></div>
      </div>
      {/* Actions: beside the video on wide screens, over it on phones. */}
      <div className="absolute bottom-24 right-5 flex flex-col items-center gap-3 text-[11px] font-semibold text-white sm:static sm:self-end sm:pb-6 sm:text-ink">
        <button type="button" onClick={() => vote('like')} aria-pressed={votes?.mine === 'like'} aria-label={`Like (${votes?.likes ?? 0})`} className={`${action} ${votes?.mine === 'like' ? 'bg-[#e8505b] text-white' : 'bg-[rgb(16_32_31/0.55)] text-white sm:bg-surface sm:text-ink sm:hover:bg-surface-hover'}`}><Icon.Like size={24} filled={votes?.mine === 'like'} /></button>
        <span suppressHydrationWarning>{votes ? compactNumber(votes.likes, locale) : ''}</span>
        <button type="button" onClick={() => vote('dislike')} aria-pressed={votes?.mine === 'dislike'} aria-label={`Dislike (${votes?.dislikes ?? 0})`} className={`${action} ${votes?.mine === 'dislike' ? 'bg-[#5b6b8a] text-white' : 'bg-[rgb(16_32_31/0.55)] text-white sm:bg-surface sm:text-ink sm:hover:bg-surface-hover'}`}><Icon.Dislike size={24} filled={votes?.mine === 'dislike'} /></button>
        <span suppressHydrationWarning>{votes ? compactNumber(votes.dislikes, locale) : ''}</span>
        <Link href={`/watch?v=${v.id}`} aria-label="Conversation" className={`${action} bg-[rgb(16_32_31/0.55)] text-white sm:bg-surface sm:text-ink sm:hover:bg-surface-hover`}><Icon.Comment size={22} /></Link>
        <button type="button" onClick={share} aria-label="Pass along" className={`${action} bg-[rgb(16_32_31/0.55)] text-white sm:bg-surface sm:text-ink sm:hover:bg-surface-hover`}><Icon.PassAlong size={22} /></button>
        <span>{copied ? 'Copied' : 'Pass'}</span>
      </div>
    </section>
  );
}

/** Vertical feed: scroll, swipe or use the arrow keys; the Moment on screen plays, the others pause. */
/** One ad after this many Moments. */
const AD_EVERY = 6;

export function MomentsFeed({ first }: { first: VideoPage }) {
  const [items, setItems] = useState(first.videos);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  // Ads between Moments: one after every AD_EVERY Moments, asked for just before it is reached (none for Plus members).
  const [ads, setAds] = useState<Record<number, MomentAdData | null>>({});
  const list = useMemo(() => {
    const out: Array<{ kind: 'moment'; v: VideoCardData } | { kind: 'ad'; ad: MomentAdData; after: string; slot: number }> = [];
    items.forEach((v, i) => {
      out.push({ kind: 'moment', v });
      const slot = (i + 1) / AD_EVERY;
      if (Number.isInteger(slot) && ads[slot]) out.push({ kind: 'ad', ad: ads[slot]!, after: v.id, slot });
    });
    return out;
  }, [items, ads]);
  useEffect(() => {
    const seen = list.slice(0, active + 1).filter((x) => x.kind === 'moment').length;
    const slot = Math.floor(seen / AD_EVERY) + 1;
    if (seen < slot * AD_EVERY - 3 || slot in ads || items.length < slot * AD_EVERY) return;
    setAds((a) => ({ ...a, [slot]: null }));
    fetch('/api/moments/ads', { credentials: 'same-origin' }).then((r) => r.json()).then((d: { ad: MomentAdData | null }) => { if (d.ad?.playbackUrl) setAds((a) => ({ ...a, [slot]: d.ad })); }).catch(() => undefined);
  }, [active, list, ads, items.length]);

  useEffect(() => {
    const root = box.current!;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index));
    }, { root, threshold: 0.6 });
    root.querySelectorAll('[data-index]').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [list.length]);
  // /moments#<id> opens at that Moment.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const i = list.findIndex((x) => x.kind === 'moment' && x.v.id === id);
    if (i > 0) box.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cursor || active < list.length - 3) return;
    fetch(`/api/videos?moments=true&limit=12&cursor=${encodeURIComponent(cursor)}`).then((r) => r.json()).then((d: VideoPage) => { setItems((x) => [...x, ...d.videos]); setCursor(d.nextCursor); }).catch(() => undefined);
  }, [active, cursor, list.length]);
  const go = (d: number) => box.current?.querySelector(`[data-index="${Math.max(0, Math.min(list.length - 1, active + d))}"]`)?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest('input, textarea')) return; if (e.key === 'ArrowDown') { e.preventDefault(); go(1); } if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });

  return (
    <div className="relative">
      <div ref={box} className="no-scrollbar mx-auto h-[calc(100dvh-4rem-6.5rem)] snap-y snap-mandatory overflow-y-auto md:h-[calc(100dvh-4rem-2.5rem)]">
        {list.map((x, i) => x.kind === 'moment'
          ? <div key={x.v.id} data-index={i} className="h-full"><Moment v={x.v} muted={muted} setMuted={setMuted} active={i === active} /></div>
          : <div key={`ad-${x.slot}`} data-index={i} className="h-full"><MomentAd ad={x.ad} after={x.after} muted={muted} setMuted={setMuted} active={i === active} /></div>)}
      </div>
      <div className="absolute right-6 top-1/2 hidden -translate-y-1/2 flex-col gap-3 lg:flex">
        <button type="button" onClick={() => go(-1)} disabled={active === 0} aria-label="Previous Moment" className="grid h-12 w-12 place-items-center rounded-2xl bg-surface hover:bg-surface-hover disabled:opacity-30"><Icon.ChevronUp size={24} /></button>
        <button type="button" onClick={() => go(1)} disabled={active >= list.length - 1} aria-label="Next Moment" className="grid h-12 w-12 place-items-center rounded-2xl bg-surface hover:bg-surface-hover disabled:opacity-30"><Icon.ChevronDown size={24} /></button>
      </div>
    </div>
  );
}
