'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { PayPanel, usePaymentWatch } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { money, usd } from '@/lib/money';
import type { Payment, Plans, Viewer } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';

interface Me { premium: { active: boolean; until: string | null; admin?: boolean }; payments: Payment[] }

const PERKS = [
  { icon: 'badge', title: 'Verified badge', text: 'Show the Free Me seal on your Space, videos and conversations.' },
  { icon: Icon.Wallet, title: 'Earn from your videos', text: 'Eligible creators share 60% of daily ad revenue based on the ads shown on their videos.' },
  { icon: Icon.Live, title: 'Live Studio', text: 'Stream with OBS or a hardware encoder, and manage your broadcast from Live Studio.' },
  { icon: Icon.Hub, title: 'Premium dashboard', text: 'Your membership, earnings, withdrawals and tools in one place.' },
] as const;

const PURPOSE: Record<Payment['purpose'], string> = { PREMIUM: 'Premium', AD_CAMPAIGN: 'Ad campaign', AD_BADGE: 'Advertiser badge' };
const STATUS: Record<Payment['status'], string> = { PENDING: 'Waiting', SUCCEEDED: 'Paid', FAILED: 'Not paid' };

export function PremiumView({ viewer }: { viewer: Viewer }) {
  const { locale } = useShell();
  const router = useRouter();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plans | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [months, setMonths] = useState(1);
  const [extend, setExtend] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const [p, m] = await Promise.all([api<Plans>('/billing/plans'), api<Me>('/billing/me')]); setPlans(p); setMe(m); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const paid = useCallback((p: Payment) => {
    if (p.status === 'SUCCEEDED') { setNotice('Welcome to Premium. Your verified badge is on.'); setExtend(false); void load(); router.refresh(); }
    else setError(p.failureReason ?? 'The payment did not go through.');
  }, [load, router]);
  // Back from the card checkout: follow that payment.
  const { watching, watch } = usePaymentWatch(paid);
  useEffect(() => {
    const id = params.get('payment');
    if (id && !watching) api<{ payment: Payment }>(`/billing/payments/${id}`).then((r) => (r.payment.status === 'PENDING' ? watch(r.payment) : paid(r.payment))).catch(() => undefined);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && (!plans || !me)) return <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p>;
  if (!plans || !me) return <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const active = me.premium.active;
  const canPay = plans.methods.length > 0;
  const until = me.premium.until ? new Date(me.premium.until) : null;
  const daysLeft = until ? Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86_400_000)) : 0;
  const name = viewer.channel?.name ?? viewer.profile?.displayName ?? viewer.user.email;

  const checkout = !canPay ? (
    <section className="self-start rounded-3xl border border-line bg-elevated p-5 sm:p-6" aria-labelledby="premium-availability">
      <h2 id="premium-availability" className="font-display text-lg font-bold">Checkout is temporarily unavailable</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">Premium purchases will be available once payments are set up.</p>
    </section>
  ) : (
    <div className="self-start rounded-3xl border border-line bg-elevated p-5 sm:p-6">
      <p className="font-display text-[18px] font-bold">{active ? 'Add more time' : 'Choose how long'}</p>
      <div role="radiogroup" aria-label="Length" className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {plans.premium.months.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => setMonths(m)}
            className={`rounded-2xl border-2 px-3 py-2.5 text-left ${months === m ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
            <span className="block text-[15px] font-bold">{m} {m === 1 ? 'month' : 'months'}</span>
            <span className="block text-[13px] text-muted">{usd(plans.premium.usdCents * m, locale)}</span>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <PayPanel usdCents={plans.premium.usdCents * months} plans={plans} label={active ? 'Extend Premium' : 'Get Premium'} onPaid={paid} pending={me.payments.find((p) => p.status === 'PENDING' && p.method === 'manual' && p.purpose === 'PREMIUM') ?? null}
          start={async (method, phone) => (await api<{ payment: Payment }>('/billing/premium', { body: { method, phone, months } })).payment} />
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      {notice && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand"><Icon.CheckCircle size={20} filled />{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
      {watching?.status === 'PENDING' && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-[14px]"><Icon.Spinner size={18} className="animate-spin" />Confirming your payment…</p>}

      <section className="relative overflow-hidden rounded-[28px] bg-[#071312] px-6 py-8 text-white sm:px-10 sm:py-10">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,#2bc4b8_0%,transparent_65%)] opacity-40" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 left-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,#f2a93b_0%,transparent_65%)] opacity-25" />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center">
          <VerifiedBadge size={72} label="Free Me verified seal" />
          <div className="flex-1">
            <p className="text-[13px] font-bold uppercase tracking-[0.18em] text-[#ffd88a]">Free Me Premium</p>
            {active ? (
              <>
                <h1 className="mt-1 flex items-center gap-2 font-display text-[30px] font-extrabold leading-tight sm:text-[38px]">{name}<VerifiedBadge size={28} /></h1>
                <p className="mt-1 text-[15px] text-[#c9d6d4]">{until && until.getTime() > Date.now() ? <>Member until <b className="text-white">{until.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}</b> · {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left</> : 'Every Premium feature is included with your administrator account.'}</p>
              </>
            ) : (
              <>
                <h1 className="mt-1 font-display text-[30px] font-extrabold leading-tight sm:text-[40px]">Premium for creators</h1>
                <p className="mt-2 text-[16px] text-[#c9d6d4]"><b className="text-[22px] text-white">{usd(plans.premium.usdCents, locale)}</b> per month.</p>
              </>
            )}
          </div>
          {active && canPay && !extend && <button type="button" onClick={() => setExtend(true)} className="h-11 rounded-2xl bg-white px-5 text-[14px] font-bold text-[#071312] hover:bg-[#e9efee]">Extend</button>}
        </div>
      </section>

      {active ? (
        <>
          {extend && <div className="mt-6">{checkout}</div>}
          <h2 className="mt-8 font-display text-[20px] font-bold">Your tools</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { href: '/hub?tab=money', icon: Icon.Wallet, title: 'Monetisation', text: 'Earnings and withdrawals' },
              { href: '/studio/live', icon: Icon.Live, title: 'Live Studio', text: 'Go live now' },
              { href: '/hub', icon: Icon.Hub, title: 'Creator Hub', text: 'Videos, Moments, podcasts' },
              { href: '/studio/ads', icon: Icon.Megaphone, title: 'Ad Studio', text: 'Upload and run video ads' },
            ].map((t) => (
              <Link key={t.href} href={t.href} className="group rounded-3xl border border-line bg-elevated p-5 hover:border-brand">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-soft text-brand"><t.icon size={22} /></span>
                <p className="mt-3 font-display text-[17px] font-bold">{t.title}</p>
                <p className="text-[14px] text-muted">{t.text}</p>
              </Link>
            ))}
          </div>
          {!viewer.channel && <p className="mt-4 rounded-2xl bg-accent-soft px-4 py-3 text-[14px] text-on-accent-soft">Create your Space to show the badge and earn: <Link href="/channel/create" className="font-bold underline">Create your Space</Link></p>}
        </>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_420px]">
          <ul className="grid content-start gap-3 sm:grid-cols-2">
            {PERKS.map((p) => (
              <li key={p.title} className="rounded-3xl border border-line bg-elevated p-5">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-soft text-brand">{p.icon === 'badge' ? <VerifiedBadge size={26} /> : <p.icon size={22} />}</span>
                <p className="mt-3 font-display text-[17px] font-bold">{p.title}</p>
                <p className="mt-1 text-[14px] leading-relaxed text-muted">{p.text}</p>
              </li>
            ))}
          </ul>
          {checkout}
        </div>
      )}

      {me.payments.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-[20px] font-bold">Payments</h2>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-line">
            <table className="w-full min-w-[560px] text-left text-[14px]">
              <thead className="bg-surface text-[12px] uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">For</th><th className="px-4 py-3">How</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th></tr></thead>
              <tbody className="divide-y divide-line">
                {me.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-muted">{new Date(p.createdAt).toLocaleDateString(locale)}</td>
                    <td className="px-4 py-3">{PURPOSE[p.purpose]}{p.months ? `, ${p.months} ${p.months === 1 ? 'month' : 'months'}` : ''}</td>
                    <td className="px-4 py-3">{p.method === 'mtn_momo' ? 'MTN MoMo' : 'Card'}</td>
                    <td className="px-4 py-3 tabular-nums">{money(p.amount, p.currency, locale)}</td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${p.status === 'SUCCEEDED' ? 'bg-brand-soft text-brand' : p.status === 'FAILED' ? 'bg-danger/10 text-danger' : 'bg-surface'}`} title={p.failureReason ?? undefined}>{STATUS[p.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
