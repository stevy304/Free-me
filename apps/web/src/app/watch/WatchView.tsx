'use client';

import { BadgeCheck, Loader2, Share2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { SubscribeButton } from '@/components/SubscribeButton';
import { VideoPlayer } from '@/components/player/VideoPlayer';
import { useShell } from '@/components/shell/ShellContext';
import { VideoRow } from '@/components/video/VideoCard';
import { fullDate, subscribersLabel, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';

export interface WatchVideo extends VideoCardData {
  description: string | null; status: string; visibility: string; likeCount: number; commentCount: number; playbackUrl: string | null; processingStage: string | null;
  category: { name: string; slug: string } | null; channel: VideoCardData['channel'] & { subscriberCount: number };
}

export function WatchView({ v, more, subscribed }: { v: WatchVideo; more: VideoCardData[]; subscribed: boolean }) {
  const { locale } = useShell();
  const [theater, setTheater] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { try { setTheater(localStorage.getItem('fm_theater') === '1'); } catch { /* blocked */ } }, []);
  const toggleTheater = () => setTheater((t) => { try { localStorage.setItem('fm_theater', t ? '0' : '1'); } catch { /* blocked */ } return !t; });
  const share = async () => {
    const url = `${window.location.origin}/watch?v=${v.id}`;
    try { if (navigator.share) await navigator.share({ title: v.title, url }); else { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } } catch { /* dismissed */ }
  };

  const player = v.playbackUrl
    ? <VideoPlayer key={v.id} src={v.playbackUrl} poster={v.thumbnailUrl} videoId={v.id} durationHint={v.durationSeconds} theater={theater} onTheater={toggleTheater} />
    : <div className="grid aspect-video w-full place-items-center rounded-xl bg-surface text-center text-[15px] text-muted"><div><Loader2 className="mx-auto mb-3 animate-spin" />{v.processingStage ?? 'This video is still being processed.'}</div></div>;

  const details = (
    <>
      <h1 className="mt-3 text-[20px] font-bold leading-7">{v.title}</h1>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href={`/@${v.channel.handle}`}><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={40} /></Link>
          <div className="mr-3"><Link href={`/@${v.channel.handle}`} className="flex items-center gap-1 text-[16px] font-semibold">{v.channel.name}{v.channel.isVerified && <BadgeCheck size={14} />}</Link><p className="text-[12px] text-muted">{subscribersLabel(v.channel.subscriberCount, locale)}</p></div>
          <SubscribeButton handle={v.channel.handle} initial={subscribed} initialCount={v.channel.subscriberCount} />
        </div>
        <button type="button" onClick={share} className="flex h-9 items-center gap-2 rounded-full bg-surface px-4 text-[14px] font-medium hover:bg-surface-hover"><Share2 size={18} />{copied ? 'Link copied' : 'Share'}</button>
      </div>
      <div className={`mt-4 rounded-xl bg-surface p-3 text-[14px] ${expanded ? '' : 'cursor-pointer hover:bg-surface-hover'}`} onClick={() => !expanded && setExpanded(true)}>
        <p className="font-semibold" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {v.publishedAt ? fullDate(v.publishedAt, locale) : 'Not published'}{v.category && <> · <Link href={`/?category=${v.category.slug}`} className="text-brand" onClick={(e) => e.stopPropagation()}>{v.category.name}</Link></>}</p>
        {v.description && <p className={`mt-1 whitespace-pre-line ${expanded ? '' : 'line-clamp-2'}`}>{v.description}</p>}
        {v.description && v.description.length > 120 && <button type="button" className="mt-1 font-semibold" onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}>{expanded ? 'Show less' : '...more'}</button>}
      </div>
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
