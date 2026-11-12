import Link from 'next/link';
import type React from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '../Avatar';
import { duration, timeAgo, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';
import { VerifiedBadge } from '@/components/VerifiedBadge';

/** How much of a video was watched, as a small saffron ring (Free Me's progress mark). */
function ProgressRing({ progress }: { progress: number }) {
  const c = 2 * Math.PI * 9;
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" className="absolute right-2.5 top-2.5" role="img" aria-label={`Watched ${Math.round(progress * 100)}%`}>
      <circle cx="13" cy="13" r="9" fill="rgb(10 17 16 / 0.45)" stroke="rgb(255 255 255 / 0.35)" strokeWidth="3" />
      <circle cx="13" cy="13" r="9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${Math.min(1, progress) * c} ${c}`} transform="rotate(-90 13 13)" />
    </svg>
  );
}

/** Media frame: 16:10, soft corners, duration pill at the top left, optional progress ring and title inside. */
export function Thumbnail({ v, className = '', progress, title = false, rounded = 'rounded-[20px]' }: { v: VideoCardData; className?: string; progress?: number; title?: boolean; rounded?: string }) {
  return (
    <div className={`relative aspect-[16/10] overflow-hidden bg-surface ${rounded} ${className}`}>
      {v.thumbnailUrl
        ? <img src={v.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        : <div className="grid h-full w-full place-items-center text-faint"><Icon.Videos size={36} strokeWidth={1.2} /></div>}
      {v.durationSeconds > 0 && <span className="absolute left-2.5 top-2.5 rounded-full bg-white/90 px-2 py-0.5 text-[12px] font-semibold text-[#10201f] backdrop-blur">{duration(v.durationSeconds)}</span>}
      {progress !== undefined && progress > 0 && <ProgressRing progress={progress} />}
      {title && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(5_15_14/0.85)] via-[rgb(5_15_14/0.45)] to-transparent px-4 pb-3.5 pt-12">
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
        <Thumbnail v={v} title progress={progress} className="shadow-[0_1px_0_rgb(8_40_38/0.04)] group-hover:shadow-[var(--shadow)]" />
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
        <Thumbnail v={v} progress={progress} rounded={large ? 'rounded-[18px]' : 'rounded-[14px]'} />
      </Link>
      <div className="min-w-0 flex-1 py-0.5">
        <Link href={`/watch?v=${v.id}`}><h3 className={`line-clamp-2 font-display font-bold ${large ? 'text-[18px] leading-[24px]' : 'text-[14px] leading-5'}`}>{v.title}</h3></Link>
        <Link href={`/@${v.channel.handle}`} className="mt-1.5 flex items-center gap-2 text-[13px] text-muted hover:text-ink">
          {large && <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={22} />}{v.channel.name}
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
    <Link href={`/moments#${v.id}`} className={`group relative block aspect-[3/5] w-[150px] shrink-0 overflow-hidden rounded-[22px] bg-surface transition-transform duration-200 hover:rotate-0 hover:scale-[1.03] sm:w-[170px] ${index % 2 ? 'translate-y-2 rotate-[1.5deg]' : '-rotate-[1.5deg]'}`}>
      {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(5_15_14/0.85)] to-transparent px-3 pb-3 pt-10">
        <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{v.title}</p>
      </div>
    </Link>
  );
}
