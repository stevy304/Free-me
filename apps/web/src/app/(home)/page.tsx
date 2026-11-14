import Link from 'next/link';
import type { Metadata } from 'next';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { InterestsPanel } from '@/components/home/InterestsPanel';
import { ForYou, type ForYouPage } from '@/components/home/ForYou';
import type { HomeFeed } from '@/components/home/types';
import { MomentCard, VideoCard } from '@/components/video/VideoCard';
import { apiGet, getLocale, getT, getViewer } from '@/lib/server-api';
import { topicName } from '@/i18n';
import { duration, followersLabel } from '@/lib/format';
import type { LiveInfo } from '../live/types';

export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('home.title') }; }

/** A country's name in the reader's language ("RW" → "Rwanda"). */
function regionName(code: string, locale: string) {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

/** Current: a spotlight, the interests panel, one shelf per topic, a Moments ribbon and the newest uploads. */
export default async function Current() {
  const [feed, viewer, locale, live, t, forYou] = await Promise.all([apiGet<HomeFeed>('/feed/home'), getViewer(), getLocale(), apiGet<{ streams: LiveInfo[] }>('/live').catch(() => null), getT(), apiGet<ForYouPage>('/feed/for-you').catch(() => null)]);
  const liveNow = live?.streams ?? [];
  if (!feed || (!feed.spotlight && !feed.moments.length)) {
    return (
      <>
      {liveNow.length > 0 && <div className="mx-auto max-w-[1600px] px-4 pt-3 sm:px-6"><LiveStrip streams={liveNow} label={t('home.liveNow')} /></div>}
      <EmptyState icon={<Icon.Moments size={36} strokeWidth={1.4} />} title={t('home.emptyTitle')}
        action={viewer?.channel ? <Link href="/hub?upload=1" className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">{t('home.uploadVideo')}</Link>
          : <Link href={viewer ? '/channel/create' : '/login?returnTo=/channel/create'} className="inline-flex h-10 items-center rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">{t('home.createSpace')}</Link>}>
        {t('home.emptyText')}
      </EmptyState>
      </>
    );
  }
  const s = feed.spotlight;
  const unfinished = feed.continueWatching ?? [];
  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-3 sm:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="font-display text-[30px] font-extrabold sm:text-[34px]">{viewer ? t('home.welcome', { name: (viewer.profile?.displayName ?? viewer.channel?.name ?? '').split(' ')[0] || viewer.user.email.split('@')[0] }) : t('home.title')}</h1><p className="text-sm text-muted">{t('home.subtitle')}</p></div>
      </header>
      <LiveStrip streams={liveNow} label={t('home.liveNow')} />
      {unfinished.length > 0 && (
        <section aria-labelledby="continue-heading" className="mb-8 rounded-3xl border border-line bg-elevated p-4 sm:p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 id="continue-heading" className="text-xl font-bold">{t('home.continue')}</h2>
            <Link href="/trail" className="text-sm font-semibold text-brand">{t('home.yourTrail')}</Link>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {unfinished.map(({ video, progressSeconds }) => (
              <div key={video.id}>
                <VideoCard v={video} locale={locale} progress={progressSeconds / video.durationSeconds} />
                <p className="mt-2 text-xs font-semibold text-brand">{t('home.left', { time: duration(Math.max(0, video.durationSeconds - progressSeconds)) })}</p>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {s ? (
          <Link href={`/watch?v=${s.id}`} className="facet-lg group relative block min-h-[300px] overflow-hidden bg-surface sm:min-h-[380px]">
            {s.thumbnailUrl && <img src={s.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]" />}
            <div className="absolute inset-0 bg-gradient-to-t from-[rgb(20_17_15/0.9)] via-[rgb(20_17_15/0.35)] to-transparent" />
            <span className="facet-sm absolute left-4 top-4 bg-[rgb(20_17_15/0.82)] px-2.5 py-0.5 text-[12px] font-semibold text-[#f4ede3]">{duration(s.durationSeconds)}</span>
            <div className="absolute inset-x-0 bottom-[10px] p-5 sm:p-7">
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#e8b04a]">{t('home.spotlight')}{s.category ? ` · ${topicName(t, s.category.slug, s.category.name)}` : ''}</p>
              <h2 className="mt-2 max-w-[680px] text-[26px] font-extrabold leading-[1.1] text-white sm:text-[34px]">{s.title}</h2>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="facet-sm inline-flex h-10 items-center gap-2 bg-accent px-4 text-[14px] font-semibold text-[#14110f]"><Icon.Play size={18} />{t('home.watchNow')}</span>
                <span className="flex items-center gap-2 text-[14px] text-white/90"><Avatar name={s.channel.name} src={s.channel.avatarUrl} size={30} />{s.channel.name} · <span suppressHydrationWarning>{followersLabel(s.channelFollowers, locale)}</span></span>
              </div>
            </div>
            {/* The Imigongo band: Free Me's signature along the Spotlight. */}
            <div aria-hidden="true" className="imigongo-band absolute inset-x-0 bottom-0" />
          </Link>
        ) : <div />}
        {/* On phones the panel comes after Trending, so the first screens are videos. */}
        <div className="hidden lg:block"><InterestsPanel interests={feed.interests} /></div>
      </div>

      {forYou && forYou.videos.length >= 4 && <ForYou initial={forYou} signedIn={!!viewer} />}

      {feed.fromCreators.length > 0 && (
        <section aria-labelledby="following-heading" className="mt-9">
          <SectionHead id="following-heading" title={t('home.fromCreators')} note={t('home.fromCreatorsNote')} href="/following" link={t('home.seeAll')} />
          <div className="mt-3 grid gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
            {feed.fromCreators.slice(0, 4).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
          </div>
        </section>
      )}

      {(feed.trending?.videos.length ?? 0) >= 4 && (
        <section aria-labelledby="trending-heading" className="mt-9">
          <SectionHead id="trending-heading" title={feed.trending!.country ? t('home.trendingIn', { country: regionName(feed.trending!.country, locale) }) : t('home.trending')} note={t('home.trendingNote')} href="/explore" link="Explore" />
          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
            {feed.trending!.videos.slice(0, 4).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
          </div>
        </section>
      )}
      <div className="mt-9 lg:hidden"><InterestsPanel interests={feed.interests} /></div>

      {feed.moments.length > 0 && (
        <section className="mt-10">
          <SectionHead title={t('nav.moments')} note={t('home.momentsNote')} href="/moments" link={t('home.openMoments')} />
          <div className="no-scrollbar -mx-4 mt-3 flex gap-4 overflow-x-auto px-4 pb-4 pt-1 sm:-mx-6 sm:px-6">
            {feed.moments.map((v, i) => <MomentCard key={v.id} v={v} index={i} />)}
          </div>
        </section>
      )}

      {feed.shelves.map((shelf) => (
        <section key={shelf.category.slug} className="mt-9">
          <SectionHead title={topicName(t, shelf.category.slug, shelf.category.name)} note={shelf.reason === 'picked' ? t('home.picked') : t('home.popular')} href={`/explore?topic=${shelf.category.slug}`} link={t('home.seeAll')} />
          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
            {shelf.videos.slice(0, 4).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
          </div>
        </section>
      ))}

      {feed.latest.length > 0 && (
        <section className="mt-9">
          <SectionHead title={t('home.latest')} note={t('home.latestNote')} href="/explore" link={t('home.explore')} />
          <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
            {feed.latest.slice(0, 8).map((v) => <VideoCard key={v.id} v={v} locale={locale} />)}
          </div>
        </section>
      )}
    </div>
  );
}

/** A shelf heading: title and link on one line; the note beside the title, or under it on narrow screens. */
function SectionHead({ id, title, note, href, link }: { id?: string; title: string; note: string; href: string; link: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 sm:flex sm:items-baseline sm:gap-2.5">
        <div><h2 id={id} className="text-[22px] font-bold leading-tight">{title}</h2><div aria-hidden="true" className="zigzag mt-1 w-14" /></div>
        <p className="text-[13px] font-medium text-muted">{note}</p>
      </div>
      <Link href={href} className="mt-1 flex shrink-0 items-center gap-0.5 text-[13px] font-semibold text-brand hover:underline">{link}<Icon.ChevronRight size={15} /></Link>
    </div>
  );
}

/** Spaces live right now, as a row of avatars above everything else. */
function LiveStrip({ streams, label }: { streams: LiveInfo[]; label: string }) {
  if (!streams.length) return null;
  return (
        <section aria-label={label} className="mb-4 flex items-center gap-3 overflow-x-auto [scrollbar-width:none]">
          <Link href="/live" className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#e5484d] px-3 py-1.5 text-[13px] font-extrabold uppercase tracking-wide text-white"><span className="h-2 w-2 animate-pulse rounded-full bg-white" />{label}</Link>
          {streams.slice(0, 12).map((l) => (
            <Link key={l.id} href={`/live/${l.id}`} className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-elevated py-1 pl-1 pr-3 hover:border-[#e5484d]">
              <span className="rounded-full ring-2 ring-[#e5484d] ring-offset-1 ring-offset-bg"><Avatar name={l.channel.name} src={l.channel.avatarUrl} size={28} /></span>
              <span className="max-w-[180px] truncate text-[13px] font-semibold">{l.channel.name}<span className="font-normal text-muted"> · {l.title}</span></span>
            </Link>
          ))}
        </section>
  );
}
