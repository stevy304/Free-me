'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { FollowButton } from '@/components/FollowButton';
import { Comments, type CommentData } from '@/components/engagement/Comments';
import { ReportDialog } from '@/components/engagement/ReportDialog';
import { SaveDialog } from '@/components/engagement/SaveDialog';
import { VideoPlayer, type CaptionTrack } from '@/components/player/VideoPlayer';
import { useShell } from '@/components/shell/ShellContext';
import { Thumbnail, VideoRow } from '@/components/video/VideoCard';
import { api } from '@/lib/client-api';
import { compactNumber, duration, followersLabel, fullDate, timeAgo, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { handOffToDock } from '@/components/player/MiniDock';
import { useRealtime } from '@/lib/realtime';
import { mediaOrigin, warmUp } from '@/lib/warmup';

export interface WatchVideo extends VideoCardData {
  description: string | null; status: string; visibility: string; likeCount: number; commentCount: number; commentsOpen: boolean; playbackUrl: string | null; processingStage: string | null;
  /** Set when this viewer gets qualities up to this height only (higher ones come with Premium). */
  qualityLimit?: number | null;
  takenDownAt: string | null; storyboardUrl?: string | null; captions?: CaptionTrack[]; category: { name: string; slug: string } | null; channel: VideoCardData['channel'] & { followerCount: number };
}
export interface WatchViewer { signedIn: boolean; isOwner: boolean; following: boolean; saved: boolean; reaction: 'like' | 'dislike' | 'none'; resumeAt: number }


export function WatchView({ v, more, viewer: initialViewer }: { v: WatchVideo; more: VideoCardData[]; viewer: WatchViewer }) {
  const { locale, t } = useShell();
  const router = useRouter();
  const [theater, setTheater] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reaction, setReaction] = useState(initialViewer.reaction);
  const [likes, setLikes] = useState(v.likeCount);
  // Sparks from other viewers show up at once.
  useRealtime<{ likeCount: number }>('reactions', (d) => setLikes(d.likeCount), `video:${v.id}`);
  const [saved, setSaved] = useState(initialViewer.saved);
  const [dialog, setDialog] = useState<null | 'save' | 'report'>(null);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const time = useRef(0);
  // The most Sparked moments, marked in gold on the progress bar.
  const [moments, setMoments] = useState<number[]>([]);
  useEffect(() => { api<{ moments: Array<{ at: number }> }>(`/videos/${v.id}/sparked-moments`).then((r) => setMoments(r.moments.map((m) => m.at))).catch(() => undefined); }, [v.id]);
  const login = `/login?returnTo=${encodeURIComponent(`/watch?v=${v.id}`)}`;

  useEffect(() => { try { setTheater(localStorage.getItem('fm_theater') === '1'); } catch { /* blocked */ } }, []);
  const toggleTheater = () => setTheater((t) => { try { localStorage.setItem('fm_theater', t ? '0' : '1'); } catch { /* blocked */ } return !t; });
  const share = async () => {
    const url = `${window.location.origin}/watch?v=${v.id}`;
    try { if (navigator.share) await navigator.share({ title: v.title, url }); else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } } catch { /* dismissed */ }
  };
  const react = async (value: 'like' | 'dislike') => {
    if (!initialViewer.signedIn) { router.push(login); return; }
    const next = reaction === value ? 'none' : value;
    const before = { reaction, likes };
    // Show the change at once; the server's count replaces the guess.
    setReaction(next); setLikes(likes + (next === 'like' ? 1 : 0) - (reaction === 'like' ? 1 : 0)); setError(null);
    // Where in the video the Spark was given (the player's own clock): the most Sparked moments are marked on the bar.
    const at = stage.current?.querySelector('video')?.currentTime ?? time.current;
    try { const r = await api<{ likeCount: number }>(`/videos/${v.id}/reaction`, { method: 'PUT', body: { value: next, ...(next === 'like' && Number.isFinite(at) ? { at: Math.floor(at) } : {}) } }); setLikes(r.likeCount); }
    catch (e) { setReaction(before.reaction); setLikes(before.likes); setError((e as Error).message); }
  };
  const progress = useCallback((seconds: number, ended: boolean) => {
    time.current = seconds;
    // Two thirds in: load the start of the next video, so it plays at once when this one ends.
    if (seconds > Math.min(v.durationSeconds * 0.66, v.durationSeconds - 20)) void warmUp(more[0]?.playbackUrl);
    if (!initialViewer.signedIn) return;
    fetch(`/api/videos/${v.id}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds, ended }), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
  }, [v.id, v.durationSeconds, more, initialViewer.signedIn]);
  const need = (what: 'save' | 'report') => { setMenu(false); if (!initialViewer.signedIn) router.push(login); else setDialog(what); };
  const [tab, setTab] = useState<'about' | 'conversation' | 'next'>('conversation');
  useEffect(() => { if (window.matchMedia('(min-width: 1280px)').matches) setTab((x) => (x === 'conversation' ? 'about' : x)); }, []);

  // Next: what plays after this one. "Flow on" moves to it by itself after a short, cancellable countdown.
  const next = more[0] ?? null;
  const [flow, setFlow] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => { try { setFlow(localStorage.getItem('fm_flow') !== '0'); } catch { /* blocked */ } }, []);
  const toggleFlow = () => setFlow((f) => { try { localStorage.setItem('fm_flow', f ? '0' : '1'); } catch { /* blocked */ } if (f) setCountdown(null); return !f; });
  const ended = useCallback(() => { if (flow && next) setCountdown(8); }, [flow, next]);
  useEffect(() => {
    if (countdown === null || !next) return;
    if (countdown <= 0) { router.push(`/watch?v=${next.id}`); return; }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, next, router]);

  // Leaving the page while the video plays: it keeps playing in the mini-player (MiniDock) at the same moment.
  // A layout-effect cleanup runs before React removes the page, while the video still has its real time and state.
  const stage = useRef<HTMLDivElement>(null);
  const handOff = useRef<() => void>(() => undefined);
  handOff.current = () => {
    const vids = Array.from(stage.current?.querySelectorAll('video') ?? []);
    const main = vids.find((x) => !x.paused && !x.ended && x.currentTime > 0 && (!v.durationSeconds || Math.abs((x.duration || 0) - v.durationSeconds) < 3));
    handOffToDock(main && v.playbackUrl ? { id: v.id, title: v.title, channelName: v.channel.name, src: v.playbackUrl, poster: v.thumbnailUrl, time: main.currentTime, signedIn: initialViewer.signedIn } : null);
  };
  useLayoutEffect(() => () => handOff.current(), [v.id]);

  // Mini-player (tablets and up): while the video plays and the stage scrolls out of view, it keeps playing in a corner.
  // Phones keep the video pinned to the top instead.
  const [playing, setPlaying] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => {
      const out = e.intersectionRatio < 0.35;
      setOffscreen(out && window.matchMedia('(min-width: 640px)').matches);
      if (!out) setDismissed(false);
    }, { threshold: [0, 0.35, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const docked = offscreen && playing && !dismissed && !!v.playbackUrl;

  // Phones: About and Conversation open in a panel under the pinned video.
  const top = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<null | 'about' | 'conversation'>(null);
  const openSheet = (which: 'about' | 'conversation') => {
    const y = (top.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
    window.scrollTo({ top: y });
    setSheet(which);
  };
  useEffect(() => {
    if (!sheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [sheet]);
  // A peek at the conversation for the phone card.
  const [firstComment, setFirstComment] = useState<CommentData | null>(null);
  useEffect(() => {
    if (!v.commentsOpen || v.commentCount === 0) return;
    let live = true;
    api<{ comments: CommentData[] }>(`/videos/${v.id}/comments?sort=newest`).then((p) => { if (live) setFirstComment(p.comments.find((c) => c.author && !c.deleted) ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [v.id, v.commentsOpen, v.commentCount]);

  // An early connection to the CDN (DNS, TLS) before the player asks for the first segment.
  const cdn = mediaOrigin(v.playbackUrl);
  const player = v.playbackUrl
    ? <VideoPlayer key={v.id} src={v.playbackUrl} poster={v.thumbnailUrl} videoId={v.id} durationHint={v.durationSeconds} theater={theater} onTheater={toggleTheater} startAt={initialViewer.resumeAt} storyboard={v.storyboardUrl} captions={v.captions ?? []} markers={moments} withAds onProgress={progress} onEnded={ended} onPlayingChange={(p) => { setPlaying(p); if (p) setCountdown(null); }} />
    : <div className="grid aspect-video w-full place-items-center rounded-[24px] bg-[#0b1413] text-center text-[15px] text-[#9fb0ad]"><div><Icon.Spinner className="mx-auto mb-3 animate-spin" />{v.takenDownAt ? t('watch.removed') : v.processingStage ?? t('watch.processing')}</div></div>;

  const pill = 'flex h-11 shrink-0 items-center gap-2 rounded-full border border-[#2bb5ab]/70 px-5 text-[14px] font-semibold text-white shadow-[0_0_14px_rgb(43_181_171/0.16)] transition-colors hover:bg-[#2bb5ab]/12';
  const phonePill = 'flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-white/25 px-4 text-[14px] font-semibold text-white';
  const phoneIcon = 'grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/25 text-white';
  const menuItems = (
    <>
      {!initialViewer.isOwner && <button type="button" role="menuitemcheckbox" aria-checked={reaction === 'dislike'} onClick={() => { setMenu(false); void react('dislike'); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.NotForMe size={20} filled={reaction === 'dislike'} /><span className="flex-1 text-left">{t('watch.notForMe')}</span><span className="text-[11px] text-muted">{t('watch.private')}</span></button>}
      {!initialViewer.isOwner && <button type="button" role="menuitem" onClick={() => need('report')} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.Flag size={20} />{t('watch.report')}</button>}
      {!initialViewer.isOwner && <Link role="menuitem" href={`/legal/copyright/notice?v=${v.id}`} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.Copyright size={20} />{t('watch.copyright')}</Link>}
      <Link role="menuitem" href="/trail" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.Trail size={20} />{t('watch.yourTrail')}</Link>
    </>
  );
  const meta = <span suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {v.publishedAt ? timeAgo(v.publishedAt, locale) : t('watch.notPublished')}</span>;
  const tabBtn = (k: typeof tab, label: string) => <button type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3.5 py-2.5 text-[14px] font-semibold ${tab === k ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink'}`}>{label}</button>;

  return (
    // Phones: no floating dock here, so the dark page runs to the bottom over the space kept for it.
    <div className="max-sm:-mb-28">
      {cdn && <link rel="preconnect" href={cdn} crossOrigin="" />}
      {/* Stage: the video on a dark band, lit softly by the brand colour. */}
      {/* Phones: the video sticks to the top, edge to edge, while the page scrolls under it. */}
      <div ref={top} />
      <section className="sticky top-0 z-30 bg-stage sm:relative sm:z-auto sm:px-6 sm:pb-10 sm:pt-6" style={{ backgroundImage: 'radial-gradient(ellipse at 50% 35%, rgb(12 130 126 / 0.32), transparent 62%)' }}>
        <div className="mx-auto flex max-w-[1880px] justify-center gap-7">
          <div className={`min-w-0 flex-1 transition-[max-width] duration-300 ${theater ? 'sm:max-w-[min(1800px,calc((100dvh-6rem)*16/9))]' : 'sm:max-w-[min(1280px,calc((100dvh-15rem)*16/9))] xl:max-w-[calc((100dvh-7.5rem)*16/9)]'}`}>
          <div ref={stage} className={`relative isolate ${docked ? 'aspect-video' : 'sm:rounded-[24px] sm:shadow-[0_0_0_1px_rgb(43_181_171/0.45),0_0_36px_rgb(43_181_171/0.22)]'}`}>
            {/* A soft glow of the video's own colours around the player. */}
            {!docked && v.thumbnailUrl && <div aria-hidden className="pointer-events-none absolute inset-x-6 -bottom-6 top-10 -z-10 hidden rounded-[40px] bg-cover bg-center opacity-45 blur-[60px] saturate-150 sm:block" style={{ backgroundImage: `url(${v.thumbnailUrl})` }} />}
            {docked && <div className="absolute inset-0 grid place-items-center rounded-[24px] border border-white/10 text-[14px] text-[#9fb0ad]">{t('watch.corner')}</div>}
            <div className={docked ? 'fixed bottom-4 right-4 z-50 w-[min(400px,calc(100vw-2rem))] overflow-hidden rounded-[20px] bg-stage shadow-[0_18px_48px_rgb(0_0_0/0.45)] [&_video]:rounded-none' : 'relative'}>
              {player}
              {docked && (
                <div className="flex items-center gap-2 px-3 py-2 text-white">
                  <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">{v.title}</p>
                  <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label={t('watch.backToVideo')} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-white/10"><Icon.ChevronUp size={18} /></button>
                  <button type="button" onClick={() => setDismissed(true)} aria-label={t('watch.closeMini')} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-white/10"><Icon.Close size={18} /></button>
                </div>
              )}
              {countdown !== null && next && (
                <div className="absolute inset-0 z-20 grid place-items-center bg-[rgb(5_10_10/0.82)] p-4 text-white backdrop-blur-sm sm:rounded-[24px]">
                  <div className="w-full max-w-[420px]">
                    <p className="text-[13px] font-semibold text-[#f5b95c]" aria-live="polite">Next in {countdown} s</p>
                    <Link href={`/watch?v=${next.id}`} className="mt-2 flex items-center gap-3">
                      <span className="relative block w-[42%] shrink-0 overflow-hidden rounded-xl">
                        {next.thumbnailUrl ? <img src={next.thumbnailUrl} alt="" className="aspect-video w-full object-cover" /> : <span className="block aspect-video w-full bg-white/10" />}
                        <svg viewBox="0 0 36 36" className="absolute right-1.5 top-1.5 h-7 w-7 -rotate-90" aria-hidden><circle cx="18" cy="18" r="15" fill="rgb(0 0 0/0.5)" stroke="rgb(255 255 255/0.25)" strokeWidth="3" /><circle cx="18" cy="18" r="15" fill="none" stroke="#f5b95c" strokeWidth="3" strokeDasharray="94.2" strokeDashoffset={94.2 * (countdown / 8)} className="transition-[stroke-dashoffset] duration-1000 ease-linear" /></svg>
                      </span>
                      <span className="min-w-0"><span className="line-clamp-2 text-[15px] font-bold leading-tight sm:text-[17px]">{next.title}</span><span className="mt-1 block truncate text-[12px] text-[#9fb0ad]">{next.channel.name}</span></span>
                    </Link>
                    <div className="mt-4 flex gap-2">
                      <button type="button" onClick={() => setCountdown(null)} className="h-10 flex-1 rounded-xl bg-white/10 text-[14px] font-semibold hover:bg-white/15">{t('watch.stayHere')}</button>
                      <Link href={`/watch?v=${next.id}`} className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#2bb5ab] text-[14px] font-semibold text-[#04201e]"><Icon.Play size={18} />{t('watch.playNow')}</Link>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* Tablets and computers: title, numbers and the creator under the video; small actions beside the title. */}
          <div className="hidden items-start gap-6 pt-5 text-white sm:flex">
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] font-extrabold leading-[1.15] lg:text-[32px]">{v.title}</h1>
              {v.qualityLimit ? <p className="mt-1 text-[12px] text-[#9fb0ad]">Up to {v.qualityLimit}p · <Link href="/plans" className="font-semibold text-[#2bb5ab] hover:underline">every quality and no ads with Plus</Link></p> : null}
              <p className="mt-1.5 text-[14px] text-[#9fb0ad]" suppressHydrationWarning>
                {viewsLabel(v.viewCount, locale)} · {v.publishedAt ? timeAgo(v.publishedAt, locale) : t('watch.notPublished')}
                {v.category && <> · <Link href={`/explore?topic=${v.category.slug}`} className="font-semibold text-[#2bb5ab] hover:underline">{v.category.name}</Link></>}
              </p>
              <div className="dark mt-3.5 flex flex-wrap items-center gap-3">
                <Link href={`/@${v.channel.handle}`} className="flex min-w-0 items-center gap-3">
                  <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={44} />
                  <span className="min-w-0"><span className="flex items-center gap-1 truncate font-display text-[16px] font-bold text-white">{v.channel.name}{v.channel.isVerified && <VerifiedBadge size={15} kind={v.channel.badge} />}</span><span className="block text-[13px] text-[#9fb0ad]" suppressHydrationWarning>{followersLabel(v.channel.followerCount, locale)}</span></span>
                </Link>
                {initialViewer.isOwner
                  ? <Link href="/hub" className="flex h-10 items-center gap-2 rounded-xl bg-white/[0.08] px-4 text-[14px] font-semibold hover:bg-white/[0.14]"><Icon.Hub size={17} />{t('watch.creatorHub')}</Link>
                  : <FollowButton handle={v.channel.handle} initial={initialViewer.following} initialCount={v.channel.followerCount} />}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-1.5">
              {/* Spark and Pass along, small, side by side. */}
              <div className="flex h-10 overflow-hidden rounded-[14px] border border-[#2bb5ab]/45 bg-white/[0.04] text-[14px] font-semibold">
                <button type="button" onClick={() => react('like')} aria-pressed={reaction === 'like'} aria-label={`Spark (${likes})`} className={`flex items-center gap-1.5 px-3.5 transition-colors hover:bg-white/[0.08] ${reaction === 'like' ? 'bg-[#f5b95c]/15 text-[#f5b95c]' : ''}`}>
                  <Icon.Spark size={17} filled={reaction === 'like'} className="text-[#f5b95c]" /><span suppressHydrationWarning>{likes > 0 ? compactNumber(likes, locale) : t('watch.spark')}</span>
                </button>
                <button type="button" onClick={share} className="flex items-center gap-1.5 border-l border-[#2bb5ab]/30 px-3.5 transition-colors hover:bg-white/[0.08]"><Icon.PassAlong size={17} />{copied ? t('live.linkCopied') : t('watch.passAlong')}</button>
              </div>
              <button type="button" onClick={() => need('save')} aria-pressed={saved} className={`flex h-10 items-center gap-1.5 rounded-[14px] border border-[#2bb5ab]/45 bg-white/[0.04] px-3.5 text-[14px] font-semibold transition-colors hover:bg-white/[0.08] ${saved ? 'bg-[#2bb5ab]/15' : ''}`}><Icon.Bookmark size={16} filled={saved} />{saved ? 'Kept' : 'Keep'}</button>
              <div className="relative">
                <button type="button" onClick={() => setMenu((m) => !m)} aria-label={t('watch.moreActions')} aria-haspopup="menu" aria-expanded={menu} className="grid h-10 w-10 place-items-center rounded-[14px] border border-[#2bb5ab]/45 bg-white/[0.04] transition-colors hover:bg-white/[0.08]"><Icon.More size={18} /></button>
                {menu && <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-[240px] rounded-2xl border border-line bg-elevated p-1.5 text-ink shadow-[var(--shadow)]">{menuItems}</div>}
              </div>
            </div>
          </div>
          </div>
          {/* Wide screens, left of the video: what comes next, and the conversation, as two matching cards. */}
          {!theater && (
            <aside aria-label={t('watch.upNext')} className="relative order-first hidden w-[360px] shrink-0 xl:block">
              <div className="absolute inset-0 flex flex-col gap-5">
                {more.length > 0 && (
                  <div className="flex max-h-[44%] min-h-0 shrink-0 flex-col rounded-[24px] bg-white/[0.04] shadow-[0_0_0_1px_rgb(43_181_171/0.3),0_0_28px_rgb(43_181_171/0.12)]">
                    <div className="flex items-center justify-between px-5 pt-5 text-white">
                      <h2 className="flex items-center gap-2 text-[20px] font-extrabold uppercase tracking-wide text-[#2bb5ab]">{t('watch.upNext')}<span className="grid h-6 w-6 place-items-center rounded-md bg-[#2bb5ab] text-[#04201e]"><Icon.Play size={14} /></span></h2>
                      <button type="button" role="switch" aria-checked={flow} onClick={toggleFlow} className="flex items-center gap-2 text-[12px] font-semibold text-[#9fb0ad]">
                        Flow on
                        <span className={`relative h-5 w-9 rounded-full transition-colors ${flow ? 'bg-[#2bb5ab]' : 'bg-white/20'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${flow ? 'left-[18px]' : 'left-0.5'}`} /></span>
                      </button>
                    </div>
                    <div className="imigongo mx-5 mb-2 mt-3" aria-hidden />
                    <div className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
                  {more.slice(0, 10).map((x, i) => (
                    <Link key={x.id} href={`/watch?v=${x.id}`} className="group flex gap-3 rounded-2xl p-2 hover:bg-white/[0.06]">
                      <span className="relative block w-[148px] shrink-0 overflow-hidden rounded-xl shadow-[0_0_0_1px_rgb(43_181_171/0.35)]">
                        {x.thumbnailUrl ? <img src={x.thumbnailUrl} alt="" loading="lazy" className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" /> : <span className="block aspect-video w-full bg-white/10" />}
                        {x.durationSeconds ? <span className="absolute bottom-1.5 right-1.5 rounded-md bg-[#2bb5ab] px-1.5 text-[11px] font-bold text-[#04201e]">{duration(x.durationSeconds)}</span> : null}
                        {i === 0 && flow && <span className="absolute left-1 top-1 rounded-md bg-[#f5b95c] px-1.5 text-[10px] font-bold uppercase tracking-wide text-[#2a1a00]">{t('watch.upFirst')}</span>}
                      </span>
                      <span className="min-w-0 self-center">
                        <span className="line-clamp-2 text-[14px] font-bold leading-snug text-white">{x.title}</span>
                        <span className="mt-1 block truncate text-[12px] text-[#9fb0ad]">{x.channel.name}</span>
                        <span className="block text-[12px] text-[#9fb0ad]" suppressHydrationWarning>{viewsLabel(x.viewCount, locale)} · {timeAgo(x.publishedAt, locale)}</span>
                      </span>
                    </Link>
                  ))}
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 rounded-[24px] bg-white/[0.04] p-5 shadow-[0_0_0_1px_rgb(43_181_171/0.3),0_0_28px_rgb(43_181_171/0.12)]">
                  <Comments videoId={v.id} initialCount={v.commentCount} variant="card" />
                </div>
              </div>
            </aside>
          )}
        </div>
        {/* Phones: More opens as a sheet at the bottom. */}
        {menu && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
            <div role="menu" className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-line bg-elevated p-1.5 shadow-[var(--shadow)] sm:hidden">{menuItems}</div>
          </>
        )}
      </section>
      {error && <p role="alert" className="mx-auto mt-10 max-w-[1120px] px-4 text-[13px] text-danger">{error}</p>}

      {/* Phones: dark like the stage — title, outlined actions, the Space, Conversation and an Up next list. */}
      <div className="min-h-[calc(100dvh-56.25vw)] bg-stage pb-36 text-white sm:hidden">
        <div className="px-4 pt-3.5">
          <button type="button" onClick={() => openSheet('about')} className="block w-full text-left">
            <h1 className="line-clamp-2 text-[18px] font-extrabold leading-[1.25]">{v.title}</h1>
            <p className="mt-1 text-[12px] text-[#9fb0ad]" suppressHydrationWarning>
              {viewsLabel(v.viewCount, locale)} · {v.publishedAt ? timeAgo(v.publishedAt, locale) : t('watch.notPublished')}{v.category ? <> · <span className="text-[#2bb5ab]">#{v.category.name.replace(/\s+/g, '')}</span></> : null} <span className="font-semibold text-white">…more</span>
            </p>
          </button>
          {v.qualityLimit ? <p className="mt-1 text-[12px] text-[#9fb0ad]">Up to {v.qualityLimit}p · <Link href="/plans" className="font-semibold text-[#2bb5ab] hover:underline">every quality and no ads with Plus</Link></p> : null}
        </div>
        <div className="no-scrollbar mt-3.5 flex gap-2 overflow-x-auto px-4">
          <button type="button" onClick={() => react('like')} aria-pressed={reaction === 'like'} aria-label={`Spark (${likes})`}
            className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-[14px] font-bold shadow-[0_0_14px_rgb(43_181_171/0.2)] ${reaction === 'like' ? 'border-[#f5b95c] bg-[#f5b95c]/15 text-[#f5b95c]' : 'border-[#2bb5ab] text-[#2bb5ab]'}`}>
            <Icon.Spark size={18} filled={reaction === 'like'} /><span suppressHydrationWarning>{likes > 0 ? compactNumber(likes, locale) : t('watch.spark')}</span>
          </button>
          <button type="button" onClick={share} className={phonePill}><Icon.PassAlong size={18} />{copied ? t('watch.copied') : t('watch.passAlong')}</button>
          <button type="button" onClick={() => need('save')} aria-pressed={saved} className={`${phonePill} ${saved ? 'border-[#2bb5ab] text-[#2bb5ab]' : ''}`}><Icon.Bookmark size={18} filled={saved} />{saved ? 'Kept' : 'Keep'}</button>
          {!initialViewer.isOwner && <button type="button" onClick={() => react('dislike')} aria-pressed={reaction === 'dislike'} aria-label={t('watch.notForMe')} className={`${phoneIcon} ${reaction === 'dislike' ? 'border-[#2bb5ab] text-[#2bb5ab]' : ''}`}><Icon.NotForMe size={18} filled={reaction === 'dislike'} /></button>}
          <button type="button" onClick={() => setMenu(true)} aria-label={t('watch.moreActions')} className={phoneIcon}><Icon.More size={18} /></button>
        </div>
        <div className="mx-4 mt-4 flex items-center gap-3">
          <Link href={`/@${v.channel.handle}`} className="flex min-w-0 flex-1 items-center gap-2.5">
            <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={36} />
            <span className="min-w-0"><span className="flex items-center gap-1 truncate text-[14px] font-semibold">{v.channel.name}{v.channel.isVerified && <VerifiedBadge size={14} kind={v.channel.badge} />}</span><span className="block text-[12px] text-[#9fb0ad]" suppressHydrationWarning>{followersLabel(v.channel.followerCount, locale)}</span></span>
          </Link>
          {initialViewer.isOwner
            ? <Link href="/hub" className="flex h-9 shrink-0 items-center rounded-full border border-white/25 px-4 text-[13px] font-semibold">{t('watch.creatorHub')}</Link>
            : <FollowButton pill handle={v.channel.handle} initial={initialViewer.following} initialCount={v.channel.followerCount} />}
        </div>
        <button type="button" onClick={() => openSheet('conversation')} className="mx-4 mt-4 block w-[calc(100%-2rem)] rounded-2xl bg-white/[0.06] px-3.5 py-3 text-left ring-1 ring-white/10">
          <p className="text-[14px] font-bold">{t('watch.conversation')} <span className="font-normal text-[#9fb0ad]" suppressHydrationWarning>{v.commentsOpen ? compactNumber(v.commentCount, locale) : ''}</span></p>
          {!v.commentsOpen ? <p className="mt-1.5 text-[13px] text-[#9fb0ad]">{t('watch.closed')}</p>
            : firstComment?.author ? (
              <span className="mt-2 flex items-center gap-2.5"><Avatar name={firstComment.author.name} src={firstComment.author.avatarUrl} size={24} /><span className="line-clamp-2 text-[13px] text-white/90">{firstComment.content}</span></span>
            ) : <span className="mt-2 flex items-center gap-2.5"><Icon.PersonCircle size={24} className="text-[#9fb0ad]" /><span className="flex-1 rounded-full bg-white/[0.08] px-3 py-1.5 text-[13px] text-[#9fb0ad]">{t('watch.start')}</span></span>}
        </button>
        {more.length > 0 && (
          <section className="mt-6 px-4">
            <div className="flex items-center justify-between pb-3">
              <h2 className="text-[20px] font-extrabold">{t('watch.upNext1')} <span className="text-[#2bb5ab]">{t('watch.upNext2')}</span></h2>
              <button type="button" role="switch" aria-checked={flow} onClick={toggleFlow} className="flex items-center gap-2 text-[12px] font-semibold text-[#9fb0ad]">{t('watch.flowOn')}<span className={`relative h-5 w-9 rounded-full transition-colors ${flow ? 'bg-[#2bb5ab]' : 'bg-white/20'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${flow ? 'left-[18px]' : 'left-0.5'}`} /></span></button>
            </div>
            <div className="grid gap-4">
              {more.map((x, i) => (
                <Link key={x.id} href={`/watch?v=${x.id}`} className="flex gap-3">
                  <span className="relative block w-[44%] max-w-[180px] shrink-0 overflow-hidden rounded-xl shadow-[0_0_0_1px_rgb(43_181_171/0.35)]">
                    {x.thumbnailUrl ? <img src={x.thumbnailUrl} alt="" loading="lazy" className="aspect-video w-full object-cover" /> : <span className="block aspect-video w-full bg-white/10" />}
                    {x.durationSeconds ? <span className="absolute bottom-1.5 right-1.5 rounded-md bg-[#2bb5ab] px-1.5 text-[11px] font-bold text-[#04201e]">{duration(x.durationSeconds)}</span> : null}
                    {i === 0 && flow && <span className="absolute left-1.5 top-1.5 rounded-md bg-[#f5b95c] px-1.5 text-[10px] font-bold uppercase tracking-wide text-[#2a1a00]">{t('watch.upFirst')}</span>}
                  </span>
                  <span className="min-w-0 self-center">
                    <span className="line-clamp-2 text-[14px] font-bold leading-snug">{x.title}</span>
                    <span className="mt-1 line-clamp-2 text-[12px] text-[#9fb0ad]" suppressHydrationWarning>{x.channel.name} · {viewsLabel(x.viewCount, locale)} · {timeAgo(x.publishedAt, locale)}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
      {/* Phones: About and Conversation open as panels under the video, as in video apps. */}
      {sheet && (
        <div role="dialog" aria-modal="true" aria-label={sheet === 'about' ? t('watch.about') : t('watch.conversation')} className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(100dvh-56.25vw)] flex-col rounded-t-[22px] bg-elevated shadow-[0_-12px_32px_rgb(0_0_0/0.18)] sm:hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-[16px] font-bold">{sheet === 'about' ? t('watch.about') : t('watch.conversation')}</p>
            <button type="button" onClick={() => setSheet(null)} aria-label={t('watch.close')} className="grid h-9 w-9 place-items-center rounded-full hover:bg-surface"><Icon.Close size={20} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {sheet === 'about' ? (
              <div className="py-4">
                <h2 className="text-[18px] font-bold leading-tight">{v.title}</h2>
                <div className="mt-4 grid grid-cols-3 text-center">
                  <div><p className="text-[17px] font-bold" suppressHydrationWarning>{compactNumber(likes, locale)}</p><p className="text-[12px] text-muted">{t('watch.sparks')}</p></div>
                  <div><p className="text-[17px] font-bold" suppressHydrationWarning>{compactNumber(v.viewCount, locale)}</p><p className="text-[12px] text-muted">{t('watch.views')}</p></div>
                  <div><p className="text-[17px] font-bold" suppressHydrationWarning>{v.publishedAt ? fullDate(v.publishedAt, locale) : '—'}</p><p className="text-[12px] text-muted">{t('watch.published')}</p></div>
                </div>
                {v.category && <Link href={`/explore?topic=${v.category.slug}`} className="mt-4 inline-flex rounded-full bg-surface px-3 py-1 text-[13px] font-semibold text-brand">#{v.category.name.replace(/\s+/g, '')}</Link>}
                <p className="mt-4 whitespace-pre-line break-words rounded-2xl bg-surface p-3.5 text-[14px] leading-relaxed">{v.description || <span className="text-muted">{t('watch.noDescription')}</span>}</p>
                <Link href={`/@${v.channel.handle}`} className="mt-4 flex items-center gap-3"><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={40} /><span><span className="block text-[15px] font-semibold">{v.channel.name}</span><span className="text-[12px] text-muted" suppressHydrationWarning>{followersLabel(v.channel.followerCount, locale)}</span></span></Link>
              </div>
            ) : <Comments videoId={v.id} initialCount={v.commentCount} />}
          </div>
        </div>
      )}
      {/* Under the stage: about, the conversation (beside the video on wide screens) and more to watch. The creator is under the title. */}
      <div className="mx-auto hidden max-w-[1280px] px-4 sm:mt-8 sm:block sm:px-6">
        <div className="min-w-0">
          <div role="tablist" className="flex gap-1 border-b border-line">
            {tabBtn('about', t('watch.about'))}<span className={theater ? 'contents' : 'contents xl:hidden'}>{tabBtn('conversation', v.commentsOpen ? `${t('watch.conversation')} · ${compactNumber(v.commentCount, locale)}` : t('watch.conversation'))}</span>{more.length > 0 && tabBtn('next', t('watch.keepWatching'))}
          </div>
          {tab === 'about' && (
            <div className="py-5 text-[15px] leading-relaxed">
              <p className="font-semibold">{meta}{v.publishedAt && <span className="font-normal text-muted"> · {fullDate(v.publishedAt, locale)}</span>}</p>
              <p className="mt-2 whitespace-pre-line break-words">{v.description || <span className="text-muted">{t('watch.noDescription')}</span>}</p>
            </div>
          )}
          {tab === 'conversation' && <div className={theater ? '' : 'xl:hidden'}><Comments videoId={v.id} initialCount={v.commentCount} /></div>}
          {tab === 'next' && <div className="grid gap-4 py-5">{more.map((x) => <VideoRow key={x.id} v={x} locale={locale} large />)}</div>}
          {tab !== 'next' && more.length > 0 && (
            <section className="mt-10">
              <h2 className="flex items-center gap-3 text-[18px] font-bold"><span className="flex-1">{t('watch.keepWatching')}</span>
                <button type="button" role="switch" aria-checked={flow} onClick={toggleFlow} className="hidden items-center gap-2 font-sans text-[12px] font-semibold text-muted sm:flex xl:hidden">{t('watch.flowOn')}<span className={`relative h-5 w-9 rounded-full transition-colors ${flow ? 'bg-brand' : 'bg-line'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${flow ? 'left-[18px]' : 'left-0.5'}`} /></span></button>
                <button type="button" onClick={() => setTab('next')} className="font-sans text-[13px] font-semibold text-brand">{t('watch.seeAll')}</button></h2>
              <div className="no-scrollbar -mx-4 mt-3 flex gap-4 overflow-x-auto px-4 pb-2">
                {more.slice(0, 8).map((x) => (
                  <Link key={x.id} href={`/watch?v=${x.id}`} className="group w-[220px] shrink-0">
                    <Thumbnail v={x} rounded="rounded-[16px]" />
                    <p className="mt-2 line-clamp-2 text-[14px] font-semibold leading-tight">{x.title}</p>
                    <p className="text-[12px] text-muted">{x.channel.name}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {initialViewer.signedIn && (
        <>
          <SaveDialog videoId={v.id} open={dialog === 'save'} onClose={() => setDialog(null)} onSavedChange={setSaved} />
          <ReportDialog videoId={v.id} open={dialog === 'report'} onClose={() => setDialog(null)} currentTime={() => time.current} />
        </>
      )}
    </div>
  );
}
