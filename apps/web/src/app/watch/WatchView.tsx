'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { FollowButton } from '@/components/FollowButton';
import { Comments } from '@/components/engagement/Comments';
import { ReportDialog } from '@/components/engagement/ReportDialog';
import { SaveDialog } from '@/components/engagement/SaveDialog';
import { VideoPlayer } from '@/components/player/VideoPlayer';
import { useShell } from '@/components/shell/ShellContext';
import { Thumbnail, VideoRow } from '@/components/video/VideoCard';
import { api } from '@/lib/client-api';
import { compactNumber, followersLabel, fullDate, timeAgo, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';

export interface WatchVideo extends VideoCardData {
  description: string | null; status: string; visibility: string; likeCount: number; commentCount: number; commentsOpen: boolean; playbackUrl: string | null; processingStage: string | null;
  takenDownAt: string | null; category: { name: string; slug: string } | null; channel: VideoCardData['channel'] & { followerCount: number };
}
export interface WatchViewer { signedIn: boolean; isOwner: boolean; following: boolean; saved: boolean; reaction: 'like' | 'dislike' | 'none'; resumeAt: number }


export function WatchView({ v, more, viewer: initialViewer }: { v: WatchVideo; more: VideoCardData[]; viewer: WatchViewer }) {
  const { locale } = useShell();
  const router = useRouter();
  const [theater, setTheater] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reaction, setReaction] = useState(initialViewer.reaction);
  const [likes, setLikes] = useState(v.likeCount);
  const [saved, setSaved] = useState(initialViewer.saved);
  const [dialog, setDialog] = useState<null | 'save' | 'report'>(null);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const time = useRef(0);
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
    try { const r = await api<{ likeCount: number }>(`/videos/${v.id}/reaction`, { method: 'PUT', body: { value: next } }); setLikes(r.likeCount); }
    catch (e) { setReaction(before.reaction); setLikes(before.likes); setError((e as Error).message); }
  };
  const progress = useCallback((seconds: number, ended: boolean) => {
    time.current = seconds;
    if (!initialViewer.signedIn) return;
    fetch(`/api/videos/${v.id}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds, ended }), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
  }, [v.id, initialViewer.signedIn]);
  const need = (what: 'save' | 'report') => { setMenu(false); if (!initialViewer.signedIn) router.push(login); else setDialog(what); };
  const [tab, setTab] = useState<'about' | 'conversation' | 'next'>('conversation');

  const player = v.playbackUrl
    ? <VideoPlayer key={v.id} src={v.playbackUrl} poster={v.thumbnailUrl} videoId={v.id} durationHint={v.durationSeconds} theater={theater} onTheater={toggleTheater} startAt={initialViewer.resumeAt} onProgress={progress} />
    : <div className="grid aspect-video w-full place-items-center rounded-[24px] bg-[#0b1413] text-center text-[15px] text-[#9fb0ad]"><div><Icon.Spinner className="mx-auto mb-3 animate-spin" />{v.takenDownAt ? 'This video was removed. See Creator Hub for details.' : v.processingStage ?? 'This video is still being processed.'}</div></div>;

  const dockBtn = 'flex h-10 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[14px] font-semibold';
  const meta = <span suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {v.publishedAt ? timeAgo(v.publishedAt, locale) : 'Not published'}</span>;
  const tabBtn = (k: typeof tab, label: string) => <button type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3.5 py-2.5 text-[14px] font-semibold ${tab === k ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink'}`}>{label}</button>;

  return (
    <div>
      {/* Stage: the video on a dark band, lit softly by the brand colour. */}
      {/* Phones: the video sticks to the top, edge to edge, while the page scrolls under it. */}
      <section className="sticky top-0 z-30 bg-stage sm:relative sm:z-auto sm:px-6 sm:pb-9 sm:pt-3" style={{ backgroundImage: 'radial-gradient(ellipse at 50% 35%, rgb(12 130 126 / 0.32), transparent 62%)' }}>
        <div className={`mx-auto transition-[max-width] duration-300 ${theater ? 'sm:max-w-[min(1800px,calc((100dvh-6rem)*16/9))]' : 'sm:max-w-[min(1280px,calc((100dvh-8.5rem)*16/9))]'}`}>{player}</div>
        {/* Action dock: floats over the bottom edge of the stage. */}
        <div className="absolute bottom-0 left-1/2 hidden max-w-[calc(100%-1.5rem)] -translate-x-1/2 translate-y-1/2 items-center sm:flex gap-1.5 overflow-x-auto rounded-[18px] border border-line bg-elevated p-1.5 shadow-[var(--shadow)] no-scrollbar">
          <button type="button" onClick={() => react('like')} aria-pressed={reaction === 'like'} aria-label={`Spark (${likes})`} className={`${dockBtn} ${reaction === 'like' ? 'bg-accent-soft text-on-accent-soft' : 'hover:bg-surface'}`}>
            <Icon.Spark size={20} filled={reaction === 'like'} className={reaction === 'like' ? 'text-accent' : ''} />Spark<span suppressHydrationWarning>{likes > 0 ? ` · ${compactNumber(likes, locale)}` : ''}</span>
          </button>
          <button type="button" onClick={() => need('save')} aria-pressed={saved} className={`${dockBtn} ${saved ? 'bg-brand-soft text-brand' : 'hover:bg-surface'}`}><Icon.Bookmark size={20} filled={saved} />{saved ? 'Kept' : 'Keep'}</button>
          <button type="button" onClick={share} className={`${dockBtn} hover:bg-surface`}><Icon.PassAlong size={20} />{copied ? 'Link copied' : 'Pass along'}</button>
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMenu((m) => !m)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} className="grid h-10 w-10 place-items-center rounded-xl hover:bg-surface"><Icon.More size={20} /></button>
          </div>
        </div>
        {menu && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
            <div role="menu" className="fixed inset-x-3 bottom-3 z-40 rounded-2xl sm:absolute sm:inset-x-auto sm:bottom-0 sm:left-1/2 sm:w-[240px] sm:translate-x-[60px] sm:translate-y-[calc(100%+30px)] border border-line bg-elevated p-1.5 shadow-[var(--shadow)]">
              {!initialViewer.isOwner && <button type="button" role="menuitemcheckbox" aria-checked={reaction === 'dislike'} onClick={() => { setMenu(false); void react('dislike'); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.NotForMe size={20} filled={reaction === 'dislike'} /><span className="flex-1 text-left">Not for me</span><span className="text-[11px] text-muted">private</span></button>}
              {!initialViewer.isOwner && <button type="button" role="menuitem" onClick={() => need('report')} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.Flag size={20} />Report</button>}
              {!initialViewer.isOwner && <Link role="menuitem" href={`/legal/copyright/notice?v=${v.id}`} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.Copyright size={20} />Copyright notice</Link>}
              <Link role="menuitem" href="/trail" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] hover:bg-surface"><Icon.Trail size={20} />Your Trail</Link>
            </div>
          </>
        )}
      </section>
      {error && <p role="alert" className="mx-auto mt-10 max-w-[1120px] px-4 text-[13px] text-danger">{error}</p>}

      <div className="mx-auto mt-4 grid max-w-[1280px] gap-8 px-4 sm:mt-12 sm:px-6 lg:grid-cols-[300px_1fr]">
        <aside className="hidden h-fit rounded-[20px] border border-line bg-elevated p-4 sm:block lg:sticky lg:top-20">
          <Link href={`/@${v.channel.handle}`} className="flex items-center gap-3">
            <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={52} />
            <div className="min-w-0"><p className="flex items-center gap-1 truncate font-display text-[17px] font-bold">{v.channel.name}{v.channel.isVerified && <Icon.Verified size={15} aria-label="Verified" className="text-brand" />}</p><p className="text-[13px] text-muted" suppressHydrationWarning>@{v.channel.handle} · {followersLabel(v.channel.followerCount, locale)}</p></div>
          </Link>
          <div className="mt-4 [&>div]:w-full [&_button]:w-full [&_button]:justify-center">
            {initialViewer.isOwner
              ? <Link href="/hub" className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-surface text-[14px] font-semibold hover:bg-surface-hover"><Icon.Hub size={18} />Creator Hub</Link>
              : <FollowButton handle={v.channel.handle} initial={initialViewer.following} initialCount={v.channel.followerCount} />}
          </div>
        </aside>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-brand">{v.category ? <><Link href={`/explore?topic=${v.category.slug}`} className="hover:underline">{v.category.name}</Link> · </> : null}{meta}</p>
          <h1 className="mt-1 text-[19px] font-extrabold leading-[1.2] sm:mt-1.5 sm:text-[32px] sm:leading-[1.15]">{v.title}</h1>
          {/* Phones: creator row and a scrolling row of actions, under the title. */}
          <div className="mt-3 flex items-center gap-3 sm:hidden">
            <Link href={`/@${v.channel.handle}`} className="flex min-w-0 flex-1 items-center gap-2.5">
              <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={38} />
              <div className="min-w-0"><p className="truncate text-[15px] font-semibold">{v.channel.name}</p><p className="text-[12px] text-muted" suppressHydrationWarning>{followersLabel(v.channel.followerCount, locale)}</p></div>
            </Link>
            {initialViewer.isOwner
              ? <Link href="/hub" className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-surface px-3 text-[13px] font-semibold"><Icon.Hub size={16} />Hub</Link>
              : <FollowButton handle={v.channel.handle} initial={initialViewer.following} initialCount={v.channel.followerCount} />}
          </div>
          <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 sm:hidden">
            <button type="button" onClick={() => react('like')} aria-pressed={reaction === 'like'} className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold ${reaction === 'like' ? 'bg-accent-soft text-on-accent-soft' : 'bg-surface'}`}><Icon.Spark size={17} filled={reaction === 'like'} className={reaction === 'like' ? 'text-accent' : ''} /><span suppressHydrationWarning>{likes > 0 ? compactNumber(likes, locale) : 'Spark'}</span></button>
            {!initialViewer.isOwner && <button type="button" onClick={() => react('dislike')} aria-pressed={reaction === 'dislike'} aria-label="Not for me" className={`flex h-9 shrink-0 items-center rounded-xl px-3 ${reaction === 'dislike' ? 'bg-brand-soft text-brand' : 'bg-surface'}`}><Icon.NotForMe size={17} filled={reaction === 'dislike'} /></button>}
            <button type="button" onClick={() => need('save')} aria-pressed={saved} className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold ${saved ? 'bg-brand-soft text-brand' : 'bg-surface'}`}><Icon.Bookmark size={17} filled={saved} />{saved ? 'Kept' : 'Keep'}</button>
            <button type="button" onClick={share} className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-surface px-3 text-[13px] font-semibold"><Icon.PassAlong size={17} />{copied ? 'Copied' : 'Pass along'}</button>
            <button type="button" onClick={() => setMenu(true)} aria-label="More actions" className="flex h-9 shrink-0 items-center rounded-xl bg-surface px-3"><Icon.More size={17} /></button>
          </div>
          <div role="tablist" className="mt-5 flex gap-1 border-b border-line">
            {tabBtn('about', 'About')}{tabBtn('conversation', v.commentsOpen ? `Conversation · ${compactNumber(v.commentCount, locale)}` : 'Conversation')}{more.length > 0 && tabBtn('next', 'Keep watching')}
          </div>
          {tab === 'about' && (
            <div className="py-5 text-[15px] leading-relaxed">
              <p className="font-semibold">{meta}{v.publishedAt && <span className="font-normal text-muted"> · {fullDate(v.publishedAt, locale)}</span>}</p>
              <p className="mt-2 whitespace-pre-line break-words">{v.description || <span className="text-muted">No description.</span>}</p>
            </div>
          )}
          {tab === 'conversation' && <Comments videoId={v.id} initialCount={v.commentCount} />}
          {tab === 'next' && <div className="grid gap-4 py-5">{more.map((x) => <VideoRow key={x.id} v={x} locale={locale} large />)}</div>}
          {tab !== 'next' && more.length > 0 && (
            <section className="mt-10">
              <h2 className="flex items-baseline justify-between text-[18px] font-bold">Keep watching<button type="button" onClick={() => setTab('next')} className="font-sans text-[13px] font-semibold text-brand">See all</button></h2>
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
