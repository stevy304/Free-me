import * as Icon from '@/components/icons';
import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { ChipBar } from '@/components/video/ChipBar';
import { VideoGrid } from '@/components/video/VideoGrid';
import { apiGet, getLocale, getViewer } from '@/lib/server-api';
import { MomentsShelf } from '@/components/video/MomentsShelf';
import type { Category, VideoPage } from '@/lib/types';

export default async function Home({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const endpoint = `/videos?moments=false${category ? `&category=${encodeURIComponent(category)}` : ''}`;
  const [cats, page, viewer, shorts, locale] = await Promise.all([apiGet<{ categories: Category[] }>('/categories'), apiGet<VideoPage>(endpoint), getViewer(), category ? null : apiGet<VideoPage>('/videos?moments=true&limit=12'), getLocale()]);
  const categories = cats?.categories ?? [];
  const current = categories.find((c) => c.slug === category);
  const videos = page ?? { videos: [], nextCursor: null };
  return (
    <div className="px-4 sm:px-6">
      <ChipBar categories={categories} active={current?.slug ?? null} />
      <div className="pt-3">
        {shorts && <MomentsShelf shorts={shorts.videos} locale={locale} />}
        {videos.videos.length ? <VideoGrid first={videos} endpoint={endpoint} /> : shorts?.videos.length ? null : (
          <EmptyState icon={<Icon.Moments size={36} strokeWidth={1.4} />} title={current ? `No ${current.name} videos yet` : 'No videos yet'}
            action={viewer?.channel ? undefined : <Link href={viewer ? '/channel/create' : '/login?returnTo=/channel/create'} className="inline-flex h-10 items-center rounded-full bg-strong px-5 text-[14px] font-medium text-on-strong hover:opacity-90">Create your channel</Link>}>
            {current ? 'Videos in this category will appear here as creators publish them.' : 'Videos appear here as creators publish them. Start a channel now to be among the first.'}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
