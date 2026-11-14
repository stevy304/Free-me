'use client';

import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { usd } from '@/lib/money';
import { useT } from '@/components/shell/ShellContext';
import type { Key } from '@/i18n';

/** A money amount that counts up (or down) smoothly to each new value, like a meter. Still for reduced motion. */
export function AnimatedMoney({ cents, locale, className = '' }: { cents: number; locale: string; className?: string }) {
  const [shown, setShown] = useState(cents);
  const from = useRef(cents);
  useEffect(() => {
    const start = from.current;
    if (start === cents || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { from.current = cents; setShown(cents); return; }
    const t0 = performance.now();
    const ms = 1600;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(start + (cents - start) * eased);
      setShown(v); from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return <span className={`tabular-nums ${className}`} aria-live="polite">{usd(shown, locale)}</span>;
}

export interface Audience {
  watchHours365: number; watchHours28: number; watchHoursToday: number; views365: number; views28: number; followers: number;
  momentViews90?: number;
  required: { watchHours: number; followers: number; momentViews?: number }; meetsRequirements: boolean;
}

/**
 * Today's earnings, live: the estimate for today counts up as ads play on the creator's videos (refreshed every 15 s
 * by the page), with what came in since the page was opened, the balance and lifetime earnings beside it.
 */
export function EarningsHero({ todayCents, impressions, availableCents, lifetimeCents, earning, locale, daily }: {
  todayCents: number | null; impressions: number; availableCents: number; lifetimeCents: number; earning: boolean; locale: string; daily: Array<{ day: string; cents: number }>;
}) {
  const t = useT();
  const opened = useRef<number | null>(null);
  if (opened.current === null && todayCents !== null) opened.current = todayCents;
  const since = todayCents !== null && opened.current !== null ? Math.max(0, todayCents - opened.current) : 0;
  const max = Math.max(1, ...daily.map((d) => d.cents), todayCents ?? 0);
  return (
    <section aria-labelledby="today-heading" className="overflow-hidden rounded-3xl bg-[#071312] text-white">
      <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1fr_auto]">
        <div>
          <h3 id="today-heading" className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-[#9fd8d2]">
            {earning ? <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full rounded-full bg-[#22ada2] opacity-75 motion-safe:animate-ping" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#22ada2]" /></span> : <span className="h-2.5 w-2.5 rounded-full bg-white/30" />}
            {t('money.earnedToday')}
          </h3>
          <p className="mt-2 font-display text-[44px] font-extrabold leading-none sm:text-[56px]">{todayCents === null ? '—' : <AnimatedMoney cents={todayCents} locale={locale} />}</p>
          <p className="mt-2 text-[14px] text-[#c9d6d4]">
            {t(impressions === 1 ? 'money.adsShown.one' : 'money.adsShown.other', { count: impressions.toLocaleString(locale) })}
            {since > 0 && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[#22ada2]/20 px-2 py-0.5 text-[12px] font-bold text-[#7ff3e8]"><Icon.ChevronUp size={14} />{t('money.sinceOpened', { amount: usd(since, locale) })}</span>}
          </p>
          <p className="mt-1 text-[12px] text-white/50">{t('money.estimate')}</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 self-start lg:w-[300px]">
          <div className="rounded-2xl bg-white/[0.06] p-4"><dt className="text-[12px] text-white/60">{t('money.available')}</dt><dd className="font-display text-[22px] font-bold"><AnimatedMoney cents={availableCents} locale={locale} /></dd></div>
          <div className="rounded-2xl bg-white/[0.06] p-4"><dt className="text-[12px] text-white/60">{t('money.allTime')}</dt><dd className="font-display text-[22px] font-bold"><AnimatedMoney cents={lifetimeCents} locale={locale} /></dd></div>
        </dl>
      </div>
      {daily.length > 0 && (
        <div className="border-t border-white/10 px-5 pb-4 pt-3 sm:px-7">
          <p className="text-[12px] text-white/50">{t('money.lastDays', { count: daily.length + 1 })}</p>
          <div className="mt-2 flex h-16 items-end gap-1" role="img" aria-label={t('money.dailyAria', { count: daily.length + 1 })}>
            {daily.map((d) => <div key={d.day} title={`${d.day}: ${usd(d.cents, locale)}`} className="flex-1 rounded-t bg-[#22ada2]/45" style={{ height: `${Math.max(4, (d.cents / max) * 100)}%` }} />)}
            <div title={`${t('money.today')}: ${usd(todayCents ?? 0, locale)}`} className="flex-1 rounded-t bg-[#f5c46b] transition-[height] duration-700" style={{ height: `${Math.max(4, ((todayCents ?? 0) / max) * 100)}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Watch hours, views and followers, with progress towards what joining needs (when the operator sets a minimum). */
export function WatchHours({ a, locale, joined }: { a: Audience; locale: string; joined: boolean }) {
  const t = useT();
  const n = (x: number, digits = 0) => x.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  const bars: Array<[Key, number, number]> = [];
  // Like YouTube: the followers, and either the watch hours (12 months) or the Moments views (90 days).
  if (!joined && a.required.followers > 0) bars.push(['money.followers', a.followers, a.required.followers]);
  if (!joined && a.required.watchHours > 0) bars.push(['money.hours12', a.watchHours365, a.required.watchHours]);
  if (!joined && a.required.watchHours > 0 && (a.required.momentViews ?? 0) > 0) bars.push(['money.momentViews90', a.momentViews90 ?? 0, a.required.momentViews!]);
  return (
    <section aria-labelledby="watch-heading" className="rounded-3xl border border-line bg-elevated p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="watch-heading" className="flex items-center gap-2 font-display text-[18px] font-bold"><Icon.Clock size={20} />{t('money.watchHours')}</h3>
        <span className="text-[12px] text-muted">{t('money.counted')}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {([['money.last12', `${n(a.watchHours365, 1)} h`], ['money.last28', `${n(a.watchHours28, 1)} h`], ['money.today', `${n(a.watchHoursToday, 1)} h`], ['money.views28', n(a.views28)], ['money.followers', n(a.followers)]] as const).map(([l, v]) => (
          <div key={l} className="rounded-2xl bg-surface p-4"><dt className="text-[12px] text-muted">{t(l)}</dt><dd className="font-display text-[22px] font-bold tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {bars.length > 0 && (
        <div className="mt-5 space-y-3">
          <p className="text-[14px] font-semibold">{a.meetsRequirements ? t('money.meets') : t('money.toJoin')}</p>
          {bars.map(([label, have, need]) => (
            <div key={label}>
              {label === 'money.momentViews90' && <p className="mb-2 text-center text-[12px] font-semibold uppercase tracking-wide text-muted">{t('money.or')}</p>}
              <div className="flex justify-between text-[13px]"><span>{t(label)}</span><span className="tabular-nums text-muted">{n(have, 1)} / {n(need)}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface"><div className={`h-full rounded-full ${have >= need ? 'bg-brand' : 'bg-accent'}`} style={{ width: `${Math.min(100, (have / need) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
