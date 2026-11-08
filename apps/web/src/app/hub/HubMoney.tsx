'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';
import { usd } from '@/lib/money';
import { useShell } from '@/components/shell/ShellContext';

type Metric = 'followers' | 'views' | 'momentViews' | 'watchHours' | 'sparks';
const metrics: Record<Metric, string> = { followers: 'Followers', views: 'Public video views', momentViews: 'Public Moments views', watchHours: 'Public watch hours', sparks: 'Sparks' };

interface Money {
  eligibility: { current: Record<Metric, number>; required: Record<Metric, number>; canApply: boolean; pending: boolean; recentRemovals: number; rejectionReason: string | null };
  premium: { active: boolean; until: string | null }; joined: boolean; joinedAt: string | null; earning: boolean;
  balance: { currency: string; availableCents: number; lifetimeCents: number; withdrawnCents: number }; adsShownLast28Days: number;
  earnings: Array<{ id: string; kind: string; amountCents: number; day: string | null; description: string; at: string }>;
  payouts: Array<{ id: string; amountCents: number; account: string; status: string; reference: string | null; rejectionReason: string | null; requestedAt: string }>;
  programme: { creatorShareBps: number; adDayUsdCents: number; maxAdsPerVideo: number; payoutMinimumUsdCents: number; premiumUsdCents: number };
}
interface Earn {
  day: string;
  estimatedCents: number;
  impressions: number;
  activity: Array<{ campaignId: string; campaign: string; videoId: string; video: string; impressions: number }>;
}

const PAYOUT: Record<string, string> = { REQUESTED: 'On its way', UNDER_REVIEW: 'On its way', APPROVED: 'On its way', PAID: 'Sent', REJECTED: 'Returned to balance' };

/** Creator Hub → Monetisation: eligibility and applications, balance, daily earnings, withdrawals to MoMo, and how the money is shared. */
export function HubMoney() {
  const { locale } = useShell();
  const [m, setM] = useState<Money | null>(null);
  const [earn, setEarn] = useState<Earn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  // Estimator inputs: how many ads run on Free Me each day, and your share of the ads shown.
  const [campaigns, setCampaigns] = useState(100);
  const [share, setShare] = useState(1);

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

  if (!m) return error ? <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  const p = m.programme;
  const pct = p.creatorShareBps / 100;
  const poolPerDay = campaigns * p.adDayUsdCents * (p.creatorShareBps / 10_000);
  const yours = Math.floor(poolPerDay * (share / 100));

  return (
    <div className="mt-6 space-y-6">
      {error && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      {!m.joined ? (
        <section className="rounded-3xl border border-line bg-elevated p-6">
          <h3 className="font-display text-xl font-bold">Monetisation eligibility</h3>
          <p className="mt-1 text-sm text-muted">Build your audience to apply. Views, watch time and Sparks use the last 90 days.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(Object.keys(metrics) as Metric[]).map((key) => {
              const current = m.eligibility.current[key];
              const required = m.eligibility.required[key];
              return <div key={key}>
                <div className="flex justify-between gap-2 text-sm"><span>{metrics[key]}</span><span className="tabular-nums">{Math.floor(current).toLocaleString(locale)} / {required.toLocaleString(locale)}</span></div>
                <progress aria-label={metrics[key]} value={Math.min(current, required)} max={required} className="mt-2 w-full accent-[var(--brand)]" />
              </div>;
            })}
          </div>
          {m.eligibility.recentRemovals > 0 && <p className="mt-3 text-sm text-muted">You can apply 90 days after your most recent content removal.</p>}
          {m.eligibility.rejectionReason && <p className="mt-3 text-sm text-muted">{m.eligibility.rejectionReason}</p>}
          {m.eligibility.pending ? <p className="mt-4 font-semibold text-brand">Application under review</p> :
            <button type="button" disabled={busy || !m.eligibility.canApply} onClick={() => void run(() => api('/hub/monetisation/join', { body: {} }))} className="mt-4 h-11 rounded-2xl bg-brand px-5 text-sm font-bold text-on-brand disabled:opacity-50">Apply for monetisation</button>}
        </section>
      ) : (
        <>
          <section className="rounded-3xl border border-line bg-elevated p-5 sm:p-6" aria-labelledby="earn-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="earn-heading" className="font-display text-xl font-bold">Earn</h3>
              {earn && <span className="rounded-full bg-brand/10 px-3 py-1 text-sm font-semibold text-brand">Live estimate</span>}
            </div>
            {earn ? (
              <>
                <p className="mt-3 font-display text-3xl font-extrabold tabular-nums">{usd(earn.estimatedCents, locale)}</p>
                <p className="text-sm text-muted">Estimated ad earnings · {earn.impressions.toLocaleString(locale)} ads shown · {earn.day} UTC</p>
                <p className="mt-1 text-sm text-muted">Your estimate uses today’s {pct}% creator pool and can change before daily settlement.</p>
                <h4 className="mt-5 font-semibold">Campaign activity</h4>
                {earn.activity.length ? <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-sm">
                  <thead className="text-muted"><tr><th scope="col" className="py-2 pr-3">Campaign</th><th scope="col" className="py-2 pr-3">Video placement</th><th scope="col" className="py-2 text-right">Ads shown</th></tr></thead>
                  <tbody className="divide-y divide-line">{earn.activity.map((row) => <tr key={`${row.campaignId}:${row.videoId}`}><td className="py-2 pr-3">{row.campaign}</td><td className="py-2 pr-3">{row.video}</td><td className="py-2 text-right tabular-nums">{row.impressions.toLocaleString(locale)}</td></tr>)}</tbody>
                </table></div> : <p className="mt-1 text-sm text-muted">No ad activity today.</p>}
              </>
            ) : <p className="mt-2 text-sm text-muted">Live earnings are currently unavailable.</p>}
          </section>
          <div className="grid gap-3 sm:grid-cols-4">
            {[['Available', m.balance.availableCents], ['Earned in total', m.balance.lifetimeCents], ['Withdrawn', m.balance.withdrawnCents]].map(([l, v]) => (
              <div key={l as string} className="rounded-3xl border border-line bg-elevated p-5"><p className="text-[13px] text-muted">{l}</p><p className="font-display text-[26px] font-extrabold tabular-nums">{usd(v as number, locale)}</p></div>
            ))}
            <div className="rounded-3xl border border-line bg-elevated p-5"><p className="text-[13px] text-muted">Ads shown, 28 days</p><p className="font-display text-[26px] font-extrabold tabular-nums">{m.adsShownLast28Days.toLocaleString(locale)}</p></div>
          </div>
          <section className="rounded-3xl border border-line bg-elevated p-5 sm:p-6">
            <h3 className="font-display text-[18px] font-bold">Withdraw to MTN Mobile Money</h3>
            {m.balance.availableCents < p.payoutMinimumUsdCents ? (
              <p className="mt-1 text-[14px] text-muted">You can withdraw once your balance reaches {usd(p.payoutMinimumUsdCents, locale)}. Earnings are added every day for the day before.</p>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <label><span className="text-[13px] font-semibold">MoMo number</span><input className={`mt-1 ${inputClass}`} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="0788 123 456" /></label>
                <label><span className="text-[13px] font-semibold">Name on the account</span><input className={`mt-1 ${inputClass}`} value={name} onChange={(e) => setName(e.target.value)} /></label>
                <button type="button" disabled={busy || phone.length < 9 || name.trim().length < 2} onClick={() => void run(() => api('/hub/monetisation/payouts', { body: { phone, accountHolderName: name } }))} className="h-11 rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">Withdraw {usd(m.balance.availableCents, locale)}</button>
              </div>
            )}
            {m.payouts.length > 0 && (
              <ul className="mt-4 divide-y divide-line text-[14px]">
                {m.payouts.map((x) => <li key={x.id} className="flex flex-wrap gap-x-3 py-2"><span className="font-semibold tabular-nums">{usd(x.amountCents, locale)}</span><span className="text-muted">to {x.account}</span><span className={x.status === 'REJECTED' ? 'text-danger' : x.status === 'PAID' ? 'text-brand' : 'text-muted'}>{PAYOUT[x.status]}{x.reference ? ` · ${x.reference}` : ''}{x.rejectionReason ? ` · ${x.rejectionReason}` : ''}</span><span className="ml-auto text-faint">{new Date(x.requestedAt).toLocaleDateString(locale)}</span></li>)}
              </ul>
            )}
          </section>
          <section className="rounded-3xl border border-line bg-elevated p-5 sm:p-6">
            <h3 className="font-display text-[18px] font-bold">Earnings</h3>
            {m.earnings.length ? (
              <ul className="mt-2 divide-y divide-line text-[14px]">
                {m.earnings.map((e) => <li key={e.id} className="flex gap-3 py-2"><span className="flex-1">{e.description}</span><span className={`tabular-nums font-semibold ${e.amountCents < 0 ? 'text-muted' : 'text-brand'}`}>{e.amountCents < 0 ? '−' : '+'}{usd(Math.abs(e.amountCents), locale)}</span></li>)}
              </ul>
            ) : <p className="mt-1 text-[14px] text-muted">Your first earnings appear the day after ads play on your videos.</p>}
          </section>
        </>
      )}

      <section className="rounded-3xl border border-line bg-surface p-5 sm:p-6">
        <h3 className="font-display text-[18px] font-bold">How much can creators earn?</h3>
        <p className="mt-1 text-[14px] text-muted">Businesses pay {usd(p.adDayUsdCents, locale)} for each day an ad runs. Of that money, {pct}% goes to creators, {100 - pct - 10}% runs Free Me (servers, video delivery, support) and 10% is kept as a reserve. Move the sliders to estimate.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label><span className="text-[13px] font-semibold">Ads running on Free Me each day: {campaigns.toLocaleString(locale)}</span><input type="range" min={10} max={5000} step={10} value={campaigns} onChange={(e) => setCampaigns(Number(e.target.value))} className="mt-2 w-full accent-[var(--brand)]" /></label>
          <label><span className="text-[13px] font-semibold">Your share of all ads shown: {share}%</span><input type="range" min={0.1} max={20} step={0.1} value={share} onChange={(e) => setShare(Number(e.target.value))} className="mt-2 w-full accent-[var(--brand)]" /></label>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-elevated p-4"><dt className="text-[12px] text-muted">Creators share each day</dt><dd className="font-display text-[22px] font-extrabold tabular-nums">{usd(Math.floor(poolPerDay), locale)}</dd></div>
          <div className="rounded-2xl bg-elevated p-4"><dt className="text-[12px] text-muted">You, per day</dt><dd className="font-display text-[22px] font-extrabold tabular-nums">{usd(yours, locale)}</dd></div>
          <div className="rounded-2xl bg-elevated p-4"><dt className="text-[12px] text-muted">You, per month (30 days)</dt><dd className="font-display text-[22px] font-extrabold tabular-nums text-brand">{usd(yours * 30, locale)}</dd></div>
        </dl>
        <p className="mt-2 text-[12px] text-faint">An estimate, not a promise: real earnings depend on how many businesses advertise and how many ads play on your videos.</p>
      </section>
    </div>
  );
}
