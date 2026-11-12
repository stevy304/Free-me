'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';
import { money, usd } from '@/lib/money';
import type { Payment } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';

interface Settings {
  prices: { plusUsdCents: number; plusByCountry?: Record<string, number>; familyUsdCents: number; familyByCountry?: Record<string, number>; creatorPassUsdCents: number; creatorFreeVideos: number; premiumUsdCents: number; premiumByCountry?: Record<string, number>; adDayUsdCents: number; adCpmUsdCents: number; adMinBudgetUsdCents: number; verificationUsdCents: number; payoutMinUsdCents: number };
  momo: { source: string; active: boolean; enabled: boolean; sandbox: boolean; baseUrl: string; targetEnvironment: string; apiUser: string; subscriptionKey: string; apiKey: string; currency: string; perUsd: number | null };
  flutterwave: { source: string; active: boolean; enabled: boolean; secretKey: string; webhookHash: string; webhookUrl: string };
  manual: { active: boolean; enabled: boolean; currency: string; perUsd: number | null; accounts: Array<{ label: string; number: string; name: string }>; instructions: string | null };
}
type Manual = Payment & { email: string };
const label = 'text-[13px] font-semibold';
const Status = ({ on }: { on: boolean }) => <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-bold ${on ? 'bg-brand-soft text-brand' : 'bg-surface text-muted'}`}>{on ? 'On' : 'Off'}</span>;

/** Manual payments waiting for an administrator: check the money arrived, then confirm (Premium or the ad starts). */

/** { RW: 172, KE: 250 } → "RW=172, KE=250" for the price fields. */
const byCountry = (m: Record<string, number> | undefined) => Object.entries(m ?? {}).map(([c, v]) => `${c}=${v}`).join(', ');
export function ManualQueue() {
  const { locale } = useShell();
  const [rows, setRows] = useState<Manual[] | null>(null);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ payments: Manual[] }>('/admin/billing/manual').then((r) => setRows(r.payments)).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const decide = async (p: Manual, approve: boolean) => {
    setError(null);
    try { await api(`/admin/billing/payments/${p.id}/confirm`, { body: { approve, reason: reason[p.id] } }); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!rows?.length) return null;
  return (
    <section className="rounded-2xl border-2 border-accent bg-accent-soft/40 p-4">
      <h2 className="text-[18px] font-semibold">Manual payments to confirm ({rows.length})</h2>
      <p className="text-[13px] text-muted">Check your MoMo, Airtel or bank statement for the amount and the reference code, then confirm.</p>
      {error && <p role="alert" className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <div className="mt-3 space-y-2">
        {rows.map((p) => (
          <article key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-elevated p-3 text-[14px]">
            <div className="min-w-0 flex-1">
              <p><b className="tabular-nums">{money(p.amount, p.currency, locale)}</b> ({usd(p.usdCents, locale)}) · {p.purpose === 'PREMIUM' ? `Premium, ${p.months} month${p.months === 1 ? '' : 's'}` : p.purpose === 'CREATOR_SUPPORT' ? 'Creator support' : 'Ad campaign'} · {p.email}</p>
              <p className="text-muted">Code <b className="font-mono text-ink">{p.reference}</b> · transaction id {p.payerReference ? <b className="font-mono text-ink">{p.payerReference}</b> : <i>not given yet</i>} · {new Date(p.createdAt).toLocaleString(locale)}</p>
            </div>
            <input className={`${inputClass} max-w-[200px]`} placeholder="Reason (to reject)" value={reason[p.id] ?? ''} onChange={(e) => setReason({ ...reason, [p.id]: e.target.value })} />
            <button type="button" onClick={() => void decide(p, true)} className="h-10 rounded-xl bg-brand px-4 font-semibold text-on-brand">Confirm</button>
            <button type="button" onClick={() => void decide(p, false)} className="h-10 rounded-xl bg-danger/10 px-4 font-semibold text-danger">Reject</button>
          </article>
        ))}
      </div>
    </section>
  );
}

/** Payment settings: prices, MTN MoMo (with sandbox keys in one click), Flutterwave and manual payments. */
export function PaymentSettings({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<{ momo: { ok: boolean; message: string }; flutterwave: { ok: boolean; message: string } } | null>(null);
  const apply = (r: Settings) => {
    setS(r);
    setForm({
      plus: r.prices.plusUsdCents / 100, family: r.prices.familyUsdCents / 100, plusByCountry: byCountry(r.prices.plusByCountry), familyByCountry: byCountry(r.prices.familyByCountry), creatorPass: r.prices.creatorPassUsdCents / 100, creatorFree: r.prices.creatorFreeVideos, premium: r.prices.premiumUsdCents / 100, premiumByCountry: byCountry(r.prices.premiumByCountry), adMin: r.prices.adMinBudgetUsdCents / 100, verification: r.prices.verificationUsdCents / 100, adCpm: r.prices.adCpmUsdCents / 100, payoutMin: r.prices.payoutMinUsdCents / 100,
      momoEnabled: r.momo.enabled, momoSandbox: r.momo.sandbox, momoBaseUrl: r.momo.sandbox ? '' : r.momo.baseUrl, momoTarget: r.momo.targetEnvironment, momoUser: r.momo.apiUser, momoSub: '', momoKey: '', momoCurrency: r.momo.currency, momoRate: r.momo.perUsd ?? '',
      sandboxKey: '',
      flwEnabled: r.flutterwave.enabled, flwSecret: '', flwHash: '',
      manualEnabled: r.manual.enabled || !r.manual.accounts.length, manualCurrency: r.manual.currency, manualRate: r.manual.perUsd ?? '', manualInstructions: r.manual.instructions ?? '',
      accounts: r.manual.accounts.length ? r.manual.accounts : [{ label: 'MTN MoMo', number: '', name: '' }],
    });
  };
  useEffect(() => { api<Settings>('/admin/billing/settings').then(apply).catch((e) => setError(e.message)); }, []);
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what); setError(null); setMsg(null);
    try { const r = await fn(); if (r && typeof r === 'object' && 'prices' in r) apply(r as Settings); setMsg(done); onSaved(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  if (!s) return error ? <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto animate-spin text-muted" />;
  const cents = (v: unknown) => Math.round(Number(v) * 100);

  return (
    <section className="space-y-4 rounded-2xl border border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-[18px] font-semibold">Payment settings</h2>
        <button type="button" disabled={!!busy} onClick={() => void run('test', async () => setTests(await api('/admin/billing/settings/test', { body: {} })), 'Checked.')} className="h-9 rounded-xl bg-surface px-3 text-[13px] font-semibold hover:bg-surface-hover">Test connections</button>
      </div>
      {msg && <p role="status" className="rounded-xl bg-brand-soft px-3 py-2 text-[14px] text-brand">{msg}</p>}
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}

      {/* Prices */}
      <div className="rounded-xl bg-surface p-3">
        <p className="font-semibold">Prices (US dollars)</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-4">
          <label><span className={label}>Premium per month</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.premium} onChange={(e) => set('premium', e.target.value)} /></label>
          <label><span className={label}>Smallest ad funds</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.adMin} onChange={(e) => set('adMin', e.target.value)} /></label>
          <label><span className={label}>Verified business badge, per year</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.verification} onChange={(e) => set('verification', e.target.value)} /></label>
          <label><span className={label}>Ad, per 1,000 views</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.adCpm} onChange={(e) => set('adCpm', e.target.value)} /></label>
          <label><span className={label}>Plus per month</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.plus} onChange={(e) => set('plus', e.target.value)} /></label>
          <label><span className={label}>Family & TV per month</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.family} onChange={(e) => set('family', e.target.value)} /></label>
          <label className="sm:col-span-2"><span className={label}>Plus in some countries (US cents, e.g. RW=172)</span><input className={`mt-1 ${inputClass}`} value={form.plusByCountry ?? ''} onChange={(e) => set('plusByCountry', e.target.value)} /></label>
          <label className="sm:col-span-2"><span className={label}>Family & TV in some countries (US cents, e.g. RW=621)</span><input className={`mt-1 ${inputClass}`} value={form.familyByCountry ?? ''} onChange={(e) => set('familyByCountry', e.target.value)} /></label>
          <label><span className={label}>Creator pass per year</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.creatorPass} onChange={(e) => set('creatorPass', e.target.value)} /></label>
          <label><span className={label}>Free uploads per Space before the pass</span><input type="number" min={0} step={1} className={`mt-1 ${inputClass}`} value={form.creatorFree} onChange={(e) => set('creatorFree', e.target.value)} /></label>
          <label className="sm:col-span-4"><span className={label}>Premium in some countries (US cents a month, e.g. RW=300, KE=500; empty = the price above everywhere)</span><input className={`mt-1 ${inputClass}`} value={form.premiumByCountry ?? ''} onChange={(e) => set('premiumByCountry', e.target.value)} placeholder="RW=300, KE=500" /></label>
          <label><span className={label}>Smallest creator withdrawal</span><input type="number" min={0.01} step={0.01} className={`mt-1 ${inputClass}`} value={form.payoutMin} onChange={(e) => set('payoutMin', e.target.value)} /></label>
        </div>
        <button type="button" disabled={!!busy} onClick={() => void run('prices', () => api('/admin/billing/settings', { method: 'PUT', body: { prices: { plusUsdCents: cents(form.plus), familyUsdCents: cents(form.family), plusByCountry: form.plusByCountry ?? '', familyByCountry: form.familyByCountry ?? '', creatorPassUsdCents: cents(form.creatorPass), creatorFreeVideos: form.creatorFree, premiumUsdCents: cents(form.premium), premiumByCountry: form.premiumByCountry ?? '', adMinBudgetUsdCents: cents(form.adMin), verificationUsdCents: cents(form.verification), adCpmUsdCents: cents(form.adCpm), payoutMinUsdCents: cents(form.payoutMin) } } }), 'Prices saved.')} className="mt-3 h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Save prices</button>
      </div>

      {/* Manual */}
      <div className="rounded-xl bg-surface p-3">
        <p className="flex items-center gap-2 font-semibold">Send money (manual) <Status on={s.manual.active} /></p>
        <p className="text-[13px] text-muted">Works today without any provider account: people send the amount to your MoMo, Airtel Money or bank account with a reference code, and you confirm it above. Best to start with.</p>
        <div className="mt-2 space-y-2">
          {(form.accounts as Array<{ label: string; number: string; name: string }>).map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[150px_1fr_1fr_auto]">
              <input className={inputClass} placeholder="MTN MoMo" value={a.label} onChange={(e) => set('accounts', form.accounts.map((x: object, j: number) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Method" />
              <input className={inputClass} placeholder="Number, MoMo Pay code or account" value={a.number} onChange={(e) => set('accounts', form.accounts.map((x: object, j: number) => (j === i ? { ...x, number: e.target.value } : x)))} aria-label="Number or account" />
              <input className={inputClass} placeholder="Name on the account" value={a.name} onChange={(e) => set('accounts', form.accounts.map((x: object, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Account holder" />
              <button type="button" onClick={() => set('accounts', form.accounts.filter((_: object, j: number) => j !== i))} className="h-11 rounded-xl px-3 text-[13px] text-muted hover:bg-surface-hover" aria-label="Remove account"><Icon.Close size={18} /></button>
            </div>
          ))}
          {form.accounts.length < 6 && <button type="button" onClick={() => set('accounts', [...form.accounts, { label: form.accounts.length ? 'Airtel Money' : 'MTN MoMo', number: '', name: '' }])} className="text-[13px] font-semibold text-brand">+ Add an account (Airtel Money, bank…)</button>}
        </div>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <label><span className={label}>Currency people pay in</span><input className={`mt-1 ${inputClass}`} value={form.manualCurrency} onChange={(e) => set('manualCurrency', e.target.value.toUpperCase())} maxLength={3} /></label>
          <label><span className={label}>{form.manualCurrency || 'RWF'} for 1 US dollar</span><input type="number" min={0} step="any" className={`mt-1 ${inputClass}`} value={form.manualRate} onChange={(e) => set('manualRate', e.target.value)} placeholder="1450" disabled={form.manualCurrency === 'USD'} /></label>
          <label className="sm:col-span-3"><span className={label}>Note for payers (optional)</span><input className={`mt-1 ${inputClass}`} value={form.manualInstructions} onChange={(e) => set('manualInstructions', e.target.value)} placeholder="e.g. Confirmed within 2 hours, 8:00–22:00 Kigali time" /></label>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={!!busy} onClick={() => void run('manual', () => api('/admin/billing/settings', { method: 'PUT', body: { manual: { enabled: true, currency: form.manualCurrency, perUsd: form.manualRate, accounts: form.accounts, instructions: form.manualInstructions } } }), 'Manual payments are on.')} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Save and switch on</button>
          {s.manual.active && <button type="button" disabled={!!busy} onClick={() => void run('manualOff', () => api('/admin/billing/settings', { method: 'PUT', body: { manual: { enabled: false, currency: form.manualCurrency, perUsd: form.manualRate || 1, accounts: form.accounts.filter((a: { number: string }) => a.number), instructions: form.manualInstructions } } }), 'Manual payments are off.')} className="h-10 rounded-xl px-4 text-[14px] font-semibold text-muted hover:bg-surface-hover">Switch off</button>}
        </div>
      </div>

      {/* MoMo */}
      <div className="rounded-xl bg-surface p-3">
        <p className="flex items-center gap-2 font-semibold">MTN MoMo (automatic) <Status on={s.momo.active} />{tests && <span className={`text-[12px] ${tests.momo.ok ? 'text-brand' : 'text-danger'}`}>{tests.momo.message}</span>}</p>
        <p className="text-[13px] text-muted">A prompt appears on the payer’s phone; the payment confirms by itself. For testing, sign up at momodeveloper.mtn.com, subscribe to <b>Collections</b>, and paste the Primary key here: Free Me creates the sandbox keys (test money in EUR). For real money, MTN gives you live keys after signing a merchant agreement.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inputClass} max-w-sm`} placeholder="Collections Primary key" value={form.sandboxKey} onChange={(e) => set('sandboxKey', e.target.value)} />
          <button type="button" disabled={!!busy || form.sandboxKey.length < 10} onClick={() => void run('sandbox', () => api('/admin/billing/settings/momo/sandbox', { body: { subscriptionKey: form.sandboxKey } }), 'MoMo sandbox keys created and switched on.')} className="h-11 rounded-xl bg-[#ffcb05] px-4 text-[14px] font-bold text-[#1a1a1a] disabled:opacity-50">{busy === 'sandbox' ? 'Creating…' : 'Create sandbox keys'}</button>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] font-semibold">Enter keys yourself (live)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={!form.momoSandbox} onChange={(e) => set('momoSandbox', !e.target.checked)} /><span className={label}>Live (real money)</span></label>
            {!form.momoSandbox && <label><span className={label}>MTN address (live)</span><input className={`mt-1 ${inputClass}`} value={form.momoBaseUrl} onChange={(e) => set('momoBaseUrl', e.target.value)} placeholder="https://proxy.momoapi.mtn.com" /></label>}
            {!form.momoSandbox && <label><span className={label}>Target environment</span><input className={`mt-1 ${inputClass}`} value={form.momoTarget} onChange={(e) => set('momoTarget', e.target.value)} placeholder="mtnrwanda" /></label>}
            <label><span className={label}>Subscription key {s.momo.subscriptionKey && <span className="font-normal text-muted">(saved {s.momo.subscriptionKey})</span>}</span><input className={`mt-1 ${inputClass}`} value={form.momoSub} onChange={(e) => set('momoSub', e.target.value)} placeholder="leave empty to keep" /></label>
            <label><span className={label}>API user</span><input className={`mt-1 ${inputClass}`} value={form.momoUser} onChange={(e) => set('momoUser', e.target.value)} /></label>
            <label><span className={label}>API key {s.momo.apiKey && <span className="font-normal text-muted">(saved {s.momo.apiKey})</span>}</span><input className={`mt-1 ${inputClass}`} value={form.momoKey} onChange={(e) => set('momoKey', e.target.value)} placeholder="leave empty to keep" /></label>
            <label><span className={label}>Currency</span><input className={`mt-1 ${inputClass}`} value={form.momoCurrency} onChange={(e) => set('momoCurrency', e.target.value.toUpperCase())} maxLength={3} /></label>
            <label><span className={label}>{form.momoCurrency || 'RWF'} for 1 US dollar</span><input type="number" min={0} step="any" className={`mt-1 ${inputClass}`} value={form.momoRate} onChange={(e) => set('momoRate', e.target.value)} /></label>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={!!busy} onClick={() => void run('momo', () => api('/admin/billing/settings', { method: 'PUT', body: { momo: { enabled: true, sandbox: form.momoSandbox, baseUrl: form.momoBaseUrl, targetEnvironment: form.momoTarget, subscriptionKey: form.momoSub, apiUser: form.momoUser, apiKey: form.momoKey, currency: form.momoCurrency, perUsd: form.momoRate } } }), 'MoMo saved.')} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Save MoMo</button>
            {s.momo.active && <button type="button" disabled={!!busy} onClick={() => void run('momoOff', () => api('/admin/billing/settings', { method: 'PUT', body: { momo: { enabled: false, sandbox: s.momo.sandbox, currency: s.momo.currency, perUsd: s.momo.perUsd ?? 1 } } }), 'MoMo is off.')} className="h-10 rounded-xl px-4 text-[14px] font-semibold text-muted hover:bg-surface-hover">Switch off</button>}
          </div>
        </details>
      </div>

      {/* Flutterwave */}
      <div className="rounded-xl bg-surface p-3">
        <p className="flex items-center gap-2 font-semibold">Cards: Flutterwave <Status on={s.flutterwave.active} />{tests && <span className={`text-[12px] ${tests.flutterwave.ok ? 'text-brand' : 'text-danger'}`}>{tests.flutterwave.message}</span>}</p>
        <p className="text-[13px] text-muted">Visa and Mastercard from any country (and mobile money in several African countries). Create an account at flutterwave.com (Rwanda is supported), then copy the Secret key from Settings → API keys. In Settings → Webhooks, set the URL to <code className="break-all">{s.flutterwave.webhookUrl}</code> and a secret hash, and paste the same hash here.</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label><span className={label}>Secret key {s.flutterwave.secretKey && <span className="font-normal text-muted">(saved {s.flutterwave.secretKey})</span>}</span><input className={`mt-1 ${inputClass}`} value={form.flwSecret} onChange={(e) => set('flwSecret', e.target.value)} placeholder="FLWSECK-…" /></label>
          <label><span className={label}>Webhook secret hash {s.flutterwave.webhookHash && <span className="font-normal text-muted">(saved {s.flutterwave.webhookHash})</span>}</span><input className={`mt-1 ${inputClass}`} value={form.flwHash} onChange={(e) => set('flwHash', e.target.value)} /></label>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={!!busy} onClick={() => void run('flw', () => api('/admin/billing/settings', { method: 'PUT', body: { flutterwave: { enabled: true, secretKey: form.flwSecret, webhookHash: form.flwHash } } }), 'Flutterwave saved.')} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Save Flutterwave</button>
          {s.flutterwave.active && <button type="button" disabled={!!busy} onClick={() => void run('flwOff', () => api('/admin/billing/settings', { method: 'PUT', body: { flutterwave: { enabled: false } } }), 'Flutterwave is off.')} className="h-10 rounded-xl px-4 text-[14px] font-semibold text-muted hover:bg-surface-hover">Switch off</button>}
        </div>
      </div>
    </section>
  );
}

