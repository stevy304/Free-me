'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { inputClass } from '@/components/Pickers';
import { usd } from '@/lib/money';
import { useT } from '@/components/shell/ShellContext';
import type { Key } from '@/i18n';

interface Account { id: string; version: number; country: string; accountIdentifier: string; accountHolderName: string; status: string; reviewNote: string | null }
export interface Withdrawal {
  id: string; amountCents: number; account: string; status: string; reference: string | null; rejectionReason: string | null; requestedAt: string;
  destinationCurrency?: string | null; destinationAmount?: string | null; feeAmount?: string | null; exchangeRate?: number | null;
}
interface Preview {
  quote: { token: string; amountCents: string; receiveRwf: string; rwfPerUsd: number; feeRwf: number; expiresAt: number };
  destination: { account: string; name: string }; processing: string;
}
const STATUS: Record<string, Key> = { REQUESTED: 'payout.sRequested', UNDER_REVIEW: 'payout.sReview', APPROVED: 'payout.sApproved', PAID: 'premium.sPaid', REJECTED: 'payout.sRejected' };
const ACCOUNT_STATUS: Record<string, Key> = { PENDING: 'payout.aPending', VERIFIED: 'payout.aVerified', REJECTED: 'payout.aRejected' };
const rwf = (amount: string | number, locale: string) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'RWF', maximumFractionDigits: 0 }).format(Number(amount));

export function HubPayouts({ availableCents, minimumCents, payouts, locale, onChanged }: {
  availableCents: number; minimumCents: number; payouts: Withdrawal[]; locale: string; onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [account, setAccount] = useState<Account | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ account: Account | null }>('/hub/monetisation/payout-account');
      setAccount(r.account); setPhone(r.account?.accountIdentifier ?? ''); setName(r.account?.accountHolderName ?? ''); setLoaded(true);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const open = payouts.some((p) => ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'].includes(p.status));
  return (
    <section className="rounded-3xl border border-line bg-elevated p-5 sm:p-6" aria-labelledby="payout-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 id="payout-heading" className="text-xl font-bold">{t('payout.title')}</h3><p className="mt-1 text-sm text-muted">{t('payout.pilot')}</p></div>
        {account && <span className="rounded-full bg-surface px-3 py-1 text-xs font-semibold">{ACCOUNT_STATUS[account.status] ? t(ACCOUNT_STATUS[account.status]) : account.status}</span>}
      </div>
      <p className="mt-3 text-sm text-muted">{t('payout.ownName')}</p>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {message && <p role="status" className="mt-3 text-sm text-brand">{message}</p>}
      {account?.reviewNote && <p className="mt-3 rounded-xl bg-surface p-3 text-sm">{account.reviewNote}</p>}
      {loaded && <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => {
        e.preventDefault(); setPreview(null);
        void run(async () => {
          const r = await api<{ account: Account }>('/hub/monetisation/payout-account', { method: 'PUT', body: { country: 'RW', phone, accountHolderName: name } });
          setAccount(r.account); setPhone(r.account.accountIdentifier); setName(r.account.accountHolderName); setMessage(r.account.status === 'VERIFIED' ? t('payout.ready') : t('payout.savedForReview'));
        });
      }}>
        <label className="text-sm font-semibold">{t('payout.number')}<input required className={`mt-1 ${inputClass}`} value={phone} onChange={(e) => { setPhone(e.target.value); setPreview(null); }} inputMode="tel" autoComplete="tel" /></label>
        <label className="text-sm font-semibold">{t('payout.name')}<input required minLength={2} maxLength={100} className={`mt-1 ${inputClass}`} value={name} onChange={(e) => { setName(e.target.value); setPreview(null); }} autoComplete="name" /></label>
        <button disabled={busy} className="h-11 rounded-xl border border-line px-4 text-sm font-semibold disabled:opacity-50">{t('payout.save')}</button>
      </form>}
      <div className="mt-5 border-t border-line pt-4">
        <p className="text-sm text-muted">{t('payout.withdrawFrom', { min: usd(minimumCents, locale) })}</p>
        {open ? <p className="mt-3 text-sm font-semibold">{t('payout.awaiting')}</p> : <button type="button" disabled={busy || account?.status !== 'VERIFIED' || phone !== account.accountIdentifier || name.trim() !== account.accountHolderName || availableCents < minimumCents} onClick={() => void run(async () => {
          setPreview(await api<Preview>('/hub/monetisation/payout-quote'));
        })} className="mt-3 rounded-xl bg-brand px-4 py-3 text-sm font-bold text-on-brand disabled:opacity-50">{t('payout.preview')}</button>}
      </div>
      {preview && <div className="mt-4 rounded-2xl border border-brand bg-brand-soft p-4">
        <h4 className="font-bold">{t('payout.review')}</h4>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt>{t('payout.fromBalance')}</dt><dd className="text-right font-semibold">{usd(Number(preview.quote.amountCents), locale)}</dd>
          <dt>{t('payout.rate')}</dt><dd className="text-right">1 USD = {rwf(preview.quote.rwfPerUsd, locale)}</dd>
          <dt>{t('payout.fee')}</dt><dd className="text-right">{rwf(preview.quote.feeRwf, locale)}</dd>
          <dt>{t('payout.receive')}</dt><dd className="text-right font-bold">{rwf(preview.quote.receiveRwf, locale)}</dd>
        </dl>
        <p className="mt-3 text-sm">{preview.destination.name} · {preview.destination.account}</p>
        <p className="mt-2 text-xs text-muted">{t('payout.validUntil', { time: new Date(preview.quote.expiresAt).toLocaleTimeString(locale) })} {preview.processing}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            await api('/hub/monetisation/payouts', { body: { quoteToken: preview.quote.token } });
            setPreview(null); setMessage(t('payout.requested')); await onChanged();
          })} className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-on-brand disabled:opacity-50">{t('payout.confirm')}</button>
          <button type="button" disabled={busy} onClick={() => setPreview(null)} className="rounded-xl px-4 py-2 text-sm font-semibold">{t('payout.cancel')}</button>
        </div>
      </div>}
      {payouts.length > 0 && <div className="mt-6">
        <h4 className="font-bold">{t('payout.history')}</h4>
        <ul className="mt-2 divide-y divide-line">
          {payouts.map((p) => <li key={p.id} className="py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><strong>{usd(p.amountCents, locale)}</strong><span>{STATUS[p.status] ? t(STATUS[p.status]) : p.status}</span></div>
            <p className="mt-1 text-muted">{p.destinationAmount ? `${rwf(p.destinationAmount, locale)} · ` : ''}{p.account} · {new Date(p.requestedAt).toLocaleDateString(locale)}</p>
            {p.reference && <p className="mt-1">{t('payout.reference')} · {p.reference}</p>}
            {p.rejectionReason && <p className="mt-1 text-danger">{p.rejectionReason}</p>}
          </li>)}
        </ul>
      </div>}
      <p className="mt-4 text-xs text-muted">{t('payout.more')}</p>
    </section>
  );
}
