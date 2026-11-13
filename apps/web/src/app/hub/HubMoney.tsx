'use client';

import { CreatorSupport } from '@/components/billing/CreatorSupport';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { HubPayouts, type Withdrawal } from '@/components/hub/HubPayouts';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { api } from '@/lib/client-api';
import { usd } from '@/lib/money';
import { useShell } from '@/components/shell/ShellContext';
import { EarningsHero, WatchHours, type Audience } from '@/components/hub/MoneyLive';

interface Money {
  premium: { active: boolean; until: string | null }; joined: boolean; joinedAt: string | null; earning: boolean;
  balance: { currency: string; availableCents: number; lifetimeCents: number; withdrawnCents: number; reservedCents: number; paidCents: number; pendingCents: number }; adsShownLast28Days: number;
  audience?: Audience;
  earnings: Array<{ id: string; kind: string; amountCents: number; day: string | null; description: string; at: string }>;
  payouts: Withdrawal[];
  programme: { maxAdsPerVideo: number; payoutMinimumUsdCents: number; premiumUsdCents: number };
}
interface Earn {
  day: string;
  estimatedCents: number;
  impressions: number;
  activity: Array<{ campaignId: string; campaign: string; videoId: string; video: string; impressions: number }>;
}



/** Creator Hub → Monetisation: joining (Premium members), balance, daily earnings, withdrawals to MoMo, and how the money is shared. */
export function HubMoney() {
  const { locale, viewer, t } = useShell();
  const [m, setM] = useState<Money | null>(null);
  const [earn, setEarn] = useState<Earn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Estimator inputs: how many ads run on Free Me each day, and your share of the ads shown.

  const load = useCallback(async () => { try { setM(await api<Money>('/hub/monetisation')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!m?.joined) return;
    let active = true;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const next = await api<Earn>('/hub/monetisation/earn');
        if (active) setEarn(next);
      } catch {
        if (active) setEarn(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [m?.joined]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  const daily = (() => {
    if (!m) return [];
    const today = new Date().toISOString().slice(0, 10);
    const days = Array.from({ length: 13 }, (_, i) => new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10));
    const by = new Map<string, number>();
    for (const e of m.earnings) {
      if (e.amountCents <= 0) continue;
      const d = (e.day && /^\d{4}-\d{2}-\d{2}/.test(e.day) ? e.day : e.at).slice(0, 10);
      if (d !== today) by.set(d, (by.get(d) ?? 0) + e.amountCents);
    }
    return m.earnings.length ? days.map((d) => ({ day: d, cents: by.get(d) ?? 0 })) : [];
  })();

  if (!m) return error ? <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  const p = m.programme;

  return (
    <div className="mt-6 space-y-6">
      {error && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      <p className="rounded-2xl border border-line bg-elevated p-4 text-sm text-muted">{t('money.pilot1')} <Link href="/earn/availability" className="font-semibold text-brand underline">{t('money.pilotLink')}</Link> {t('money.pilot2')}</p>
      {!m.premium.active ? (
        <section className="flex flex-col gap-4 rounded-3xl bg-[#071312] p-6 text-white sm:flex-row sm:items-center">
          <VerifiedBadge size={52} kind="premium" />
          <div className="flex-1"><p className="font-display text-[22px] font-extrabold">{t('money.partOfPremium')}</p><p className="text-[15px] text-[#c9d6d4]">{t('money.premiumPitch', { price: usd(p.premiumUsdCents, locale) })}</p></div>
          <Link href="/premium" className="flex h-11 items-center gap-2 rounded-2xl bg-gradient-to-r from-[#f5b95c] to-[#e39a2a] px-5 text-[14px] font-bold text-[#2a1a02]"><Icon.PremiumStar size={18} filled />{t('money.upgrade')}</Link>
        </section>
      ) : !m.joined ? (
        <section className="rounded-3xl border-2 border-brand bg-elevated p-6">
          <p className="font-display text-[22px] font-extrabold">{t('money.start')}</p>
          <ul className="mt-3 space-y-1.5 text-[15px] text-muted">
            <li className="flex gap-2"><Icon.Check size={20} className="shrink-0 text-brand" />{t('money.rule1', { max: p.maxAdsPerVideo })}</li>
            <li className="flex gap-2"><Icon.Check size={20} className="shrink-0 text-brand" />{t('money.rule2')}</li>
            <li className="flex gap-2"><Icon.Check size={20} className="shrink-0 text-brand" />{t('money.rule3', { min: usd(p.payoutMinimumUsdCents, locale) })}</li>
            <li className="flex gap-2"><Icon.Check size={20} className="shrink-0 text-brand" />{t('money.rule4')}</li>
          </ul>
          <button type="button" disabled={busy} onClick={() => void run(() => api('/hub/monetisation/join', { body: {} }))} className="mt-4 h-11 rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">{t('money.join')}</button>
        </section>
      ) : (
        <>
          {!m.earning && <p className="rounded-2xl bg-accent-soft px-4 py-3 text-[14px] text-on-accent-soft">{t('money.ended1')} <Link href="/premium" className="font-bold underline">{t('money.renew')}</Link> {t('money.ended2')}</p>}
          <EarningsHero todayCents={earn ? earn.estimatedCents : null} impressions={earn?.impressions ?? 0} availableCents={m.balance.availableCents} lifetimeCents={m.balance.lifetimeCents} earning={m.earning} locale={locale} daily={daily} />
          {earn && earn.activity.length > 0 && (
            <section className="rounded-3xl border border-line bg-elevated p-5 sm:p-6" aria-labelledby="activity-heading">
              <h3 id="activity-heading" className="font-display text-[18px] font-bold">{t('money.adsToday')}</h3>
              <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-sm">
                <thead className="text-muted"><tr><th scope="col" className="py-2 pr-3">{t('money.colAd')}</th><th scope="col" className="py-2 pr-3">{t('money.colOnVideo')}</th><th scope="col" className="py-2 text-right">{t('money.colShown')}</th></tr></thead>
                <tbody className="divide-y divide-line">{earn.activity.map((row) => <tr key={`${row.campaignId}:${row.videoId}`}><td className="py-2 pr-3">{row.campaign}</td><td className="py-2 pr-3">{row.video}</td><td className="py-2 text-right tabular-nums">{row.impressions.toLocaleString(locale)}</td></tr>)}</tbody>
              </table></div>
            </section>
          )}

        </>
      )}

      {m.audience && <WatchHours a={m.audience} locale={locale} joined={m.joined} />}

      {viewer?.channel && <CreatorSupport handle={viewer.channel.handle} owner />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[[t('money.available'), m.balance.availableCents], [t('money.pending'), m.balance.pendingCents ?? 0], [t('money.inWithdrawal'), m.balance.reservedCents ?? 0], [t('premium.sPaid'), m.balance.paidCents ?? 0]].map(([l, v]) => (
              <div key={l as string} className="rounded-3xl border border-line bg-elevated p-5"><p className="text-[13px] text-muted">{l}</p><p className="font-display text-[26px] font-extrabold tabular-nums">{usd(v as number, locale)}</p></div>
            ))}

          </div>
          <section className="rounded-3xl border border-line bg-elevated p-5 sm:p-6">
            <h3 className="font-display text-[18px] font-bold">{t('money.earnings')}</h3>
            {m.earnings.length ? (
              <ul className="mt-2 divide-y divide-line text-[14px]">
                {m.earnings.map((e) => <li key={e.id} className="flex gap-3 py-2"><span className="flex-1">{e.description}</span><span className={`tabular-nums font-semibold ${e.amountCents < 0 ? 'text-muted' : 'text-brand'}`}>{e.amountCents < 0 ? '−' : '+'}{usd(Math.abs(e.amountCents), locale)}</span></li>)}
              </ul>
            ) : <p className="mt-1 text-[14px] text-muted">{t('money.noEarnings')}</p>}
          </section>
      <HubPayouts availableCents={m.balance.availableCents} minimumCents={p.payoutMinimumUsdCents} payouts={m.payouts} locale={locale} onChanged={load} />

      <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
        <h3 className="font-display text-[18px] font-bold">{t('money.whatEarns')}</h3>
        <ul className="mt-2 space-y-1.5 text-[14px] text-muted">
          <li className="flex gap-2"><Icon.Check size={18} className="mt-0.5 shrink-0 text-brand" />{t('money.tip1')}</li>
          <li className="flex gap-2"><Icon.Check size={18} className="mt-0.5 shrink-0 text-brand" />{t('money.tip2')}</li>
          <li className="flex gap-2"><Icon.Check size={18} className="mt-0.5 shrink-0 text-brand" />{t('money.tip3')}</li>
        </ul>
        <p className="mt-2 text-[12px] text-faint">{t('money.notGuaranteed')}</p>
      </section>
    </div>
  );
}
