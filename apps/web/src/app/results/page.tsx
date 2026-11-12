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
  const total = data.videos.length + data.channels.length;
  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-5 sm:px-6">
      <h1 className="font-display text-[26px] font-extrabold leading-tight">Results for <span className="text-brand">“{q}”</span></h1>
      <p className="mt-1 text-[14px] text-muted">{total === 1 ? '1 result' : `${total} results`}{data.channels.length ? ` · ${data.channels.length === 1 ? '1 Space' : `${data.channels.length} Spaces`}` : ''}</p>
      {data.channels.length > 0 && (
        <section aria-labelledby="spaces-heading" className="mt-6">
          <h2 id="spaces-heading" className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Spaces</h2>
          <ul className="mt-2 grid gap-3 sm:grid-cols-2">
            {data.channels.map((c) => (
              <li key={c.id}>
                <Link href={`/@${c.handle}`} className="group flex items-center gap-4 rounded-2xl border border-line bg-elevated p-3 transition-colors hover:border-brand">
                  <Avatar name={c.name} src={c.avatarUrl} size={56} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[16px] font-semibold">{c.name}</p>
                    <p className="truncate text-[13px] text-muted" suppressHydrationWarning>@{c.handle} · {followersLabel(c.followerCount, locale)}</p>
                    {c.description && <p className="mt-0.5 line-clamp-1 text-[13px] text-muted">{c.description}</p>}
                  </div>
                  <Icon.ChevronRight size={18} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.videos.length > 0 && (
        <section aria-labelledby="videos-heading" className="mt-8">
          <h2 id="videos-heading" className="text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Videos</h2>
          <div className="mt-3 space-y-5">{data.videos.map((v) => <VideoRow key={v.id} v={v} locale={locale} large />)}</div>
        </section>
      )}
    </div>
  );
}
