import type { Metadata } from 'next';
import Link from 'next/link';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { apiGet, getLocale, getT, getViewer } from '@/lib/server-api';
import type { LiveInfo } from './types';

export async function generateMetadata(): Promise<Metadata> { return { title: (await getT())('live.title') }; }
export const dynamic = 'force-dynamic';

/** Spaces live right now, and streams planned for the coming week. */
export default async function LiveNow() {
  const [r, locale, viewer, t] = await Promise.all([apiGet<{ streams: LiveInfo[]; upcoming?: LiveInfo[] }>('/live'), getLocale(), getViewer(), getT()]);
  const streams = r?.streams ?? [];
  const upcoming = r?.upcoming ?? [];
  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-16 pt-6 sm:px-6">
      <h1 className="flex items-center gap-2 font-display text-[28px] font-extrabold"><Icon.Live size={28} className="text-[#e5484d]" />{t('live.title')}</h1>
      {streams.length ? (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {streams.map((s) => (
            <li key={s.id}>
              <Link href={`/live/${s.id}`} className="group block overflow-hidden rounded-3xl border border-line bg-elevated hover:border-[#e5484d]">
                <div className="relative grid aspect-video place-items-center bg-[radial-gradient(circle_at_30%_30%,#123b38,#0b0908)]">
                  <Avatar name={s.channel.name} src={s.channel.avatarUrl} size={72} />
                  <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-[#e5484d] px-2 py-0.5 text-[12px] font-extrabold uppercase text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />{t('live.badge')}</span>
                  <span className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-black/70 px-2 py-0.5 text-[12px] font-semibold text-white"><Icon.Eye size={14} />{s.viewers}</span>
                </div>
                <div className="p-4"><p className="truncate font-display text-[17px] font-bold">{s.title}</p><p className="flex items-center gap-1 text-[14px] text-muted">{s.channel.name}{s.channel.isVerified && <VerifiedBadge size={14} />}</p></div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-6 flex flex-col items-center rounded-3xl border border-dashed border-line px-6 py-14 text-center">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-[#e5484d]/10 text-[#e5484d]"><Icon.Live size={30} /></span>
          <h2 className="mt-4 font-display text-[20px] font-bold">{t('live.nobody')}</h2>
          <p className="mt-1 max-w-[440px] text-[15px] leading-relaxed text-muted">{t('live.nobodyText')}{upcoming.length ? ` ${t('live.seeUpcoming')}` : ''}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href={viewer?.channel ? '/go-live' : viewer ? '/channel/create' : '/login?returnTo=/go-live'} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#e5484d] px-5 text-[14px] font-bold text-white hover:bg-[#d13d42]"><Icon.Live size={18} />{t('live.goLive')}</Link>
            <Link href="/explore" className="inline-flex h-10 items-center rounded-xl border border-line px-5 text-[14px] font-semibold hover:bg-surface">{t('live.exploreVideos')}</Link>
          </div>
        </div>
      )}
      {upcoming.length > 0 && (
        <section aria-labelledby="upcoming" className="mt-10">
          <h2 id="upcoming" className="font-display text-[22px] font-bold">{t('live.upcoming')}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((s) => (
              <li key={s.id}>
                <Link href={`/live/${s.id}`} className="flex items-center gap-3 rounded-2xl border border-line bg-elevated p-4 hover:border-brand">
                  <Avatar name={s.channel.name} src={s.channel.avatarUrl} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{s.title}</span>
                    <span className="block truncate text-[13px] text-muted">{s.channel.name}</span>
                    <span className="mt-0.5 flex items-center gap-1 text-[13px] font-semibold text-brand" suppressHydrationWarning><Icon.Clock size={14} />{s.scheduledFor ? new Date(s.scheduledFor).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
