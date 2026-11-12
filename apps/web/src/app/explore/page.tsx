import type { Metadata } from 'next';
import Link from 'next/link';
import * as Icon from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';
import { VideoCard } from '@/components/video/VideoCard';
import { VideoGrid } from '@/components/video/VideoGrid';
import { apiGet, getLocale } from '@/lib/server-api';
import type { Category, VideoCardData, VideoPage } from '@/lib/types';

export const metadata: Metadata = { title: 'Explore' };

/** Explore: every topic, Rising (most watched this week) and everything published, newest first. */
export default async function Explore({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic } = await searchParams;
  const endpoint = `/videos?moments=false${topic ? `&category=${encodeURIComponent(topic)}` : ''}`;
  const [cats, page, rising, locale] = await Promise.all([
    apiGet<{ categories: Category[] }>('/categories'), apiGet<VideoPage>(endpoint), topic ? null : apiGet<{ videos: VideoCardData[] }>('/feed/rising'), getLocale(),
  ]);
  const categories = cats?.categories ?? [];
  const current = categories.find((c) => c.slug === topic);
  const chip = (on: boolean) => `shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-semibold ${on ? 'bg-ink text-bg' : 'bg-surface text-ink hover:bg-surface-hover'}`;
  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6">
      <h1 className="text-[30px] font-extrabold">{current ? current.name : 'Explore'}</h1>
      <p className="mt-1 text-[14px] text-muted">{current ? `Every ${current.name} video, newest first.` : 'Browse by topic, see what is rising this week, or everything that was just published.'}</p>
      <nav aria-label="Topics" className="no-scrollbar -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
        <Link href="/explore" className={chip(!current)}>All topics</Link>
        {categories.map((c) => <Link key={c.id} href={`/explore?topic=${c.slug}`} className={chip(current?.slug === c.slug)}>{c.name}</Link>)}
      </nav>
      {rising && rising.videos.length > 0 && (
        <section className="mt-8">
          <h2 className="flex items-baseline gap-2.5 text-[22px] font-bold"><Icon.Spark size={20} filled className="self-center text-accent" />Rising <span className="font-sans text-[13px] font-medium text-muted">most watched this week</span></h2>
          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">{rising.videos.slice(0, 4).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}</div>
        </section>
      )}
      <section className="mt-9">
        {!current && <h2 className="text-[22px] font-bold">Just published</h2>}
        <div className="mt-3">
          {page && page.videos.length ? <VideoGrid first={page} endpoint={endpoint} />
            : <EmptyState icon={<Icon.Compass size={36} strokeWidth={1.4} />} title={current ? `No ${current.name} videos yet` : 'No videos yet'}>Videos appear here as creators publish them.</EmptyState>}
        </div>
      </section>
    </div>
  );
}
