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
export function PayPanel({ usdCents, plans, start, onPaid, label, pending }: { usdCents: number; plans: Plans; start: (method: Payment['method'], phone?: string) => Promise<Payment>; onPaid: (p: Payment) => void; label: string; /** A manual payment still waiting, shown again after a reload. */ pending?: Payment | null }) {
  const { locale, t } = useShell();
  const [method, setMethod] = useState<Payment['method'] | null>(plans.methods[0]?.name ?? null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { watching, watch } = usePaymentWatch((p) => { if (p.status === 'SUCCEEDED') onPaid(p); else setError(p.failureReason ?? t('pay.failed')); });
  useEffect(() => { if (pending && !watching) watch(pending); }, [pending?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!plans.methods.length) {
    return <p className="rounded-2xl bg-accent-soft px-4 py-3 text-[14px] text-on-accent-soft">{t('pay.off')}</p>;
  }
  const m = plans.methods.find((x) => x.name === method) ?? plans.methods[0];
  const amount = money(charge(usdCents, m), m.currency, locale);
  // MTN MoMo and Airtel Money: the payer approves a prompt on the phone with this number.
  const mobile = m.name === 'mtn_momo' || m.name === 'airtel_money';
  const pay = async () => {
    setBusy(true); setError(null);
    try {
      const p = await start(m.name, mobile ? phone : undefined);
      if (p.checkoutUrl) { window.location.href = p.checkoutUrl; return; }
      watch(p);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (watching?.status === 'PENDING' && watching.method === 'manual') {
    const acc = plans.methods.find((x) => x.name === 'manual');
    return <ManualSteps payment={watching} accounts={acc?.accounts ?? []} instructions={acc?.instructions ?? null} onUpdate={watch} onCancel={() => watch(null)} />;
  }
  if (watching?.status === 'PENDING' && watching.method === 'flutterwave') {
    return <div className="rounded-2xl border border-line p-5 text-sm" aria-live="polite">
      <p className="font-semibold">{t('pay.waitCheckout')}</p>
      <p className="mt-1 text-muted">{t('pay.checking')}</p>
      {watching.checkoutUrl && <a href={watching.checkoutUrl} className="mt-3 inline-block font-semibold text-brand underline">{t('pay.continueCheckout')}</a>}
    </div>;
  }
  if (watching?.status === 'PENDING') {
    return (
      <div className="rounded-2xl border border-line bg-elevated p-5 text-center" aria-live="polite">
        {watching.failureReason && <p className="mb-3 text-sm text-muted">{watching.failureReason}</p>}
        <Icon.Spinner size={28} className="mx-auto animate-spin text-brand" />
        <p className="mt-3 font-display text-[18px] font-bold">{t('pay.approve', { amount: money(watching.amount, watching.currency, locale) })}</p>
        <p className="mt-1 text-[14px] text-muted">{watching.method === 'airtel_money'
          ? t('pay.airtelPrompt')
          : <>{t('pay.momoPrompt')} {t('pay.momoDial1')} <b>*182*7*1#</b> {t('pay.momoDial2')}</>}</p>
        <button type="button" onClick={() => watch(null)} className="mt-4 text-[13px] font-semibold text-muted hover:text-ink">{t('pay.anotherNumber')}</button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t('pay.howToPay')} className="grid gap-2 sm:grid-cols-2">
        {plans.methods.map((x) => (
          <button key={x.name} type="button" role="radio" aria-checked={m.name === x.name} onClick={() => setMethod(x.name)}
            className={`flex items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left ${m.name === x.name ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[13px] font-extrabold ${x.name === 'mtn_momo' ? 'bg-[#ffcb05] text-[#1a1a1a]' : x.name === 'airtel_money' ? 'bg-[#e40000] text-white' : x.name === 'manual' ? 'bg-brand-soft text-brand' : 'bg-strong text-on-strong'}`}>{x.name === 'mtn_momo' ? 'MoMo' : x.name === 'airtel_money' ? 'Airtel' : x.name === 'manual' ? <Icon.Send size={20} /> : <Icon.Wallet size={20} />}</span>
            <span><span className="block text-[15px] font-semibold">{x.name === 'mtn_momo' ? 'MTN Mobile Money' : x.name === 'airtel_money' ? 'Airtel Money' : x.name === 'manual' ? t('pay.sendMoney') : t('pay.card')}</span><span className="block text-[12px] text-muted">{x.name === 'mtn_momo' || x.name === 'airtel_money' ? t('pay.fromPhone', { amount: money(charge(usdCents, x), x.currency, locale) }) : x.name === 'manual' ? `${(x.accounts ?? []).map((a) => a.label).join(', ')}: ${t('pay.sendWeConfirm', { amount: money(charge(usdCents, x), x.currency, locale) })}` : t('pay.cards')}</span></span>
          </button>
        ))}
      </div>
      {mobile && (
        <label className="block"><span className="text-[13px] font-semibold">{m.name === 'airtel_money' ? t('pay.airtelNumber') : t('pay.momoNumber')}</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder={m.name === 'airtel_money' ? '0731 234 567' : '0788 123 456'} className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-brand" />
        </label>
      )}
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <button type="button" disabled={busy || (mobile && phone.replace(/\D/g, '').length < 9)} onClick={() => void pay()}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[15px] font-bold text-on-brand hover:bg-brand-strong disabled:opacity-50">
        {busy ? <Icon.Spinner size={20} className="animate-spin" /> : null}{label} · {amount}{m.currency !== 'USD' && <span className="font-medium opacity-80">({usd(usdCents, locale)})</span>}
      </button>
      <p className="text-center text-[12px] text-faint">{m.name === 'mtn_momo' ? t('pay.chargedMomo', { currency: m.currency }) : m.name === 'airtel_money' ? t('pay.chargedAirtel', { currency: m.currency }) : m.name === 'manual' ? t('pay.manualNext') : t('pay.flutterwaveNext')}</p>
    </div>
  );
}

/**
 * Paying by hand: send the amount to one of the accounts with the reference code in the message, then enter the
 * transaction id from the confirmation. An administrator checks it; the page updates the moment it is confirmed.
 */
function ManualSteps({ payment, accounts, instructions, onUpdate, onCancel }: { payment: Payment; accounts: Array<{ label: string; number: string; name: string }>; instructions: string | null; onUpdate: (p: Payment) => void; onCancel: () => void }) {
  const { locale, t } = useShell();
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(null), 1500); } catch { /* blocked */ } };
  const send = async () => {
    setBusy(true); setError(null);
    try { onUpdate((await api<{ payment: Payment }>(`/billing/payments/${payment.id}/proof`, { body: { reference: ref } })).payment); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (payment.payerReference) {
    return (
      <div className="rounded-2xl border border-line bg-elevated p-5 text-center" aria-live="polite">
        <Icon.Spinner size={28} className="mx-auto animate-spin text-brand" />
        <p className="mt-3 font-display text-[18px] font-bold">{t('pay.waitConfirm')}</p>
        <p className="mt-1 text-[14px] text-muted">{t('pay.received1')} <b className="text-ink">{payment.payerReference}</b>. {t('pay.received2')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4 rounded-2xl border border-line bg-elevated p-5" aria-live="polite">
      <div>
        <p className="font-display text-[18px] font-bold">{t('pay.send', { amount: money(payment.amount, payment.currency, locale) })}</p>
        <p className="text-[14px] text-muted">{t('pay.toAccounts')}</p>
        <button type="button" onClick={() => void copy(payment.reference ?? '')} className="mt-2 inline-flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2 font-mono text-[18px] font-bold tracking-wider text-brand">{payment.reference}<Icon.Copy size={16} /><span className="font-sans text-[12px] font-semibold">{copied === payment.reference ? t('watch.copied') : t('pay.copy')}</span></button>
      </div>
      <ul className="space-y-2">
        {accounts.map((a) => (
          <li key={a.label + a.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface px-3 py-2.5 text-[14px]">
            <span className="w-28 font-semibold">{a.label}</span>
            <span className="font-mono text-[15px]">{a.number}</span>
            <span className="text-muted">{a.name}</span>
            <button type="button" onClick={() => void copy(a.number)} className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-semibold hover:bg-surface-hover"><Icon.Copy size={15} />{copied === a.number ? t('watch.copied') : t('pay.copy')}</button>
          </li>
        ))}
      </ul>
      {instructions && <p className="whitespace-pre-line text-[13px] text-muted">{instructions}</p>}
      <label className="block"><span className="text-[13px] font-semibold">{t('pay.txId')}</span>
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={t('pay.refExample')} className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-brand" />
      </label>
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || ref.trim().length < 4} onClick={() => void send()} className="h-11 flex-1 rounded-2xl bg-brand text-[15px] font-bold text-on-brand disabled:opacity-50">{t('pay.paid')}</button>
        <button type="button" onClick={onCancel} className="h-11 rounded-2xl px-4 text-[14px] font-semibold text-muted hover:bg-surface">{t('pay.back')}</button>
      </div>
    </div>
  );
}
