import { Clapperboard } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { apiGet, getLocale } from '@/lib/server-api';
import { viewsLabel } from '@/lib/format';
import type { VideoPage } from '@/lib/types';

export const metadata: Metadata = { title: 'Shorts' };

/** Vertical feed of short videos; each card opens its watch page. */
export default async function Shorts() {
  const page = await apiGet<VideoPage>('/videos?shorts=true&limit=24');
  const shorts = page?.videos ?? [];
  const locale = await getLocale();
  if (!shorts.length) return <EmptyState icon={<Clapperboard size={36} strokeWidth={1.4} />} title="No Shorts yet">Short vertical videos will appear here as creators publish them.</EmptyState>;
  return (
    <div className="no-scrollbar mx-auto h-[calc(100dvh-3.5rem-3rem)] max-w-[420px] snap-y snap-mandatory overflow-y-auto md:h-[calc(100dvh-3.5rem)]">
      {shorts.map((s) => (
        <Link key={s.id} href={`/watch?v=${s.id}`} className="relative my-3 block aspect-[9/16] snap-center overflow-hidden rounded-2xl bg-surface">
          {s.thumbnailUrl && <img src={s.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 text-white">
            <p className="text-[15px] font-medium">{s.title}</p><p className="text-[13px] opacity-80">@{s.channel.handle} · {viewsLabel(s.viewCount, locale)}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
