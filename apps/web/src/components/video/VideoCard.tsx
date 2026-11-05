import { BadgeCheck, Film } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '../Avatar';
import { duration, timeAgo, viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';

export function Thumbnail({ v, className = '' }: { v: VideoCardData; className?: string }) {
  return (
    <div className={`relative aspect-video overflow-hidden rounded-xl bg-surface ${className}`}>
      {v.thumbnailUrl
        ? <img src={v.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
        : <div className="grid h-full w-full place-items-center text-faint"><Film size={36} strokeWidth={1.2} /></div>}
      {v.durationSeconds > 0 && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1 py-px text-[12px] font-medium text-white">{duration(v.durationSeconds)}</span>}
    </div>
  );
}

/** Grid card: thumbnail, channel avatar, title, channel, views and age. */
export function VideoCard({ v, locale }: { v: VideoCardData; locale: string }) {
  return (
    <article className="group">
      <Link href={`/watch?v=${v.id}`} aria-label={v.title}><Thumbnail v={v} /></Link>
      <div className="mt-3 flex gap-3">
        <Link href={`/@${v.channel.handle}`} className="shrink-0" aria-label={v.channel.name}><Avatar name={v.channel.name} src={v.channel.avatarUrl} size={36} /></Link>
        <div className="min-w-0">
          <Link href={`/watch?v=${v.id}`}><h3 className="line-clamp-2 text-[16px] font-medium leading-[22px]">{v.title}</h3></Link>
          <Link href={`/@${v.channel.handle}`} className="mt-1 flex items-center gap-1 text-[14px] text-muted hover:text-ink">
            {v.channel.name}{v.channel.isVerified && <BadgeCheck size={14} aria-label="Verified" />}
          </Link>
          <p className="text-[14px] text-muted" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {timeAgo(v.publishedAt, locale)}</p>
        </div>
      </div>
    </article>
  );
}

/** Compact row for side lists and search results. */
export function VideoRow({ v, locale, large = false }: { v: VideoCardData; locale: string; large?: boolean }) {
  return (
    <article className="group flex gap-3">
      <Link href={`/watch?v=${v.id}`} className={large ? 'w-[45%] max-w-[360px] shrink-0' : 'w-[168px] shrink-0'} aria-label={v.title}><Thumbnail v={v} className={large ? '' : 'rounded-lg'} /></Link>
      <div className="min-w-0 py-0.5">
        <Link href={`/watch?v=${v.id}`}><h3 className={`line-clamp-2 font-medium ${large ? 'text-[18px] leading-[26px]' : 'text-[14px] leading-5'}`}>{v.title}</h3></Link>
        <p className="mt-1 text-[12px] text-muted" suppressHydrationWarning>{viewsLabel(v.viewCount, locale)} · {timeAgo(v.publishedAt, locale)}</p>
        <Link href={`/@${v.channel.handle}`} className={`mt-1 flex items-center gap-2 text-[12px] text-muted hover:text-ink ${large ? 'py-2' : ''}`}>
          {large && <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={24} />}{v.channel.name}
        </Link>
      </div>
    </article>
  );
}
