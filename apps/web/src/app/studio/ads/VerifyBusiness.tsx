'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { inputClass } from '@/components/Pickers';
import { PayPanel } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { usd } from '@/lib/money';
import type { Payment, Plans } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';

interface Verification {
  priceUsdCents: number;
  request: { status: 'PENDING' | 'APPROVED' | 'ACTIVE' | 'REJECTED'; businessName: string; registrationNumber: string; phone: string; website: string | null; reviewNote: string | null; verifiedUntil: string | null } | null;
}

/**
 * The Verified business badge: protects a business's name on Free Me (no other Space can use it). The business sends
 * its details, our team checks them, and only then does it pay for a year (nobody pays for a request we refuse).
 */
export function VerifyBusiness({ plans }: { plans: Plans }) {
  const { locale } = useShell();
  const [v, setV] = useState<Verification | null>(null);
  const [form, setForm] = useState({ businessName: '', registrationNumber: '', phone: '', website: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const load = useCallback(async () => { try { setV(await api<Verification>('/ads/verification')); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);

  if (!v) return null;
  const r = v.request;
  const send = async () => {
    setBusy(true); setError(null);
    try { setV(await api<Verification>('/ads/verification', { body: { ...form, website: form.website.trim() || undefined } })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const until = r?.verifiedUntil ? new Date(r.verifiedUntil).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  return (
    <section aria-labelledby="verify" className="mt-6 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
      <h2 id="verify" className="flex items-center gap-2 font-display text-[20px] font-bold"><VerifiedBadge size={22} kind="verified" />Protect your business name</h2>
      <p className="mt-1 text-[14px] text-muted">The Verified badge shows people your Space really is your business, and no other Space can take your name. {usd(v.priceUsdCents, locale)} a year, paid after our team checks your business.</p>
      {error && <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}

      {r?.status === 'ACTIVE' && <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-brand"><Icon.CheckCircle size={20} filled />{r.businessName} is verified until {until}.</p>}
      {r?.status === 'PENDING' && <p className="mt-3 flex items-center gap-2 rounded-2xl bg-surface px-4 py-3 text-[14px]"><Icon.Clock size={18} />We are checking {r.businessName}. You will be able to pay here once it is approved, usually within two working days.</p>}
      {(r?.status === 'APPROVED' || r?.status === 'ACTIVE') && !paid && (
        <div className="mt-4 max-w-lg">
          {r.status === 'APPROVED' && <p className="mb-3 text-[14px] font-semibold">{r.businessName} is approved. Pay to turn on the badge for a year.</p>}
          <PayPanel usdCents={v.priceUsdCents} plans={plans} label={r.status === 'ACTIVE' ? 'Renew for a year' : 'Turn on the badge'}
            onPaid={() => { setPaid(true); void load(); }}
            start={async (method, phone) => (await api<{ payment: Payment }>('/ads/verification/pay', { body: { method, phone } })).payment} />
        </div>
      )}
      {(!r || r.status === 'REJECTED') && (
        <>
          {r?.status === 'REJECTED' && <p className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">We could not verify {r.businessName}: {r.reviewNote}. You can correct the details and send them again.</p>}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label><span className="text-[13px] font-semibold">Business name, as registered</span><input className={`mt-1 ${inputClass}`} value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} maxLength={100} /></label>
            <label><span className="text-[13px] font-semibold">Registration number (RDB) or TIN</span><input className={`mt-1 ${inputClass}`} value={form.registrationNumber} onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} maxLength={60} /></label>
            <label><span className="text-[13px] font-semibold">Phone number we can call</span><input className={`mt-1 ${inputClass}`} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" maxLength={24} /></label>
            <label><span className="text-[13px] font-semibold">Website (optional)</span><input className={`mt-1 ${inputClass}`} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" /></label>
          </div>
          <button type="button" disabled={busy || form.businessName.trim().length < 2 || form.registrationNumber.trim().length < 3 || form.phone.trim().length < 6} onClick={() => void send()}
            className="mt-3 h-11 rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">Send for checking</button>
        </>
      )}
    </section>
  );
}
