import { CreatorSupport } from '@/components/billing/CreatorSupport';
import * as Icon from '@/components/icons';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { countryName } from '@free-me/shared';
import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { FollowButton } from '@/components/FollowButton';
import { VideoCard } from '@/components/video/VideoCard';
import { apiGet, getLocale } from '@/lib/server-api';
import { compactNumber, fullDate, followersLabel } from '@/lib/format';
import type { ChannelInfo, VideoCardData } from '@/lib/types';
import { VerifiedBadge } from '@/components/VerifiedBadge';

interface ChannelPage { channel: ChannelInfo; videoCount: number; videos: VideoCardData[]; viewer: { following: boolean; isOwner: boolean } }

const load = (handle: string) => apiGet<ChannelPage>(`/channels/${encodeURIComponent(decodeURIComponent(handle).replace(/^@/, ''))}`);

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const data = await load((await params).handle);
  if (!data) return { title: 'Channel not found', robots: { index: false } };
  const c = data.channel;
  const description = (c.description?.replace(/\s+/g, ' ').trim() || `Videos from ${c.name} on Free Me.`).slice(0, 200);
  const image = c.avatarUrl ? [{ url: c.avatarUrl, alt: c.name }] : undefined;
  return {
    title: c.name, description, alternates: { canonical: `/@${c.handle}` },
    openGraph: { type: 'profile', url: `/@${c.handle}`, title: c.name, description, siteName: 'Free Me', images: image },
    twitter: { card: 'summary', title: c.name, description, images: image?.map((i) => i.url) },
  };
}

export default async function Channel({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<{ tab?: string }> }) {
  const data = await load((await params).handle);
  if (!data) notFound();
  const { channel: c, videos, videoCount, viewer } = data;
  const tab = (await searchParams).tab === 'about' ? 'about' : 'videos';
  const locale = await getLocale();
  const tabClass = (on: boolean) => `border-b-2 px-1 pb-3 text-[16px] font-medium ${on ? 'border-ink' : 'border-transparent text-muted hover:text-ink'}`;
  return (
    <div className="mx-auto max-w-[1284px] px-4 sm:px-6">
      {c.bannerUrl
        ? <img src={c.bannerUrl} alt="" className="mt-2 aspect-[6/1] w-full rounded-2xl object-cover" />
        : <div className="mt-2 aspect-[6/1] w-full rounded-2xl bg-[linear-gradient(120deg,var(--brand-soft),color-mix(in_srgb,var(--brand)_35%,var(--surface)))]" />}
      <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="hidden sm:block"><Avatar name={c.name} src={c.avatarUrl} size={160} /></div>
        <div className="sm:hidden"><Avatar name={c.name} src={c.avatarUrl} size={72} /></div>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[28px] font-extrabold leading-tight sm:text-[38px]">{c.name}{c.isVerified && <VerifiedBadge size={23} kind={c.badge} />}</h1>
          <p className="mt-1.5 text-[14px] text-muted"><span className="font-medium text-ink">@{c.handle}</span> · {followersLabel(c.followerCount, locale)} · {compactNumber(videoCount, locale)} {videoCount === 1 ? 'video' : 'videos'}</p>
          {c.description && <Link href={`/@${c.handle}?tab=about`} className="mt-1.5 line-clamp-1 max-w-xl text-[14px] text-muted hover:text-ink">{c.description}</Link>}
          <div className="mt-4">
            {viewer.isOwner
              ? <span className="flex flex-wrap gap-2"><Link href="/settings#channel" className="inline-flex h-10 items-center rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover">Edit your Space</Link><Link href="/hub" className="inline-flex h-10 items-center rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand hover:bg-brand-strong">Creator Hub</Link></span>
              : <span className="flex flex-wrap items-center gap-2">
                  <FollowButton handle={c.handle} initial={viewer.following} initialCount={c.followerCount} />
                  <Link href={`/messages?to=${encodeURIComponent(c.handle)}`} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover"><Icon.Message size={18} />Message</Link>
                </span>}
          </div>
        </div>
      </div>
      <CreatorSupport handle={c.handle} owner={viewer.isOwner} />
      <nav className="mt-6 flex gap-6 border-b border-line" aria-label="Space">
        <Link href={`/@${c.handle}`} className={tabClass(tab === 'videos')} aria-current={tab === 'videos' ? 'page' : undefined}>Videos</Link>
        <Link href={`/@${c.handle}?tab=about`} className={tabClass(tab === 'about')} aria-current={tab === 'about' ? 'page' : undefined}>About</Link>
      </nav>
      {tab === 'videos' ? (
        videos.length ? (
          <div className="grid grid-cols-1 gap-x-5 gap-y-7 py-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{videos.map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}</div>
        ) : (
          <EmptyState icon={<Icon.Moments size={36} strokeWidth={1.4} />} title={viewer.isOwner ? 'Your Space is ready' : 'No videos yet'}>
            {viewer.isOwner ? 'Your videos will appear here once you publish them.' : 'This Space has not published any videos yet.'}
          </EmptyState>
        )
      ) : (
        <section className="max-w-3xl py-6 text-[15px]">
          <h2 className="text-[20px] font-semibold">About</h2>
          <p className="mt-3 whitespace-pre-line leading-relaxed text-ink">{c.description || 'No description yet.'}</p>
          <dl className="mt-6 space-y-2 text-[14px] text-muted">
            <div>Joined {fullDate(c.createdAt, locale)}</div>
            <div>{followersLabel(c.followerCount, locale)}</div>
            <div>{compactNumber(c.totalViews, locale)} views</div>
            {c.country && <div>{countryName(c.country, locale)}</div>}
          </dl>
        </section>
      )}
    </div>
  );
}
