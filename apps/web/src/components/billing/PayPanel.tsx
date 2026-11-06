'use client';

import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { charge, money, usd } from '@/lib/money';
import type { Payment, Plans } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';
import { useRealtime } from '@/lib/realtime';

/** Follows a payment until it succeeds or fails (MoMo: the payer approves on their phone; card: back from checkout). */
export function usePaymentWatch(onSettled: (p: Payment) => void) {
  const [watching, setWatching] = useState<Payment | null>(null);
  const cb = useRef(onSettled); cb.current = onSettled;
  // The moment the payment settles (the socket), and every few seconds in case the socket is down.
  const [nudge, setNudge] = useState(0);
  useRealtime<{ id: string }>('payment', (d) => { if (d.id === watching?.id) setNudge((n) => n + 1); }, null, watching?.status === 'PENDING');
  useEffect(() => {
    if (!watching || watching.status !== 'PENDING') return;
    let stop = false; const started = Date.now();
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api<{ payment: Payment }>(`/billing/payments/${watching.id}`);
        if (r.payment.status !== 'PENDING') { setWatching(r.payment); cb.current(r.payment); return; }
      } catch { /* try again */ }
      if (Date.now() - started < 5 * 60_000) setTimeout(tick, 3000);
    };
    const t = setTimeout(tick, nudge ? 0 : 2500);
    return () => { stop = true; clearTimeout(t); };
  }, [watching, nudge]);
  return { watching, watch: setWatching };
}

/**
 * Choose MTN MoMo (a prompt on the phone) or a card (a secure checkout page), then follow the payment.
 * `start` asks the API to begin the payment and returns it.
 */
export function PayPanel({ usdCents, plans, start, onPaid, label }: { usdCents: number; plans: Plans; start: (method: Payment['method'], phone?: string) => Promise<Payment>; onPaid: (p: Payment) => void; label: string }) {
  const { locale } = useShell();
  const [method, setMethod] = useState<Payment['method'] | null>(plans.methods[0]?.name ?? null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { watching, watch } = usePaymentWatch((p) => { if (p.status === 'SUCCEEDED') onPaid(p); else setError(p.failureReason ?? 'The payment did not go through.'); });

  if (!plans.methods.length) {
    return <p className="rounded-2xl bg-accent-soft px-4 py-3 text-[14px] text-on-accent-soft">Payments are not switched on for this server yet. The operator adds MTN MoMo or Flutterwave keys (see ENVIRONMENT.md → Payments).</p>;
  }
  const m = plans.methods.find((x) => x.name === method) ?? plans.methods[0];
  const amount = money(charge(usdCents, m), m.currency, locale);
  const pay = async () => {
    setBusy(true); setError(null);
    try {
      const p = await start(m.name, m.name === 'mtn_momo' ? phone : undefined);
      if (p.checkoutUrl) { window.location.href = p.checkoutUrl; return; }
      watch(p);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (watching?.status === 'PENDING') {
    return (
      <div className="rounded-2xl border border-line bg-elevated p-5 text-center" aria-live="polite">
        <Icon.Spinner size={28} className="mx-auto animate-spin text-brand" />
        <p className="mt-3 font-display text-[18px] font-bold">Approve {money(watching.amount, watching.currency, locale)} on your phone</p>
        <p className="mt-1 text-[14px] text-muted">A MoMo prompt was sent to your number. Enter your PIN to confirm. If it does not appear, dial <b>*182*7*1#</b> to see pending approvals.</p>
        <button type="button" onClick={() => watch(null)} className="mt-4 text-[13px] font-semibold text-muted hover:text-ink">Use another number</button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="How to pay" className="grid gap-2 sm:grid-cols-2">
        {plans.methods.map((x) => (
          <button key={x.name} type="button" role="radio" aria-checked={m.name === x.name} onClick={() => setMethod(x.name)}
            className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left ${m.name === x.name ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[13px] font-extrabold ${x.name === 'mtn_momo' ? 'bg-[#ffcb05] text-[#1a1a1a]' : 'bg-strong text-on-strong'}`}>{x.name === 'mtn_momo' ? 'MoMo' : <Icon.Wallet size={20} />}</span>
            <span><span className="block text-[15px] font-semibold">{x.name === 'mtn_momo' ? 'MTN Mobile Money' : 'Card'}</span><span className="block text-[12px] text-muted">{x.name === 'mtn_momo' ? `Pay ${money(charge(usdCents, x), x.currency, locale)} from your phone` : 'Visa, Mastercard and more, worldwide'}</span></span>
          </button>
        ))}
      </div>
      {m.name === 'mtn_momo' && (
        <label className="block"><span className="text-[13px] font-semibold">MoMo number</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="0788 123 456" className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-brand" />
        </label>
      )}
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <button type="button" disabled={busy || (m.name === 'mtn_momo' && phone.replace(/\D/g, '').length < 9)} onClick={() => void pay()}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[15px] font-bold text-on-brand hover:bg-brand-strong disabled:opacity-50">
        {busy ? <Icon.Spinner size={20} className="animate-spin" /> : null}{label} · {amount}{m.currency !== 'USD' && <span className="font-medium opacity-80">({usd(usdCents, locale)})</span>}
      </button>
      <p className="text-center text-[12px] text-faint">{m.name === 'mtn_momo' ? 'Charged in Rwandan francs by MTN MoMo.' : 'You will finish on a secure Flutterwave page, then come back here.'}</p>
    </div>
  );
}
