import { Clapperboard } from 'lucide-react';
import Link from 'next/link';
import { viewsLabel } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';

/** A row of Shorts on the home page. */
export function ShortsShelf({ shorts, locale }: { shorts: VideoCardData[]; locale: string }) {
  if (!shorts.length) return null;
  return (
    <section className="mb-10 border-b border-line pb-8" aria-label="Shorts">
      <h2 className="mb-4 flex items-center gap-2 text-[20px] font-bold"><Clapperboard size={24} className="text-brand" />Shorts</h2>
      <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1">
        {shorts.map((s) => (
          <Link key={s.id} href={`/shorts#${s.id}`} className="group w-[180px] shrink-0 sm:w-[210px]">
            <div className="aspect-[9/16] overflow-hidden rounded-xl bg-surface">{s.thumbnailUrl && <img src={s.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]" />}</div>
            <p className="mt-2 line-clamp-2 text-[15px] font-medium leading-5">{s.title}</p>
            <p className="text-[13px] text-muted" suppressHydrationWarning>{viewsLabel(s.viewCount, locale)}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
