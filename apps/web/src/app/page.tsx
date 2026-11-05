import Link from 'next/link';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { InterestsPanel } from '@/components/home/InterestsPanel';
import type { HomeFeed } from '@/components/home/types';
import { MomentCard, VideoCard } from '@/components/video/VideoCard';
import { apiGet, getLocale, getViewer } from '@/lib/server-api';
import { duration, followersLabel } from '@/lib/format';

/** For you: a spotlight, the interests panel, one shelf per topic, a Moments ribbon and the newest uploads. */
export default async function ForYou() {
  const [feed, viewer, locale] = await Promise.all([apiGet<HomeFeed>('/feed/home'), getViewer(), getLocale()]);
  if (!feed || (!feed.spotlight && !feed.moments.length)) {
    return (
      <EmptyState icon={<Icon.Moments size={36} strokeWidth={1.4} />} title="No videos yet"
        action={viewer?.channel ? <Link href="/hub?upload=1" className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Upload a video</Link>
          : <Link href={viewer ? '/channel/create' : '/login?returnTo=/channel/create'} className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Create your Space</Link>}>
        Videos appear here as creators publish them. Start your Space now to be among the first.
      </EmptyState>
    );
  }
  const s = feed.spotlight;
  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-3 sm:px-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {s ? (
          <Link href={`/watch?v=${s.id}`} className="group relative block min-h-[300px] overflow-hidden rounded-[24px] bg-surface sm:min-h-[380px]">
            {s.thumbnailUrl && <img src={s.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]" />}
            <div className="absolute inset-0 bg-gradient-to-t from-[rgb(5_15_14/0.9)] via-[rgb(5_15_14/0.35)] to-transparent" />
            <span className="absolute left-4 top-4 rounded-full bg-white/90 px-2.5 py-0.5 text-[12px] font-semibold text-[#10201f]">{duration(s.durationSeconds)}</span>
            <div className="absolute inset-x-0 bottom-0 p-5 sm:p-7">
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#f5c46b]">Spotlight{s.category ? ` · ${s.category.name}` : ''}</p>
              <h1 className="mt-2 max-w-[680px] text-[26px] font-extrabold leading-[1.1] text-white sm:text-[34px]">{s.title}</h1>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-semibold text-[#10201f]"><Icon.Play size={18} />Watch now</span>
                <span className="flex items-center gap-2 text-[14px] text-white/90"><Avatar name={s.channel.name} src={s.channel.avatarUrl} size={30} />{s.channel.name} · <span suppressHydrationWarning>{followersLabel(s.channelFollowers, locale)}</span></span>
              </div>
            </div>
          </Link>
        ) : <div />}
        <InterestsPanel interests={feed.interests} fromCreators={feed.fromCreators} />
      </div>

      {feed.moments.length > 0 && (
        <section className="mt-10">
          <h2 className="flex items-baseline gap-2.5 text-[22px] font-bold">Moments <span className="font-sans text-[13px] font-medium text-muted">short and vertical</span>
            <Link href="/moments" className="ml-auto font-sans text-[13px] font-semibold text-brand">Open Moments</Link></h2>
          <div className="no-scrollbar -mx-4 mt-3 flex gap-4 overflow-x-auto px-4 pb-4 pt-1 sm:-mx-6 sm:px-6">
            {feed.moments.map((v, i) => <MomentCard key={v.id} v={v} index={i} />)}
          </div>
        </section>
      )}

      {feed.shelves.map((shelf) => (
        <section key={shelf.category.slug} className="mt-9">
          <h2 className="flex items-baseline gap-2.5 text-[22px] font-bold">{shelf.category.name}
            <span className="font-sans text-[13px] font-medium text-muted">{shelf.reason === 'picked' ? 'because you picked it' : 'popular this month'}</span>
            <Link href={`/explore?topic=${shelf.category.slug}`} className="ml-auto font-sans text-[13px] font-semibold text-brand">See all</Link></h2>
          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {shelf.videos.slice(0, 4).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
          </div>
        </section>
      ))}

      {feed.latest.length > 0 && (
        <section className="mt-9">
          <h2 className="flex items-baseline gap-2.5 text-[22px] font-bold">Just published <span className="font-sans text-[13px] font-medium text-muted">newest first</span>
            <Link href="/explore" className="ml-auto font-sans text-[13px] font-semibold text-brand">Explore</Link></h2>
          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {feed.latest.slice(0, 8).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
          </div>
        </section>
      )}
    </div>
  );
}
