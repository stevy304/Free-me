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
import type { Key } from '@/i18n';

interface Me { premium: { active: boolean; until: string | null; admin?: boolean }; payments: Payment[] }

const PERKS = [
  { icon: 'badge', title: 'premium.badge', text: 'premium.badgeText' },
  { icon: Icon.Wallet, title: 'premium.earn', text: 'premium.earnText' },
  { icon: Icon.Live, title: 'premium.live', text: 'premium.liveText' },
  { icon: Icon.Hub, title: 'premium.dash', text: 'premium.dashText' },
  { icon: Icon.Upload, title: 'premium.uploads', text: 'premium.uploadsText' },
] as const;

const PURPOSE: Record<Payment['purpose'], Key> = { PREMIUM: 'premium.pPro', AD_CAMPAIGN: 'premium.pAds', CREATOR_PASS: 'hub.creatorPass', PLUS: 'premium.pPlus', FAMILY: 'premium.pFamily', VERIFICATION: 'premium.pVerified', CREATOR_SUPPORT: 'premium.pSupport' };
const STATUS: Record<Payment['status'], Key> = { PENDING: 'premium.sWaiting', SUCCEEDED: 'premium.sPaid', FAILED: 'premium.sNotPaid' };

export function PremiumView({ viewer }: { viewer: Viewer }) {
  const { locale, t } = useShell();
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
    if (p.status === 'SUCCEEDED') { setNotice(t('premium.welcome')); setExtend(false); void load(); router.refresh(); }
    else setError(p.failureReason ?? t('pay.failed'));
  }, [load, router, t]);
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
      <h2 id="premium-availability" className="font-display text-lg font-bold">{t('premium.unavailable')}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{t('premium.unavailableText')}</p>
    </section>
  ) : (
    <div className="self-start rounded-3xl border border-line bg-elevated p-5 sm:p-6">
      <p className="font-display text-[18px] font-bold">{active ? t('plans.addTime') : t('premium.chooseHowLong')}</p>
      <div role="radiogroup" aria-label={t('plans.length')} className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {plans.premium.months.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => setMonths(m)}
            className={`rounded-2xl border-2 px-3 py-2.5 text-left ${months === m ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
            <span className="block text-[15px] font-bold">{t(m === 1 ? 'plans.month.one' : 'plans.month.other', { count: m })}</span>
            <span className="block text-[13px] text-muted">{usd(plans.premium.usdCents * m, locale)}</span>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <PayPanel usdCents={plans.premium.usdCents * months} plans={plans} label={active ? t('premium.extendPremium') : t('premium.getPremium')} onPaid={paid} pending={me.payments.find((p) => p.status === 'PENDING' && p.method === 'manual' && p.purpose === 'PREMIUM') ?? null}
          start={async (method, phone) => (await api<{ payment: Payment }>('/billing/premium', { body: { method, phone, months } })).payment} />
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      {notice && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand"><Icon.CheckCircle size={20} filled />{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
      {watching?.status === 'PENDING' && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-[14px]"><Icon.Spinner size={18} className="animate-spin" />{t('plans.confirming')}</p>}

      <section className="relative overflow-hidden rounded-2xl bg-[#071312] px-6 py-8 text-white sm:px-10 sm:py-10">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,#2bc4b8_0%,transparent_65%)] opacity-40" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 left-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,#f2a93b_0%,transparent_65%)] opacity-25" />
        <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center">
          <VerifiedBadge size={72} kind="premium" />
          <div className="flex-1">
            <p className="text-[13px] font-bold uppercase tracking-[0.18em] text-[#ffd88a]">Free Me Premium</p>
            {active ? (
              <>
                <h1 className="mt-1 flex items-center gap-2 font-display text-[30px] font-extrabold leading-tight sm:text-[38px]">{name}<VerifiedBadge size={28} kind="premium" /></h1>
                <p className="mt-1 text-[15px] text-[#c9d6d4]">{until && until.getTime() > Date.now() ? <>{t('premium.memberUntil')} <b className="text-white">{until.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}</b> · {t(daysLeft === 1 ? 'premium.daysLeft.one' : 'premium.daysLeft.other', { count: daysLeft })}</> : t('premium.adminIncluded')}</p>
              </>
            ) : (
              <>
                <h1 className="mt-1 font-display text-[30px] font-extrabold leading-tight sm:text-[40px]">{t('premium.forCreators')}</h1>
                <p className="mt-2 text-[16px] text-[#c9d6d4]"><b className="text-[22px] text-white">{usd(plans.premium.usdCents, locale)}</b> {t('premium.perMonth')}{plans.premium.country ? <> · {t('premium.yourPriceIn')} {(() => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(plans.premium.country!) ?? plans.premium.country; } catch { return plans.premium.country; } })()}</> : null}.</p>
              </>
            )}
          </div>
          {active && canPay && !extend && <button type="button" onClick={() => setExtend(true)} className="h-11 rounded-2xl bg-white px-5 text-[14px] font-bold text-[#071312] hover:bg-[#e9efee]">{t('premium.extend')}</button>}
        </div>
      </section>

      {active ? (
        <>
          {extend && <div className="mt-6">{checkout}</div>}
          <h2 className="mt-8 font-display text-[20px] font-bold">{t('premium.yourTools')}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { href: '/hub?tab=money', icon: Icon.Wallet, title: t('hub.tabMoney'), text: t('premium.toolMoney') },
              { href: '/studio/live', icon: Icon.Live, title: 'Signal Room', text: t('premium.toolLive') },
              { href: '/hub', icon: Icon.Hub, title: t('watch.creatorHub'), text: t('premium.toolHub') },
              { href: '/studio/ads', icon: Icon.Megaphone, title: 'Ad Studio', text: t('premium.toolAds') },
            ].map((x) => (
              <Link key={x.href} href={x.href} className="group rounded-3xl border border-line bg-elevated p-5 hover:border-brand">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-soft text-brand"><x.icon size={22} /></span>
                <p className="mt-3 font-display text-[17px] font-bold">{x.title}</p>
                <p className="text-[14px] text-muted">{x.text}</p>
              </Link>
            ))}
          </div>
          {!viewer.channel && <p className="mt-4 rounded-2xl bg-accent-soft px-4 py-3 text-[14px] text-on-accent-soft">{t('premium.createSpaceHint')} <Link href="/channel/create" className="font-bold underline">{t('premium.createSpace')}</Link></p>}
        </>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_420px]">
          <ul className="grid content-start gap-3 sm:grid-cols-2">
            {PERKS.map((p) => (
              <li key={p.title} className="rounded-3xl border border-line bg-elevated p-5">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-soft text-brand">{p.icon === 'badge' ? <VerifiedBadge size={26} kind="premium" /> : <p.icon size={22} />}</span>
                <p className="mt-3 font-display text-[17px] font-bold">{t(p.title)}</p>
                <p className="mt-1 text-[14px] leading-relaxed text-muted">{t(p.text)}</p>
              </li>
            ))}
          </ul>
          {checkout}
        </div>
      )}

      {me.payments.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-[20px] font-bold">{t('premium.payments')}</h2>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-line">
            <table className="w-full min-w-[560px] text-left text-[14px]">
              <thead className="bg-surface text-[12px] uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">{t('hub.colDate')}</th><th className="px-4 py-3">{t('premium.colFor')}</th><th className="px-4 py-3">{t('premium.colHow')}</th><th className="px-4 py-3">{t('premium.colAmount')}</th><th className="px-4 py-3">{t('hub.colStatus')}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {me.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-muted">{new Date(p.createdAt).toLocaleDateString(locale)}</td>
                    <td className="px-4 py-3">{t(PURPOSE[p.purpose])}{p.months ? `, ${t(p.months === 1 ? 'plans.month.one' : 'plans.month.other', { count: p.months })}` : ''}</td>
                    <td className="px-4 py-3">{p.method === 'mtn_momo' ? 'MTN MoMo' : p.method === 'airtel_money' ? 'Airtel Money' : p.method === 'manual' ? t('premium.byHand') : t('pay.card')}</td>
                    <td className="px-4 py-3 tabular-nums">{money(p.amount, p.currency, locale)}</td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${p.status === 'SUCCEEDED' ? 'bg-brand-soft text-brand' : p.status === 'FAILED' ? 'bg-danger/10 text-danger' : 'bg-surface'}`} title={p.failureReason ?? undefined}>{t(STATUS[p.status])}</span></td>
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
