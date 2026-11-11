'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import type { Payment, Plans } from '@/lib/types';
import { usd } from '@/lib/money';
import { useShell } from '@/components/shell/ShellContext';
import { PayPanel, usePaymentWatch } from './PayPanel';

type Availability = { enabled: boolean; optedIn: boolean; channelId: string; name: string; amountsUsdCents: number[]; terms: string };
export function CreatorSupport({ handle, owner }: { handle: string; owner: boolean }) {
  const { viewer, locale } = useShell();
  const [info, setInfo] = useState<Availability | null>(null);
  const [plans, setPlans] = useState<Plans | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(300);
  const [pending, setPending] = useState<Payment | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const storageKey = `support:${viewer?.user.id}:${handle}`;
  const settled = (p: Payment) => {
    setPending(null);
    if (p.status === 'SUCCEEDED') {
      setNotice('Thank you. Your support was received and is pending settlement review for the creator.');
      sessionStorage.removeItem(storageKey);
    } else { sessionStorage.removeItem(storageKey); setError(p.failureReason ?? 'This payment was not completed.'); }
  };
  const { watch } = usePaymentWatch(settled);
  useEffect(() => {
    let active = true;
    (async () => {
      const [a, p] = await Promise.all([api<Availability>(`/support/${encodeURIComponent(handle)}`), api<Plans>('/billing/plans')]);
      if (!active) return;
      setInfo(a); setPlans(p);
      if (new URLSearchParams(window.location.search).get('support')) setOpen(true);
      if (!viewer || owner) return;
      const returned = new URLSearchParams(window.location.search).get('payment');
      const r = returned
        ? { payments: [(await api<{ payment: Payment }>(`/billing/payments/${encodeURIComponent(returned)}`)).payment] }
        : await api<{ payments: Payment[] }>('/billing/me');
      const payment = r.payments.find((x) => x.purpose === 'CREATOR_SUPPORT' && x.supportChannelId === a.channelId && (x.id === returned || x.status === 'PENDING'));
      if (!active || !payment) return;
      setOpen(true); setAmount(payment.usdCents);
      if (payment.status === 'PENDING') { setPending(payment); watch(payment); } else settled(payment);
    })().catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [handle, viewer?.user.id, owner]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info || !plans) return error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null;
  if (owner) return <div className="mt-3 rounded-2xl border border-line p-4 text-sm">
    <p className="font-semibold">Audience support</p><p className="mt-1 text-muted">Accept one-time contributions after your payout account is reviewed. No Premium purchase required.</p>
    <button disabled={busy} className="mt-3 rounded-xl bg-surface px-4 py-2 font-semibold disabled:opacity-50" onClick={async () => {
      setBusy(true); setError(''); try { setInfo(await api<Availability>(`/support/${encodeURIComponent(handle)}`, { method: 'PUT', body: { enabled: !info.optedIn } })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>{info.optedIn ? 'Turn support off' : 'Enable support'}</button>
    <Link href="/hub?tab=money" className="ml-3 underline">Payout account</Link>{error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
  if (!info.enabled && !pending && !notice) return null;
  return <section className="mt-4 max-w-xl rounded-2xl border border-line bg-elevated p-4">
    <button onClick={() => setOpen(!open)} aria-expanded={open} className="font-semibold">Support {info.name} <span aria-hidden>↗</span></button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm text-muted">{info.terms}</p>
      {notice ? <p role="status" className="rounded-xl bg-brand-soft p-3 text-brand">{notice}</p> : !viewer ? <Link href={`/login?returnTo=${encodeURIComponent(`/channel/${handle}?support=1`)}`} className="underline">Sign in to support this creator</Link> : <>
        <div role="radiogroup" aria-label="Support amount" className="flex flex-wrap gap-2">{info.amountsUsdCents.map((a) => <button key={a} disabled={!!pending} role="radio" aria-checked={amount === a} className={`rounded-xl border px-3 py-2 ${amount === a ? 'border-brand bg-brand-soft' : 'border-line'}`} onClick={() => { setAmount(a); setError(''); }}>{usd(a, locale)}</button>)}</div>
        <PayPanel key={pending?.id ?? amount} usdCents={amount} plans={plans} pending={pending} label="Send one-time support" onPaid={settled} start={async (method, phone) => {
          let requestId = sessionStorage.getItem(storageKey);
          if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(storageKey, requestId); }
          const r = await api<{ payment: Payment }>(`/support/${encodeURIComponent(handle)}`, { body: { method, phone, usdCents: amount, requestId } });
          if (r.payment.status !== 'PENDING') { settled(r.payment); return r.payment; }
          setPending(r.payment); return r.payment;
        }} />
        <p className="text-xs text-muted">A paid contribution is separate from free Sparks. No recurring charge.</p>
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>}
  </section>;
}
