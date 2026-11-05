import * as Icon from '@/components/icons';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { VideoRow } from '@/components/video/VideoCard';
import { apiGet, getLocale } from '@/lib/server-api';
import { followersLabel } from '@/lib/format';
import type { ChannelInfo, VideoPage } from '@/lib/types';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string }> }): Promise<Metadata> {
  return { title: (await searchParams).q || 'Search' };
}

export default async function Results({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? '').trim();
  const locale = await getLocale();
  const data = q ? await apiGet<VideoPage & { channels: ChannelInfo[] }>(`/search?q=${encodeURIComponent(q)}`) : null;
  if (!data || (!data.videos.length && !data.channels.length)) {
    return <EmptyState icon={<Icon.SearchEmpty size={36} strokeWidth={1.4} />} title={q ? 'No results found' : 'Search Free Me'}>{q ? 'Try different words, or check the spelling.' : 'Type in the search box above to find videos and channels.'}</EmptyState>;
  }
  return (
    <div className="mx-auto max-w-[1100px] space-y-4 px-4 py-4 sm:px-6">
      {data.channels.map((c) => (
        <Link key={c.id} href={`/@${c.handle}`} className="flex items-center gap-6 rounded-xl py-3 sm:px-10">
          <div className="hidden sm:block"><Avatar name={c.name} src={c.avatarUrl} size={120} /></div><div className="sm:hidden"><Avatar name={c.name} src={c.avatarUrl} size={64} /></div>
          <div className="min-w-0"><p className="text-[18px] font-medium">{c.name}</p><p className="text-[12px] text-muted">@{c.handle} · {followersLabel(c.followerCount, locale)}</p>{c.description && <p className="mt-1 line-clamp-1 text-[12px] text-muted">{c.description}</p>}</div>
        </Link>
      ))}
      {data.videos.map((v) => <VideoRow key={v.id} v={v} locale={locale} large />)}
    </div>
  );
}
