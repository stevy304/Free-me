'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { PayPanel, usePaymentWatch } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { usd } from '@/lib/money';
import type { Payment, Plans } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';

export interface PassStatus {
  pass: { active: boolean; until: string | null; includedWithPremium: boolean };
  canUpload: boolean; reason?: 'PASS_REQUIRED' | 'PASS_LIMIT' | null; freeVideos: number; freeLeft: number; uploads: number; usdCents: number; months: number[];
  videosPerYear?: number; uploadsLastYear?: number; passLeft?: number | null;
}

/** The Creator pass, a year at a time: after a Space's free videos, uploading needs it (Premium includes it, with no limit). */
export function PassView() {
  const { locale } = useShell();
  const router = useRouter();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plans | null>(null);
  const [status, setStatus] = useState<PassStatus | null>(null);
  const [months, setMonths] = useState(12);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const [p, s] = await Promise.all([api<Plans>('/billing/plans'), api<PassStatus>('/billing/creator-pass')]); setPlans(p); setStatus(s); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const paid = useCallback((p: Payment) => {
    if (p.status === 'SUCCEEDED') { setNotice('Your Creator pass is active. You can upload again.'); void load(); router.refresh(); }
    else setError(p.failureReason ?? 'The payment did not go through.');
  }, [load, router]);
  const { watching, watch } = usePaymentWatch(paid);
  useEffect(() => {
    const id = params.get('payment');
    if (id && !watching) api<{ payment: Payment }>(`/billing/payments/${id}`).then((r) => (r.payment.status === 'PENDING' ? watch(r.payment) : paid(r.payment))).catch(() => undefined);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && (!plans || !status)) return <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p>;
  if (!plans || !status) return <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const until = status.pass.until ? new Date(status.pass.until) : null;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:px-6">
      {notice && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand"><Icon.CheckCircle size={20} filled />{notice}</p>}
      {error && <p role="alert" className="mb-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
      {watching?.status === 'PENDING' && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-[14px]"><Icon.Spinner size={18} className="animate-spin" />Confirming your payment…</p>}

      <Link href="/hub" className="text-[14px] font-semibold text-brand">← Creator Hub</Link>
      <h1 className="mt-2 font-display text-[30px] font-extrabold">Creator pass</h1>
      <p className="mt-1 text-[16px] text-muted">
        <b className="text-ink">{usd(status.usdCents, locale)}</b> a year to keep uploading after your {status.freeVideos} free {status.freeVideos === 1 ? 'video' : 'videos'}.
        It pays for turning your uploads into every quality and keeping them stored.
      </p>

      <ul className="mt-4 space-y-2 text-[15px]">
        <li className="flex gap-2"><Icon.CheckCircle size={20} className="shrink-0 text-brand" />Upload up to {status.videosPerYear ?? 50} videos a year while the pass is active. Need more? <Link href="/premium" className="font-semibold text-brand">Pro</Link> has no limit.</li>
        <li className="flex gap-2"><Icon.CheckCircle size={20} className="shrink-0 text-brand" />Your videos stay online even if the pass ends; only new uploads need it.</li>
        <li className="flex gap-2"><Icon.CheckCircle size={20} className="shrink-0 text-brand" />Premium includes the pass, plus the Premium badge, earnings and Live Studio. <Link href="/premium" className="font-semibold text-brand">See Premium</Link></li>
      </ul>

      <section className="mt-6 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
        {status.pass.active ? (
          <p className="font-semibold">{status.pass.includedWithPremium ? 'Included with Pro, with no upload limit.' : <>Active until <b>{until?.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}</b>. {status.passLeft ?? 0} of {status.videosPerYear ?? 50} uploads left for the last 365 days.</>}</p>
        ) : status.freeLeft > 0 ? (
          <p className="font-semibold">{status.freeLeft} of {status.freeVideos} free {status.freeVideos === 1 ? 'video' : 'videos'} left. You can buy the pass now or when they are used.</p>
        ) : (
          <p className="font-semibold">Your free videos are used. Get the pass to upload again.</p>
        )}
        {!status.pass.includedWithPremium && plans.methods.length > 0 && (
          <>
            <div role="radiogroup" aria-label="Length" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {status.months.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => setMonths(m)}
                  className={`rounded-2xl border-2 px-3 py-2.5 text-left ${months === m ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
                  <span className="block text-[15px] font-bold">{m / 12} {m === 12 ? 'year' : 'years'}</span>
                  <span className="block text-[13px] text-muted">{usd(status.usdCents * (m / 12), locale)}</span>
                </button>
              ))}
            </div>
            <div className="mt-4">
              <PayPanel usdCents={status.usdCents * (months / 12)} plans={plans} label={status.pass.active ? 'Extend the pass' : 'Get the Creator pass'} onPaid={paid}
                start={async (method, phone) => (await api<{ payment: Payment }>('/billing/creator-pass', { body: { method, phone, months } })).payment} />
            </div>
          </>
        )}
        {!status.pass.includedWithPremium && plans.methods.length === 0 && <p className="mt-3 text-sm text-muted">Payments are not set up on this server yet.</p>}
      </section>
    </div>
  );
}
