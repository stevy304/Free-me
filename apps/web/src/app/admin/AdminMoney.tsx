'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';
import { duration } from '@/lib/format';
import { usd } from '@/lib/money';
import { useShell } from '@/components/shell/ShellContext';

interface Summary {
  premiumMembers: number; last30Days: { premiumUsdCents: number; adsUsdCents: number; payments: number }; waiting: { adReviews: number; payouts: number };
  settlements: Array<{ day: string; grossCents: number; creatorPoolCents: number; paidToCreatorsCents: number; impressions: number; channels: number }>; methods: Array<{ name: string; currency: string }>;
}
interface Review { id: string; businessName: string; email: string; country: string; headline: string; destinationUrl: string; days: number; totalCents: number; targetCountries: string[]; video: { id: string; title: string; durationSeconds: number } | null; createdAt: string }
interface Payout { id: string; amountCents: number; account: string; accountHolderName: string; status: string; requestedAt: string; channel: { handle: string; name: string } }

/** Administration → Money: income, ads waiting for review, withdrawals to send, and gifting Premium. */
export function AdminMoney() {
  const { locale } = useShell();
  const [s, setS] = useState<Summary | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [gift, setGift] = useState({ email: '', months: 1 });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([api<Summary>('/admin/billing'), api<{ campaigns: Review[] }>('/admin/billing/campaigns'), api<{ payouts: Payout[] }>('/admin/billing/payouts')]);
      setS(a); setReviews(b.campaigns); setPayouts(c.payouts);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, done: string) => { setError(null); setMsg(null); try { await fn(); setMsg(done); await load(); } catch (e) { setError((e as Error).message); } };

  if (!s) return error ? <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  return (
    <div className="mt-5 space-y-6">
      {msg && <p role="status" className="rounded-xl bg-brand-soft px-4 py-3 text-[14px] text-brand">{msg}</p>}
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      {!s.methods.length && <p className="rounded-xl bg-accent-soft px-4 py-3 text-[14px] text-on-accent-soft">No payment method is set up: add MTN MoMo (MOMO_*) and/or Flutterwave (FLW_*) keys to the API environment.</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        {[['Premium members', s.premiumMembers.toLocaleString(locale)], ['Premium, 30 days', usd(s.last30Days.premiumUsdCents, locale)], ['Ads sold, 30 days', usd(s.last30Days.adsUsdCents, locale)], ['Payments, 30 days', s.last30Days.payments.toLocaleString(locale)]].map(([l, v]) => (
          <div key={l} className="rounded-2xl border border-line p-4"><p className="text-[13px] text-muted">{l}</p><p className="font-display text-[24px] font-extrabold tabular-nums">{v}</p></div>
        ))}
      </div>

      <section>
        <h2 className="text-[18px] font-semibold">Ads waiting for review ({reviews.length})</h2>
        <div className="mt-2 space-y-2">
          {reviews.map((r) => (
            <article key={r.id} className="rounded-2xl border border-line p-4">
              <p className="font-semibold">{r.headline}</p>
              <p className="text-[13px] text-muted">{r.businessName} ({r.country}) · {r.email} · {r.days} days, {usd(r.totalCents, locale)} paid · {r.targetCountries.length ? r.targetCountries.join(', ') : 'every country'}</p>
              <p className="text-[13px]">Video: {r.video ? <a className="text-brand underline" href={`/watch?v=${r.video.id}`} target="_blank" rel="noreferrer">{r.video.title} ({duration(r.video.durationSeconds)})</a> : 'missing'} · Link: <a className="text-brand underline" href={r.destinationUrl} target="_blank" rel="noreferrer nofollow">{r.destinationUrl}</a></p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input className={`${inputClass} max-w-sm`} placeholder="Note (required to reject)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                <button type="button" onClick={() => void run(() => api(`/admin/billing/campaigns/${r.id}/review`, { body: { approve: true, note: notes[r.id] || undefined } }), 'Approved: it is running now.')} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand">Approve</button>
                <button type="button" onClick={() => void run(() => api(`/admin/billing/campaigns/${r.id}/review`, { body: { approve: false, note: notes[r.id] } }), 'Rejected.')} className="h-10 rounded-xl bg-danger/10 px-4 text-[14px] font-semibold text-danger">Reject</button>
              </div>
            </article>
          ))}
          {!reviews.length && <p className="text-[14px] text-muted">Nothing waiting.</p>}
        </div>
      </section>

      <section>
        <h2 className="text-[18px] font-semibold">Withdrawals to send ({payouts.length})</h2>
        <p className="text-[13px] text-muted">Send the amount by MTN MoMo (converted at the day’s rate), then enter the transfer reference.</p>
        <div className="mt-2 space-y-2">
          {payouts.map((p) => (
            <article key={p.id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-line p-4">
              <p className="flex-1 text-[14px]"><b className="tabular-nums">{usd(p.amountCents, locale)}</b> to <b>{p.account}</b> ({p.accountHolderName}) · {p.channel.name} @{p.channel.handle}</p>
              <input className={`${inputClass} max-w-[220px]`} placeholder="Reference or reason" value={notes[p.id] ?? ''} onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })} />
              <button type="button" onClick={() => void run(() => api(`/admin/billing/payouts/${p.id}`, { body: { action: 'paid', reference: notes[p.id] } }), 'Marked as sent.')} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand">Sent</button>
              <button type="button" onClick={() => void run(() => api(`/admin/billing/payouts/${p.id}`, { body: { action: 'reject', reason: notes[p.id] } }), 'Returned to the creator’s balance.')} className="h-10 rounded-xl bg-surface px-4 text-[14px] font-semibold">Return</button>
            </article>
          ))}
          {!payouts.length && <p className="text-[14px] text-muted">Nothing to send.</p>}
        </div>
      </section>

      <section>
        <h2 className="text-[18px] font-semibold">Ad revenue by day</h2>
        <div className="mt-2 overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[560px] text-left text-[14px]">
            <thead className="bg-surface text-[12px] uppercase tracking-wide text-muted"><tr><th className="px-4 py-2">Day</th><th className="px-4 py-2">Ads sold</th><th className="px-4 py-2">Creators’ 60%</th><th className="px-4 py-2">Paid to creators</th><th className="px-4 py-2">Ads shown</th><th className="px-4 py-2">Creators</th></tr></thead>
            <tbody className="divide-y divide-line">{s.settlements.map((d) => <tr key={d.day} className="tabular-nums"><td className="px-4 py-2">{d.day}</td><td className="px-4 py-2">{usd(d.grossCents, locale)}</td><td className="px-4 py-2">{usd(d.creatorPoolCents, locale)}</td><td className="px-4 py-2">{usd(d.paidToCreatorsCents, locale)}</td><td className="px-4 py-2">{d.impressions}</td><td className="px-4 py-2">{d.channels}</td></tr>)}</tbody>
          </table>
          {!s.settlements.length && <p className="px-4 py-6 text-center text-[14px] text-muted">No ad days settled yet.</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-line p-4">
        <h2 className="text-[18px] font-semibold">Give Premium</h2>
        <p className="text-[13px] text-muted">For partners, staff or prizes. The person must have signed in once.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inputClass} max-w-xs`} type="email" placeholder="Email address" value={gift.email} onChange={(e) => setGift({ ...gift, email: e.target.value })} />
          <select className={`${inputClass} w-36`} value={gift.months} onChange={(e) => setGift({ ...gift, months: Number(e.target.value) })}>{[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} {m === 1 ? 'month' : 'months'}</option>)}</select>
          <button type="button" disabled={!gift.email.includes('@')} onClick={() => void run(() => api('/admin/billing/premium', { body: gift }), `Premium given to ${gift.email}.`)} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Give Premium</button>
        </div>
      </section>
    </div>
  );
}
