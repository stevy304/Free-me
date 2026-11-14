'use client';

import { PlaybackCounts } from '@/lib/playback-counts';
import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MomentAd, type MomentAdData } from './MomentAd';
import { Comments } from '@/components/engagement/Comments';
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
  const counts = useRef<PlaybackCounts | null>(null);
  useEffect(() => {
    const tracker = new PlaybackCounts(v.id); counts.current = tracker;
    const leave = () => { void tracker.flush(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', leave);
    return () => { leave(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', leave); };
  }, [v.id]);
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
    counts.current?.sample(video.currentTime, d, active && !video.paused && !video.seeking && document.visibilityState === 'visible', video.playbackRate);
  };
  const share = async () => { const url = `${location.origin}/watch?v=${v.id}`; try { if (navigator.share) await navigator.share({ title: v.title, url }); else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); } } catch { /* dismissed */ } };
  // Likes and dislikes (both shown on Moments) are read the first time this Moment comes on screen.
  const [votes, setVotes] = useState<{ mine: 'like' | 'dislike' | 'none'; likes: number; dislikes: number } | null>(null);
  const [comments, setComments] = useState<number | null>(null);
  // The conversation opens inside the Moment: beside it on computers, as a sheet from the bottom on phones.
  const [talk, setTalk] = useState(false);
  useEffect(() => { if (!active) setTalk(false); }, [active]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!active || votes) return;
    fetch(`/api/videos/${v.id}`).then((r) => r.ok ? r.json() : null).then((d) => { if (!d) return; setVotes({ mine: d.viewer?.reaction ?? 'none', likes: d.video.likeCount, dislikes: d.video.dislikeCount ?? 0 }); setComments(d.video.commentCount ?? 0); }).catch(() => undefined);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const signIn = () => { window.location.href = `/login?returnTo=${encodeURIComponent(`/moments#${v.id}`)}`; };
  // One reaction at a time: a second tap waits for the first to finish (counts stay exact).
  const voting = useRef(false);
  const vote = async (value: 'like' | 'dislike') => {
    if (!viewer) { signIn(); return; }
    if (voting.current) return;
    voting.current = true;
    const cur = votes ?? { mine: 'none' as const, likes: 0, dislikes: 0 };
    const mine: 'like' | 'dislike' | 'none' = cur.mine === value ? 'none' : value;
    // Shown at once; the server's counts replace the guess.
    const next = { mine, likes: cur.likes + (mine === 'like' ? 1 : 0) - (cur.mine === 'like' ? 1 : 0), dislikes: cur.dislikes + (mine === 'dislike' ? 1 : 0) - (cur.mine === 'dislike' ? 1 : 0) };
    setVotes(next);
    const at = el.current?.currentTime;
    const r = await fetch(`/api/videos/${v.id}/reaction`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: mine, ...(mine === 'like' && at !== undefined ? { at: Math.floor(at) } : {}) }) }).catch(() => null);
    if (r?.ok) { const d = await r.json(); setVotes({ mine, likes: d.likeCount, dislikes: d.dislikeCount ?? next.dislikes }); } else setVotes(cur);
    voting.current = false;
  };
  /** Opens (or starts) a conversation with whoever posted this Moment. */
  const message = async () => {
    if (!viewer) { signIn(); return; }
    window.location.href = `/messages?to=${encodeURIComponent(v.channel.handle)}`;
  };
  const action = 'flex w-full flex-col items-center gap-1 transition-transform hover:scale-105 [text-shadow:0_1px_3px_rgb(0_0_0/0.5)] sm:[text-shadow:none]';

  return (
    <section className="relative flex h-full snap-start snap-always items-center justify-center gap-4 sm:py-3" aria-label={v.title}>
      <div className="relative h-full w-full overflow-hidden bg-black sm:aspect-[9/16] sm:w-auto sm:max-h-[calc(100dvh-6.5rem)] sm:facet-lg">
        <video ref={el} loop playsInline poster={v.thumbnailUrl ?? undefined} className="h-full w-full object-cover"
          onClick={() => { const x = el.current!; if (x.paused) x.play().catch(() => undefined); else x.pause(); }} onPlay={() => setPaused(false)} onPause={() => { setPaused(true); void counts.current?.flush(); }} onTimeUpdate={onTime} />
        <div className="absolute inset-x-0 top-[calc(3.25rem+env(safe-area-inset-top))] flex justify-between p-3 md:top-0">
          <button type="button" onClick={() => { const x = el.current!; if (x.paused) x.play().catch(() => undefined); else x.pause(); }} aria-label={paused ? 'Play' : 'Pause'} className="facet-sm grid h-9 w-9 place-items-center bg-[rgb(20_17_15/0.55)] text-white backdrop-blur">{paused ? <Icon.Play size={20} /> : <Icon.Pause size={20} />}</button>
          <button type="button" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} className="facet-sm grid h-9 w-9 place-items-center bg-[rgb(20_17_15/0.55)] text-white backdrop-blur">{muted ? <Icon.VolumeOff size={20} /> : <Icon.VolumeHigh size={20} />}</button>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-4 pr-[84px] pt-20 text-white sm:pr-4">
          <div className="flex items-center gap-2">
            <Link href={`/@${v.channel.handle}`} className="flex min-w-0 items-center gap-2 text-[14px] font-semibold"><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={36} /><span className="min-w-0"><span className="block truncate text-[15px] font-bold">{v.channel.name}</span><span className="block truncate text-[12px] font-normal opacity-80">@{v.channel.handle}</span></span></Link>
          </div>
          <p className="mt-2 line-clamp-2 text-[14px]">{v.title}</p>
          <p className="mt-1 text-[12px] opacity-80" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)}</p>
        </div>
        <div className="absolute inset-x-4 bottom-2 h-1 overflow-hidden bg-white/25"><div className="h-full bg-[#f4ede3]" style={{ width: `${progress * 100}%` }} /></div>
      </div>
      {/* Actions: one cut-corner panel on the right (over the video on phones, beside it on wide screens), each with
          its name or count under it. The creator's picture sits on top and opens their Space. */}
      <div className="absolute bottom-24 right-2 flex flex-col items-center gap-2.5 text-white sm:static sm:self-end sm:pb-6 sm:text-ink">
        <Link href={`/@${v.channel.handle}`} aria-label={`${v.channel.name}'s Space`} title={v.channel.name} className="relative rounded-full ring-2 ring-[#f4ede3] shadow-[0_4px_14px_rgb(0_0_0/0.35)] transition-transform hover:scale-105 sm:ring-clay">
          <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={42} />
        </Link>
        <div className="facet flex w-[64px] flex-col items-center gap-3 bg-[rgb(20_17_15/0.66)] py-3 text-[11px] font-semibold backdrop-blur-md sm:bg-elevated">
          <button type="button" onClick={() => vote('like')} aria-pressed={votes?.mine === 'like'} aria-label={`Like (${votes?.likes ?? 0})`} className={action}>
            <Icon.Like size={26} filled={votes?.mine === 'like'} className={votes?.mine === 'like' ? 'text-[#e8b04a]' : undefined} />
            <span suppressHydrationWarning>{votes && votes.likes > 0 ? compactNumber(votes.likes, locale) : 'Like'}</span>
          </button>
          <button type="button" onClick={() => vote('dislike')} aria-pressed={votes?.mine === 'dislike'} aria-label={`Dislike (${votes?.dislikes ?? 0})`} className={action}>
            <Icon.Dislike size={26} filled={votes?.mine === 'dislike'} />
            <span suppressHydrationWarning>{votes && votes.dislikes > 0 ? compactNumber(votes.dislikes, locale) : 'Dislike'}</span>
          </button>
          <button type="button" onClick={() => setTalk((x) => !x)} aria-expanded={talk} aria-label={`Comments (${comments ?? 0})`} className={action}>
            <Icon.Comment size={26} filled={talk} className={talk ? 'text-[#22ada2]' : undefined} />
            <span suppressHydrationWarning>{comments ? compactNumber(comments, locale) : 'Comments'}</span>
          </button>
          <button type="button" onClick={share} aria-label="Share" className={action}><Icon.PassAlong size={26} /><span>{copied ? 'Copied' : 'Share'}</span></button>
          {viewer?.channel?.handle !== v.channel.handle && (
            <button type="button" onClick={message} aria-label={`Message @${v.channel.handle}`} className={action}><Icon.Message size={26} /><span>Message</span></button>
          )}
        </div>
      </div>
      {talk && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 sm:hidden" onClick={() => setTalk(false)} />
          <aside aria-label="Comments" className="fixed inset-x-0 bottom-0 z-50 h-[72dvh] rounded-t-2xl bg-[#1e1916] p-5 pt-3 text-white sm:pt-5 shadow-[0_-12px_40px_rgb(0_0_0/0.45)] sm:static sm:z-auto sm:h-full sm:max-h-[calc(100dvh-8rem)] sm:w-[380px] sm:shrink-0 sm:facet sm:shadow-none">
            <button type="button" onClick={() => setTalk(false)} aria-label="Close comments" className="absolute right-3 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-white/10 hover:bg-white/20 sm:hidden"><Icon.Close size={18} /></button>
            <div className="mx-auto mb-7 mt-1 h-1.5 w-10 rounded-full bg-white/25 sm:hidden" aria-hidden />
            <div className="h-[calc(100%-2.75rem)] sm:h-full"><Comments videoId={v.id} initialCount={comments ?? 0} variant="card" /></div>
          </aside>
        </>
      )}
    </section>
  );
}

/** Vertical feed: scroll, swipe or use the arrow keys; the Moment on screen plays, the others pause. */
/** One ad after this many Moments. */
const AD_EVERY = 6;

export function MomentsFeed({ first }: { first: VideoPage }) {
  const { t } = useShell();
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
      <div ref={box} className="no-scrollbar mx-auto h-[calc(100dvh-6.5rem)] snap-y snap-mandatory overflow-y-auto md:h-[calc(100dvh-4rem-2.5rem)]">
        {list.map((x, i) => x.kind === 'moment'
          ? <div key={x.v.id} data-index={i} className="h-full"><Moment v={x.v} muted={muted} setMuted={setMuted} active={i === active} /></div>
          : <div key={`ad-${x.slot}`} data-index={i} className="h-full"><MomentAd ad={x.ad} after={x.after} muted={muted} setMuted={setMuted} active={i === active} /></div>)}
      </div>
      {/* Phones: no app bar here, only the page's name and search, over the video. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/45 to-transparent px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] text-white md:hidden">
        <h1 className="font-display text-[22px] font-extrabold [text-shadow:0_1px_6px_rgb(0_0_0/0.5)]">{t('nav.moments')}</h1>
        <button type="button" onClick={() => window.dispatchEvent(new Event('fm:find'))} aria-label={t('header.find')} className="pointer-events-auto grid h-10 w-10 place-items-center rounded-full hover:bg-white/15"><Icon.Search size={24} /></button>
      </div>
      <div className="absolute right-6 top-1/2 hidden -translate-y-1/2 flex-col gap-3 lg:flex">
        <button type="button" onClick={() => go(-1)} disabled={active === 0} aria-label="Previous Moment" className="facet-sm grid h-12 w-12 place-items-center bg-surface hover:bg-surface-hover disabled:opacity-30"><Icon.ChevronUp size={24} /></button>
        <button type="button" onClick={() => go(1)} disabled={active >= list.length - 1} aria-label="Next Moment" className="facet-sm grid h-12 w-12 place-items-center bg-surface hover:bg-surface-hover disabled:opacity-30"><Icon.ChevronDown size={24} /></button>
      </div>
    </div>
  );
}
