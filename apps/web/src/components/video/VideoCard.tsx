import Link from 'next/link';
import type React from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '../Avatar';
import { duration, timeAgo, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { HoverPreview } from './HoverPreview';

/** How much of a video was watched, as a small saffron ring (Free Me's progress mark). */
function ProgressRing({ progress }: { progress: number }) {
  const c = 2 * Math.PI * 9;
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" className="absolute right-2.5 top-2.5" role="img" aria-label={`Watched ${Math.round(progress * 100)}%`}>
      <circle cx="13" cy="13" r="9" fill="rgb(20 17 15 / 0.45)" stroke="rgb(255 255 255 / 0.35)" strokeWidth="3" />
      <circle cx="13" cy="13" r="9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${Math.min(1, progress) * c} ${c}`} transform="rotate(-90 13 13)" />
    </svg>
  );
}

/** Media frame: 16:10, Free Me's cut corners (the facet), duration pill at the top left, optional progress ring and title inside. */
export function Thumbnail({ v, className = '', progress, title = false, rounded = 'facet', sizes = '(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 25vw' }: { v: VideoCardData; className?: string; progress?: number; title?: boolean; rounded?: string; sizes?: string }) {
  return (
    <div className={`relative aspect-[16/10] overflow-hidden bg-surface ${rounded} ${className}`}>
      {v.thumbnailUrl
        // The 480 px copy where it is enough (small cards, phones at normal density, a browser saving data); the full one
        // otherwise. The browser chooses from the sizes the card is shown at.
        ? <img src={v.thumbnailSmallUrl ?? v.thumbnailUrl} srcSet={v.thumbnailSmallUrl ? `${v.thumbnailSmallUrl} 480w, ${v.thumbnailUrl} 1280w` : undefined} sizes={v.thumbnailSmallUrl ? sizes : undefined} alt="" loading="lazy" decoding="async" fetchPriority="low" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        : <div className="grid h-full w-full place-items-center text-faint"><Icon.Videos size={36} strokeWidth={1.2} /></div>}
      {v.preview && <HoverPreview preview={v.preview} />}
      {v.durationSeconds > 0 && <span className="facet-sm absolute left-2.5 top-2.5 bg-[rgb(20_17_15/0.82)] px-2 py-0.5 text-[12px] font-semibold text-[#f4ede3] backdrop-blur">{duration(v.durationSeconds)}</span>}
      {progress !== undefined && progress > 0 && <ProgressRing progress={progress} />}
      {title && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(20_17_15/0.85)] via-[rgb(20_17_15/0.45)] to-transparent px-4 pb-3.5 pt-12">
          <h3 className="line-clamp-2 font-display text-[16px] font-bold leading-[1.25] text-white">{v.title}</h3>
        </div>
      )}
    </div>
  );
}

/** Grid card: the title sits inside the frame; the creator and numbers sit below. */
export function VideoCard({ v, locale, progress }: { v: VideoCardData; locale: string; progress?: number }) {
  return (
    <article className="group">
      <Link href={`/watch?v=${v.id}`} aria-label={v.title} className="block transition-transform duration-200 group-hover:-translate-y-0.5">
        <Thumbnail v={v} title progress={progress} className="group-hover:brightness-110" />
      </Link>
      <div className="mt-2.5 flex items-center gap-2 text-[13px] text-muted">
        <Link href={`/@${v.channel.handle}`} className="flex min-w-0 items-center gap-2 hover:text-ink">
          <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={22} />
          <span className="truncate font-medium">{v.channel.name}</span>
          {v.channel.isVerified && <VerifiedBadge size={14} kind={v.channel.badge} />}
        </Link>
        <span className="shrink-0" suppressHydrationWarning>· {viewsLabel(v.viewCount, locale)} · {timeAgo(v.publishedAt, locale)}</span>
      </div>
    </article>
  );
}

/** Compact row for lists (Trail, collections, search results, Keep watching). */
export function VideoRow({ v, locale, large = false, progress, actions }: { v: VideoCardData; locale: string; large?: boolean; progress?: number; actions?: React.ReactNode }) {
  return (
    <article className="group flex gap-4">
      <Link href={`/watch?v=${v.id}`} className={large ? 'w-[42%] max-w-[340px] shrink-0' : 'w-[168px] shrink-0'} aria-label={v.title}>
        <Thumbnail v={v} progress={progress} rounded={large ? 'facet' : 'facet-sm'} sizes={large ? '(max-width: 640px) 42vw, 340px' : '168px'} />
      </Link>
      <div className="min-w-0 flex-1 py-0.5">
        <Link href={`/watch?v=${v.id}`}><h3 className={`line-clamp-2 font-display font-bold ${large ? 'text-[18px] leading-[24px]' : 'text-[14px] leading-5'}`}>{v.title}</h3></Link>
        <Link href={`/@${v.channel.handle}`} className="mt-1.5 flex items-center gap-2 text-[13px] text-muted hover:text-ink">
          <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={large ? 22 : 18} /><span className="truncate">{v.channel.name}</span>
        </Link>
        <p className="mt-0.5 text-[12px] text-muted" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {timeAgo(v.publishedAt, locale)}</p>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </article>
  );
}

/** A Moment: a tall card with a slight alternating tilt. */
export function MomentCard({ v, index = 0 }: { v: VideoCardData; index?: number }) {
  return (
    <Link href={`/moments#${v.id}`} className={`group relative block aspect-[3/5] w-[150px] shrink-0 overflow-hidden bg-surface facet transition-transform duration-200 hover:rotate-0 hover:scale-[1.03] sm:w-[170px] ${index % 2 ? 'translate-y-2 rotate-[1.5deg]' : '-rotate-[1.5deg]'}`}>
      {v.thumbnailUrl && <img src={v.thumbnailSmallUrl ?? v.thumbnailUrl} alt="" loading="lazy" decoding="async" fetchPriority="low" className="h-full w-full object-cover" />}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(20_17_15/0.85)] to-transparent px-3 pb-3 pt-10">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{v.title}</p>
      </div>
    </Link>
  );
}
