import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/server-api';
import type { VideoPage } from '@/lib/types';
import { WatchView, type WatchVideo } from './WatchView';

const load = (id?: string) => (id && /^[0-9a-f-]{36}$/i.test(id) ? apiGet<{ video: WatchVideo }>(`/videos/${id}`) : Promise.resolve(null));

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ v?: string }> }): Promise<Metadata> {
  const d = await load((await searchParams).v);
  if (!d) return { title: 'Video not available' };
  return { title: d.video.title, description: d.video.description?.slice(0, 160), openGraph: { title: d.video.title, type: 'video.other', images: d.video.thumbnailUrl && d.video.visibility !== 'PRIVATE' ? [d.video.thumbnailUrl] : undefined } };
}

export default async function Watch({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const d = await load((await searchParams).v);
  if (!d) notFound();
  const [more, channel] = await Promise.all([
    apiGet<VideoPage>('/videos?limit=20&shorts=false'),
    apiGet<{ viewer: { subscribed: boolean } }>(`/channels/${encodeURIComponent(d.video.channel.handle)}`),
  ]);
  return <WatchView v={d.video} more={(more?.videos ?? []).filter((x) => x.id !== d.video.id)} subscribed={channel?.viewer.subscribed ?? false} />;
}
