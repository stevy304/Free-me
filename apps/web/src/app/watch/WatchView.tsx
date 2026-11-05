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
import { VideoRow } from '@/components/video/VideoCard';
import { api } from '@/lib/client-api';
import { compactNumber, followersLabel, fullDate, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';

export interface WatchVideo extends VideoCardData {
  description: string | null; status: string; visibility: string; likeCount: number; commentCount: number; commentsOpen: boolean; playbackUrl: string | null; processingStage: string | null;
  takenDownAt: string | null; category: { name: string; slug: string } | null; channel: VideoCardData['channel'] & { followerCount: number };
}
export interface WatchViewer { signedIn: boolean; isOwner: boolean; following: boolean; saved: boolean; reaction: 'like' | 'dislike' | 'none'; resumeAt: number }

const pill = 'flex h-9 items-center gap-2 rounded-full bg-surface px-4 text-[14px] font-medium hover:bg-surface-hover';

export function WatchView({ v, more, viewer: initialViewer }: { v: WatchVideo; more: VideoCardData[]; viewer: WatchViewer }) {
  const { locale } = useShell();
  const router = useRouter();
  const [theater, setTheater] = useState(false);
  const [expanded, setExpanded] = useState(false);
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

  const player = v.playbackUrl
    ? <VideoPlayer key={v.id} src={v.playbackUrl} poster={v.thumbnailUrl} videoId={v.id} durationHint={v.durationSeconds} theater={theater} onTheater={toggleTheater} startAt={initialViewer.resumeAt} onProgress={progress} />
    : <div className="grid aspect-video w-full place-items-center rounded-xl bg-surface text-center text-[15px] text-muted"><div><Icon.Spinner className="mx-auto mb-3 animate-spin" />{v.takenDownAt ? 'This video was removed. See Creator Hub for details.' : v.processingStage ?? 'This video is still being processed.'}</div></div>;

  const details = (
    <>
      <h1 className="mt-3 text-[20px] font-bold leading-7">{v.title}</h1>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href={`/@${v.channel.handle}`} className="shrink-0"><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={40} /></Link>
          <div className="mr-2 min-w-0"><Link href={`/@${v.channel.handle}`} className="flex items-center gap-1 truncate text-[16px] font-semibold">{v.channel.name}{v.channel.isVerified && <Icon.Verified size={14} aria-label="Verified" />}</Link><p className="text-[12px] text-muted" suppressHydrationWarning>{followersLabel(v.channel.followerCount, locale)}</p></div>
          {initialViewer.isOwner
            ? <Link href="/hub" className={pill}><Icon.Hub size={18} />Creator Hub</Link>
            : <FollowButton handle={v.channel.handle} initial={initialViewer.following} initialCount={v.channel.followerCount} />}
        </div>
        <div className="no-scrollbar -mx-1 flex max-w-full items-center gap-2 overflow-x-auto px-1">
          <div className="flex h-9 shrink-0 items-center rounded-full bg-surface text-[14px] font-medium">
            <button type="button" onClick={() => react('like')} aria-pressed={reaction === 'like'} aria-label={`Like (${likes})`} className="flex h-full items-center gap-2 rounded-l-full pl-4 pr-3 hover:bg-surface-hover">
              <Icon.ThumbUp size={20} filled={reaction === 'like'} /><span suppressHydrationWarning>{likes > 0 ? compactNumber(likes, locale) : 'Like'}</span>
            </button>
            <span className="h-6 w-px bg-line" />
            <button type="button" onClick={() => react('dislike')} aria-pressed={reaction === 'dislike'} aria-label="Dislike" title="Only the creator sees dislikes" className="flex h-full items-center rounded-r-full pl-3 pr-4 hover:bg-surface-hover">
              <Icon.ThumbDown size={20} filled={reaction === 'dislike'} />
            </button>
          </div>
          <button type="button" onClick={share} className={`${pill} shrink-0`}><Icon.Share size={20} />{copied ? 'Link copied' : 'Share'}</button>
          <button type="button" onClick={() => need('save')} aria-pressed={saved} className={`${pill} shrink-0`}><Icon.Bookmark size={20} filled={saved} />{saved ? 'Saved' : 'Save'}</button>
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMenu((m) => !m)} aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} className="grid h-9 w-9 place-items-center rounded-full bg-surface hover:bg-surface-hover"><Icon.More size={20} /></button>
            {menu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                <div role="menu" className="absolute right-0 top-11 z-40 min-w-[220px] rounded-xl bg-elevated py-2 shadow-[var(--shadow)]">
                  {!initialViewer.isOwner && <button type="button" role="menuitem" onClick={() => need('report')} className="flex w-full items-center gap-3 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Flag size={20} />Report</button>}
                  {!initialViewer.isOwner && <Link role="menuitem" href={`/legal/copyright/notice?v=${v.id}`} className="flex w-full items-center gap-3 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Copyright size={20} />Copyright notice</Link>}
                  <Link role="menuitem" href="/history" className="flex w-full items-center gap-3 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.History size={20} />Your history</Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
      <div className={`mt-4 rounded-xl bg-surface p-3 text-[14px] ${expanded ? '' : 'cursor-pointer hover:bg-surface-hover'}`} onClick={() => !expanded && setExpanded(true)}>
        <p className="font-semibold" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {v.publishedAt ? fullDate(v.publishedAt, locale) : 'Not published'}{v.category && <> · <Link href={`/?category=${v.category.slug}`} className="text-brand" onClick={(e) => e.stopPropagation()}>{v.category.name}</Link></>}</p>
        {v.description && <p className={`mt-1 whitespace-pre-line break-words ${expanded ? '' : 'line-clamp-2'}`}>{v.description}</p>}
        {v.description && v.description.length > 120 && <button type="button" className="mt-1 font-semibold" onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}>{expanded ? 'Show less' : '...more'}</button>}
      </div>
      <Comments videoId={v.id} initialCount={v.commentCount} />
      {initialViewer.signedIn && (
        <>
          <SaveDialog videoId={v.id} open={dialog === 'save'} onClose={() => setDialog(null)} onSavedChange={setSaved} />
          <ReportDialog videoId={v.id} open={dialog === 'report'} onClose={() => setDialog(null)} currentTime={() => time.current} />
        </>
      )}
    </>
  );
  const upNext = more.length > 0 && <aside className="space-y-3 lg:w-[402px] lg:shrink-0" aria-label="Up next">{more.map((x) => <VideoRow key={x.id} v={x} locale={locale} />)}</aside>;

  if (theater) {
    return (
      <div>
        <div className="mx-auto max-h-[calc(100dvh-10rem)] w-full max-w-[min(100%,calc((100dvh-10rem)*16/9))] bg-black">{player}</div>
        <div className="mx-auto flex max-w-[1754px] flex-col gap-6 px-4 py-4 sm:px-6 lg:flex-row"><div className="min-w-0 flex-1">{details}</div>{upNext}</div>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-[1754px] flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
      <div className="min-w-0 flex-1">{player}{details}</div>
      {upNext}
    </div>
  );
}
