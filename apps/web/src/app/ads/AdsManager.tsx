'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { CountrySelect, inputClass } from '@/components/Pickers';
import { PayPanel, usePaymentWatch } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { duration } from '@/lib/format';
import { usd } from '@/lib/money';
import type { HubVideo } from '@/components/hub/types';
import type { Payment, Plans, Viewer } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';

interface Campaign {
  id: string; status: 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'REJECTED'; businessName: string; headline: string; destinationUrl: string; days: number;
  dailyRateCents: number; totalCents: number; targetCountries: string[]; startDate: string | null; endDate: string | null; reviewNote: string | null;
  impressions: number; clicks: number; video: { id: string; title: string; durationSeconds: number } | null; createdAt: string;
}
const STATUS: Record<Campaign['status'], [string, string]> = {
  DRAFT: ['Not paid yet', 'bg-surface'], PENDING_REVIEW: ['Paid · in review', 'bg-accent-soft text-on-accent-soft'], ACTIVE: ['Running', 'bg-brand-soft text-brand'],
  PAUSED: ['Paused', 'bg-surface'], COMPLETED: ['Finished', 'bg-surface text-muted'], REJECTED: ['Not approved', 'bg-danger/10 text-danger'],
};

/** Ads Manager: a business's video ads, bought by the day and paid up front. */
export function AdsManager({ viewer }: { viewer: Viewer }) {
  const { locale } = useShell();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plans | null>(null);
  const [list, setList] = useState<{ business: { name: string; country: string } | null; campaigns: Campaign[] } | null>(null);
  const [videos, setVideos] = useState<HubVideo[]>([]);
  const [form, setForm] = useState({ businessName: '', country: viewer.profile?.country ?? null as string | null, headline: '', destinationUrl: 'https://', videoId: '', days: 7, target: null as string | null });
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, l, v] = await Promise.all([api<Plans>('/billing/plans'), api<typeof list>('/ads/campaigns'), viewer.channel ? api<{ videos: HubVideo[] }>('/hub/videos') : Promise.resolve({ videos: [] })]);
      setPlans(p); setList(l); setVideos(v.videos);
      if (l?.business) setForm((f) => ({ ...f, businessName: f.businessName || l.business!.name, country: f.country ?? l.business!.country }));
      if (!l?.campaigns.length) setCreating(true);
    } catch (e) { setError((e as Error).message); }
  }, [viewer.channel]);
  useEffect(() => { void load(); }, [load]);

  const paid = useCallback((p: Payment) => {
    if (p.status === 'SUCCEEDED') { setNotice('Paid. Your ad is in review and starts as soon as it is approved.'); setPaying(null); void load(); }
    else setError(p.failureReason ?? 'The payment did not go through.');
  }, [load]);
  const { watch } = usePaymentWatch(paid);
  useEffect(() => { const id = params.get('payment'); if (id) api<{ payment: Payment }>(`/billing/payments/${id}`).then((r) => (r.payment.status === 'PENDING' ? watch(r.payment) : paid(r.payment))).catch(() => undefined); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const usable = videos.filter((v) => v.status === 'READY' && v.visibility !== 'PRIVATE' && v.durationSeconds >= 5 && v.durationSeconds <= 90 && !v.takenDownAt);
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ campaign: Campaign }>('/ads/campaigns', { body: { businessName: form.businessName, country: form.country, headline: form.headline, destinationUrl: form.destinationUrl, videoId: form.videoId, days: form.days, targetCountries: form.target ? [form.target] : [] } });
      setCreating(false); setPaying(r.campaign); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const act = async (c: Campaign, what: 'pause' | 'delete') => {
    setError(null);
    try { await api(`/ads/campaigns/${c.id}${what === 'pause' ? '/pause' : ''}`, { method: what === 'pause' ? 'POST' : 'DELETE', body: what === 'pause' ? {} : undefined }); await load(); } catch (e) { setError((e as Error).message); }
  };

  if (!plans || !list) return error ? <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const rate = plans.ads.usdCentsPerDay;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="flex items-center gap-2 font-display text-[28px] font-extrabold"><Icon.Megaphone size={28} />Ads Manager</h1>
          <p className="mt-1 max-w-2xl text-[15px] text-muted">Show your business to viewers with a short video ad. <b className="text-ink">{usd(rate, locale)} a day</b>, paid up front with MTN MoMo or a card. Your ad plays before videos of monetised creators (never more than {plans.ads.maxAdsPerVideo} ads on a video), and viewers can skip it after 5 seconds.</p>
        </div>
        {!creating && <button type="button" onClick={() => setCreating(true)} className="flex h-11 items-center gap-2 rounded-2xl bg-brand px-4 text-[14px] font-bold text-on-brand hover:bg-brand-strong"><Icon.Plus size={20} />New ad</button>}
      </div>
      {notice && <p role="status" className="mt-4 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      {creating && (
        <section className="mt-6 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
          <h2 className="font-display text-[20px] font-bold">New video ad</h2>
          {!viewer.channel ? (
            <p className="mt-3 text-[15px] text-muted">Your ad is a short video you upload to your own Space. <Link href="/channel/create" className="font-semibold text-brand underline">Create your Space</Link>, upload a 5–90 second video and set it to <b>Unlisted</b>, then come back here.</p>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block"><span className="text-[13px] font-semibold">Business name</span><input className={`mt-1 ${inputClass}`} value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} maxLength={100} /></label>
              <label className="block"><span className="text-[13px] font-semibold">Business country</span><span className="mt-1 block"><CountrySelect value={form.country} onChange={(country) => setForm({ ...form, country })} emptyLabel="Choose" /></span></label>
              <label className="block sm:col-span-2"><span className="text-[13px] font-semibold">Headline</span><input className={`mt-1 ${inputClass}`} value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} maxLength={90} placeholder="Fresh coffee, delivered in Kigali" /></label>
              <label className="block sm:col-span-2"><span className="text-[13px] font-semibold">Website (where “Visit” goes)</span><input className={`mt-1 ${inputClass}`} value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} inputMode="url" /></label>
              <label className="block sm:col-span-2"><span className="text-[13px] font-semibold">Ad video</span>
                <select className={`mt-1 ${inputClass}`} value={form.videoId} onChange={(e) => setForm({ ...form, videoId: e.target.value })}>
                  <option value="">{usable.length ? 'Choose one of your videos' : 'No suitable video yet'}</option>
                  {usable.map((v) => <option key={v.id} value={v.id}>{v.title} ({duration(v.durationSeconds)})</option>)}
                </select>
                <span className="mt-1 block text-[12px] text-muted">5–90 seconds, finished processing, Public or Unlisted. <Link href="/hub" className="underline">Upload one in Creator Hub</Link>.</span>
              </label>
              <label className="block"><span className="text-[13px] font-semibold">Show it in</span><span className="mt-1 block"><CountrySelect value={form.target} onChange={(target) => setForm({ ...form, target })} emptyLabel="Every country" /></span></label>
              <label className="block"><span className="text-[13px] font-semibold">Days: {form.days}</span>
                <input type="range" min={1} max={90} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} className="mt-3 w-full accent-[var(--brand)]" />
              </label>
              <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-4 py-3 sm:col-span-2">
                <span className="text-[15px]">{form.days} {form.days === 1 ? 'day' : 'days'} × {usd(rate, locale)} = <b className="font-display text-[20px]">{usd(rate * form.days, locale)}</b></span>
                <span className="ml-auto flex gap-2">
                  {!!list.campaigns.length && <button type="button" onClick={() => setCreating(false)} className="h-11 rounded-2xl px-4 text-[14px] font-semibold text-muted hover:bg-surface-hover">Cancel</button>}
                  <button type="button" disabled={busy || !form.videoId || !form.country || form.headline.trim().length < 3 || form.businessName.trim().length < 2} onClick={() => void create()} className="h-11 rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">Continue to payment</button>
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {paying && (
        <section className="mt-6 rounded-3xl border-2 border-brand bg-elevated p-5 sm:p-6">
          <div className="flex items-start gap-3"><div className="flex-1"><h2 className="font-display text-[20px] font-bold">Pay for “{paying.headline}”</h2><p className="text-[14px] text-muted">{paying.days} {paying.days === 1 ? 'day' : 'days'}. It starts when our team approves it, usually within a day.</p></div><button type="button" onClick={() => setPaying(null)} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={20} /></button></div>
          <div className="mt-4 max-w-lg"><PayPanel usdCents={paying.totalCents} plans={plans} label="Pay for ad" onPaid={paid} start={async (method, phone) => (await api<{ payment: Payment }>(`/ads/campaigns/${paying.id}/pay`, { body: { method, phone } })).payment} /></div>
        </section>
      )}

      <section className="mt-8 space-y-3">
        {list.campaigns.map((c) => {
          const [label, cls] = STATUS[c.status];
          const ctr = c.impressions ? ((c.clicks / c.impressions) * 100).toFixed(1) : '0.0';
          return (
            <article key={c.id} className="rounded-3xl border border-line bg-elevated p-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2"><span className="font-display text-[18px] font-bold">{c.headline}</span><span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${cls}`}>{label}</span></p>
                  <p className="mt-0.5 truncate text-[13px] text-muted">{c.businessName} · {c.video?.title ?? 'video removed'} · {c.targetCountries.length ? c.targetCountries.join(', ') : 'every country'} · {c.days} {c.days === 1 ? 'day' : 'days'} ({usd(c.totalCents, locale)})</p>
                  {c.startDate && c.endDate && <p className="text-[13px] text-muted">{new Date(c.startDate).toLocaleDateString(locale)} – {new Date(c.endDate).toLocaleDateString(locale)}</p>}
                  {c.reviewNote && <p className={`mt-1 text-[13px] ${c.status === 'REJECTED' ? 'text-danger' : 'text-muted'}`}>Review note: {c.reviewNote}</p>}
                </div>
                <dl className="grid grid-cols-3 gap-4 text-center">
                  <div><dt className="text-[11px] uppercase tracking-wide text-muted">Shown</dt><dd className="font-display text-[20px] font-bold tabular-nums">{c.impressions.toLocaleString(locale)}</dd></div>
                  <div><dt className="text-[11px] uppercase tracking-wide text-muted">Visits</dt><dd className="font-display text-[20px] font-bold tabular-nums">{c.clicks.toLocaleString(locale)}</dd></div>
                  <div><dt className="text-[11px] uppercase tracking-wide text-muted">Rate</dt><dd className="font-display text-[20px] font-bold tabular-nums">{ctr}%</dd></div>
                </dl>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {c.status === 'DRAFT' && <><button type="button" onClick={() => setPaying(c)} className="h-9 rounded-xl bg-brand px-4 text-[13px] font-bold text-on-brand">Pay {usd(c.totalCents, locale)}</button><button type="button" onClick={() => void act(c, 'delete')} className="h-9 rounded-xl px-3 text-[13px] font-semibold text-muted hover:bg-surface">Delete</button></>}
                {(c.status === 'ACTIVE' || c.status === 'PAUSED') && <button type="button" onClick={() => void act(c, 'pause')} className="h-9 rounded-xl bg-surface px-4 text-[13px] font-semibold hover:bg-surface-hover">{c.status === 'ACTIVE' ? 'Pause' : 'Resume'}</button>}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
