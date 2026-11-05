import { BadgeCheck, Loader2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { SubscribeButton } from '@/components/SubscribeButton';
import { VideoRow } from '@/components/video/VideoCard';
import { apiGet, getLocale } from '@/lib/server-api';
import { fullDate, subscribersLabel, viewsLabel } from '@/lib/format';
import type { VideoCardData, VideoPage } from '@/lib/types';
import { Player } from './Player';

interface WatchVideo extends VideoCardData {
  description: string | null; status: string; visibility: string; likeCount: number; commentCount: number; playbackUrl: string | null;
  category: { name: string; slug: string } | null; channel: VideoCardData['channel'] & { subscriberCount: number };
}

const load = (id?: string) => (id && /^[0-9a-f-]{36}$/i.test(id) ? apiGet<{ video: WatchVideo }>(`/videos/${id}`) : Promise.resolve(null));

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ v?: string }> }): Promise<Metadata> {
  const d = await load((await searchParams).v);
  return d ? { title: d.video.title, description: d.video.description?.slice(0, 160) } : { title: 'Video not available' };
}

export default async function Watch({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const d = await load((await searchParams).v);
  if (!d) notFound();
  const v = d.video;
  const locale = await getLocale();
  const more = ((await apiGet<VideoPage>('/videos?limit=12&shorts=false'))?.videos ?? []).filter((x) => x.id !== v.id);
  return (
    <div className="mx-auto flex max-w-[1754px] flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
      <div className="min-w-0 flex-1">
        {v.playbackUrl ? <Player src={v.playbackUrl} poster={v.thumbnailUrl} /> : (
          <div className="grid aspect-video w-full place-items-center rounded-xl bg-surface text-center text-[15px] text-muted">
            <div><Loader2 className="mx-auto mb-3 animate-spin" />This video is still being processed.</div>
          </div>
        )}
        <h1 className="mt-3 text-[20px] font-semibold leading-7">{v.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Link href={`/@${v.channel.handle}`} className="flex items-center gap-3">
            <Avatar name={v.channel.name} src={v.channel.avatarUrl} size={40} />
            <div><p className="flex items-center gap-1 text-[16px] font-medium">{v.channel.name}{v.channel.isVerified && <BadgeCheck size={14} />}</p><p className="text-[12px] text-muted">{subscribersLabel(v.channel.subscriberCount, locale)}</p></div>
          </Link>
          <SubscribeButton handle={v.channel.handle} initial={false} initialCount={v.channel.subscriberCount} />
        </div>
        <div className="mt-4 rounded-xl bg-surface p-3 text-[14px]">
          <p className="font-medium">{viewsLabel(v.viewCount, locale)} · {v.publishedAt ? fullDate(v.publishedAt, locale) : 'Not published'}{v.category && <> · <Link href={`/?category=${v.category.slug}`} className="text-brand">{v.category.name}</Link></>}</p>
          {v.description && <p className="mt-2 whitespace-pre-line">{v.description}</p>}
        </div>
      </div>
      {more.length > 0 && <aside className="space-y-3 lg:w-[402px] lg:shrink-0">{more.map((x) => <VideoRow key={x.id} v={x} locale={locale} />)}</aside>}
    </div>
  );
}
