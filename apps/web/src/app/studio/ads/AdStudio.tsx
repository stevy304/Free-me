'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { CountrySelect, inputClass } from '@/components/Pickers';
import { PayPanel, usePaymentWatch } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { duration } from '@/lib/format';
import { charge, money, usd } from '@/lib/money';
import { VideoUpload, type UploadSnapshot } from '@/lib/uploader';
import type { HubVideo } from '@/components/hub/types';
import type { Payment, Plans, Viewer } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';
import { VerifyBusiness } from './VerifyBusiness';

interface Campaign {
  id: string; status: 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'REJECTED'; businessName: string; headline: string; destinationUrl: string; days: number;
  dailyRateCents: number; totalCents: number; targetCountries: string[]; startDate: string | null; endDate: string | null; reviewNote: string | null;
  impressions: number; clicks: number; video: { id: string; title: string; durationSeconds: number } | null; createdAt: string;
  /** Priced per 1,000 impressions (null: an older campaign priced per day). */
  cpmCents?: number | null; viewsBought?: number | null; viewsPerDay?: number | null; spentCents?: number; deliverUntil?: string | null;
}
const STATUS: Record<Campaign['status'], [string, string]> = {
  DRAFT: ['Not paid yet', 'bg-surface'], PENDING_REVIEW: ['Paid · in review', 'bg-accent-soft text-on-accent-soft'], ACTIVE: ['Running', 'bg-brand-soft text-brand'],
  PAUSED: ['Paused', 'bg-surface'], COMPLETED: ['Finished', 'bg-surface text-muted'], REJECTED: ['Not approved', 'bg-danger/10 text-danger'],
};
const MIN_SECONDS = 5;
const MAX_SECONDS = 90;
const fits = (v: HubVideo) => v.durationSeconds >= MIN_SECONDS && v.durationSeconds <= MAX_SECONDS;
const usableVideo = (v: HubVideo) => v.status === 'READY' && v.visibility !== 'PRIVATE' && fits(v) && !v.takenDownAt;
const busyVideo = (v: HubVideo) => v.status === 'UPLOADING' || v.status === 'PROCESSING';

/**
 * Ad Studio (Premium): a business's own place for video ads. Ad videos are uploaded here and kept apart from the
 * Space's videos (never in feeds, search or the Space page); campaigns run them before videos, by the day.
 */
export function AdStudio({ viewer }: { viewer: Viewer }) {
  const { locale } = useShell();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plans | null>(null);
  const [list, setList] = useState<{ business: { name: string; country: string } | null; campaigns: Campaign[] } | null>(null);
  const [adVideos, setAdVideos] = useState<HubVideo[]>([]);
  const [spaceVideos, setSpaceVideos] = useState<HubVideo[]>([]);
  const [uploads, setUploads] = useState<Array<{ key: number; upload: VideoUpload; snap: UploadSnapshot }>>([]);
  const [form, setForm] = useState({ businessName: '', country: viewer.profile?.country ?? null as string | null, headline: '', destinationUrl: 'https://', videoId: '', funds: '', days: 7, placements: '', channels: '', target: null as string | null });
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Campaign | null>(null);
  // Add funds: which paid ad, and how much (dollars, as typed).
  const [topUp, setTopUp] = useState<{ id: string; amount: string } | null>(null);
  const topUpRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLElement>(null);
  const uploadKey = useRef(0);

  const loadVideos = useCallback(async () => {
    if (!viewer.channel) return;
    const [ads, space] = await Promise.all([api<{ videos: HubVideo[] }>('/hub/videos?ads=true'), api<{ videos: HubVideo[] }>('/hub/videos')]);
    setAdVideos(ads.videos); setSpaceVideos(space.videos.filter(usableVideo));
  }, [viewer.channel]);
  const load = useCallback(async () => {
    try {
      const [p, l] = await Promise.all([api<Plans>('/billing/plans'), api<typeof list>('/ads/campaigns'), loadVideos()]);
      setPlans(p); setList(l);
      if (l?.business) setForm((f) => ({ ...f, businessName: f.businessName || l.business!.name, country: f.country ?? l.business!.country }));
    } catch (e) { setError((e as Error).message); }
  }, [loadVideos]);
  useEffect(() => { void load(); }, [load]);

  // While an ad video is uploading or processing, check on it every few seconds.
  const working = adVideos.some(busyVideo);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => { void loadVideos().catch(() => undefined); }, 4000);
    return () => clearInterval(t);
  }, [working, loadVideos]);

  const paid = useCallback((p: Payment) => {
    if (p.status === 'SUCCEEDED') { setNotice('Paid. Your ad is in review and starts as soon as it is approved.'); setPaying(null); void load(); }
    else setError(p.failureReason ?? 'The payment did not go through.');
  }, [load]);
  const { watch } = usePaymentWatch(paid);
  useEffect(() => { const id = params.get('payment'); if (id) api<{ payment: Payment }>(`/billing/payments/${id}`).then((r) => (r.payment.status === 'PENDING' ? watch(r.payment) : paid(r.payment))).catch(() => undefined); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      if (!file.type.startsWith('video/')) { setError(`${file.name} is not a video.`); continue; }
      const key = ++uploadKey.current;
      const upload = new VideoUpload(file, (snap) => {
        setUploads((all) => all.map((u) => (u.key === key ? { ...u, snap } : u)));
        if (snap.state === 'done') { setUploads((all) => all.filter((u) => u.key !== key)); void loadVideos(); }
      }, { ad: true });
      setUploads((all) => [...all, { key, upload, snap: upload.snapshot }]);
      void upload.start().then(() => loadVideos()).catch(() => undefined);
    }
  };
  const useVideo = (v: HubVideo) => { setForm((f) => ({ ...f, videoId: v.id, headline: f.headline || v.title })); setCreating(true); setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };
  const removeVideo = async (v: HubVideo) => {
    if (!window.confirm(`Delete “${v.title}”? Ads already paid for with it stop showing it.`)) return;
    try { await api(`/hub/videos/${v.id}`, { method: 'DELETE' }); await loadVideos(); } catch (e) { setError((e as Error).message); }
  };
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ campaign: Campaign }>('/ads/campaigns', { body: { businessName: form.businessName, country: form.country, headline: form.headline, destinationUrl: form.destinationUrl, videoId: form.videoId, budgetUsdCents: Math.round(Number(form.funds) * 100), days: form.days, targetCountries: form.target ? [form.target] : [], targetVideoIds: form.placements.split(/[,\s]+/).filter(Boolean).map((value) => value.match(/\/watch\/([^/?#]+)/)?.[1] ?? value), targetChannelHandles: form.channels.split(/[,\s]+/).filter(Boolean) } });
      setCreating(false); setPaying(r.campaign); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const isAdmin = viewer.user.roles.includes('ADMIN');
  /** Administrators can run an ad without payment (tests, partners, Free Me's own ads): it runs at $0 a day. */
  const startFree = async (c: Campaign) => {
    setError(null);
    try { await api(`/admin/billing/campaigns/${c.id}/review`, { body: { approve: true, free: true } }); setNotice('Running now, without payment. It plays before videos of Spaces in the monetisation programme.'); await load(); }
    catch (e) { setError((e as Error).message); }
  };
  const act = async (c: Campaign, what: 'pause' | 'delete') => {
    setError(null);
    try { await api(`/ads/campaigns/${c.id}${what === 'pause' ? '/pause' : ''}`, { method: what === 'pause' ? 'POST' : 'DELETE', body: what === 'pause' ? {} : undefined }); await load(); } catch (e) { setError((e as Error).message); }
  };

  if (!plans || !list) return error ? <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const cpm = plans.ads.usdCentsPer1000Views ?? 100;
  const minimum = plans.ads.minBudgetUsdCents ?? 200;
  const fundsCents = Math.round(Number(form.funds || 0) * 100);
  const localMethod = plans.methods.find((m) => m.currency !== 'USD');
  const localPrice = (cents: number) => localMethod ? money(charge(cents, localMethod), localMethod.currency, locale) : null;
  const presets = [...new Set([minimum, Math.max(minimum, 500), Math.max(minimum, 1000)])];
  const readyAds = adVideos.filter(usableVideo);
  const running = list.campaigns.filter((c) => c.status === 'ACTIVE').length;
  const shown = list.campaigns.reduce((n, c) => n + c.impressions, 0);
  const visits = list.campaigns.reduce((n, c) => n + c.clicks, 0);
  // Funds: what was paid in, what impressions have used, and what is left to spend (paid ads only).
  const paidAds = list.campaigns.filter((c) => c.status !== 'DRAFT' && c.status !== 'REJECTED');
  const fundable = paidAds.filter((c) => c.cpmCents && c.cpmCents >= cpm);
  const added = paidAds.reduce((n, c) => n + c.totalCents, 0);
  const spent = paidAds.reduce((n, c) => n + (c.spentCents ?? 0), 0);
  const left = Math.max(0, added - spent);
  const remainingImpressions = paidAds.reduce((n, c) => n + (c.cpmCents ? Math.floor(Math.max(0, c.totalCents - (c.spentCents ?? 0)) * 1000 / c.cpmCents) : 0), 0);
  const topUpAd = topUp ? list.campaigns.find((c) => c.id === topUp.id) ?? null : null;
  const topUpCents = Math.round(Number(topUp?.amount || 0) * 100);
  const openTopUp = (c?: Campaign) => {
    const target = c ?? fundable.find((x) => x.status === 'ACTIVE') ?? fundable[0];
    if (!target) { setCreating(true); setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); return; }
    setPaying(null); setTopUp({ id: target.id, amount: String(minimum / 100) });
    setTimeout(() => topUpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="min-w-0 sm:flex-1">
          <h1 className="flex items-center gap-2 font-display text-[28px] font-extrabold"><Icon.Megaphone size={28} />Ad Studio</h1>
          <p className="mt-1 max-w-2xl text-[15px] text-muted">Upload a short video ad, add funds (from <b className="text-ink">{usd(minimum, locale)}</b>) and pay for ad impressions: <b className="text-ink">{usd(cpm, locale)} per 1,000 ad impressions</b>. Never more than {plans.ads.maxAdsPerVideo} ads on a video, and viewers can skip after 5 seconds.</p>
        </div>
        {viewer.channel && <button type="button" onClick={() => fileInput.current?.click()} className="flex h-11 self-start items-center gap-2 rounded-2xl bg-surface px-4 text-[14px] font-bold hover:bg-surface-hover"><Icon.Upload size={20} />Upload ad video</button>}
        {viewer.channel && !creating && <button type="button" onClick={() => setCreating(true)} className="flex h-11 items-center gap-2 rounded-2xl bg-brand px-4 text-[14px] font-bold text-on-brand hover:bg-brand-strong"><Icon.Plus size={20} />New ad</button>}
        <input ref={fileInput} type="file" accept="video/*" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
      </div>
      <section aria-label="Starter advertising budgets" className="mt-6 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h2 className="font-display text-xl font-bold">Start small. Set your total budget.</h2><p className="mt-1 text-sm text-muted">No daily minimum. Choose a country and an eligible video or channel audience.</p></div>
          <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm font-semibold text-brand">{(plans.ads.creatorShareBps ?? 7000) / 100}% to the long-video creator pool</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {presets.map((amount, i) => <button key={amount} type="button" onClick={() => { setForm((f) => ({ ...f, funds: String(amount / 100), target: f.target ?? viewer.profile?.country ?? null })); setCreating(true); setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }} className="rounded-2xl border border-line p-4 text-left hover:border-brand hover:bg-brand-soft">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">{['Try it', 'Build awareness', 'Reach more'][i]}</span>
            <strong className="mt-1 block font-display text-2xl">{localPrice(amount) ?? usd(amount, locale)}</strong>
            {localMethod && <span className="text-xs text-muted">{usd(amount, locale)} media budget · converted at checkout</span>}
            <span className="mt-2 block text-sm">Up to {Math.floor(amount * 1000 / cpm).toLocaleString(locale)} ad impressions</span>
          </button>)}
        </div>
        <p className="mt-3 text-xs text-muted">An impression is an ad shown, including a subsequently skipped ad. It is not a completed view or a unique customer. Delivery depends on matching viewers; sales are not guaranteed.</p>
      </section>
      {notice && <p role="status" className="mt-4 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      {!viewer.channel ? (
        <section className="mt-6 rounded-3xl border border-line bg-elevated p-6">
          <h2 className="font-display text-[20px] font-bold">First, create your Space</h2>
          <p className="mt-2 text-[15px] text-muted">Ads are shown under your Space’s name and badge. <Link href="/channel/create" className="font-semibold text-brand underline">Create your Space</Link>, then come back to upload your first ad.</p>
        </section>
      ) : (
        <>
          <section aria-labelledby="funds-heading" className="mt-6 overflow-hidden rounded-3xl border border-line bg-elevated">
            <div className="flex flex-col items-stretch gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
              <div className="min-w-0 flex-1">
                <h2 id="funds-heading" className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted"><Icon.Wallet size={16} />Ad funds</h2>
                <p className="mt-1 font-display text-[34px] font-extrabold leading-none tabular-nums">{usd(left, locale)}</p>
                <p className="mt-1.5 text-[14px] text-muted">left to spend · about <b className="text-ink">{remainingImpressions.toLocaleString(locale)} more impressions</b> across campaigns at their booked rates</p>
              </div>
              <button type="button" onClick={() => openTopUp()} className="flex h-12 items-center gap-2 rounded-2xl bg-brand px-5 text-[15px] font-bold text-on-brand hover:bg-brand-strong"><Icon.Plus size={20} />Add funds</button>
            </div>
            <dl className="grid grid-cols-2 border-t border-line sm:grid-cols-4">
              {([['Added', usd(added, locale)], ['Spent', usd(spent, locale)], ['Times shown', shown.toLocaleString(locale)], ['Visits to your site', visits.toLocaleString(locale)]] as const).map(([l, v], i) => (
                <div key={l} className={`p-4 sm:px-6 ${i % 2 ? 'border-l border-line' : ''} ${i >= 2 ? 'border-t border-line sm:border-t-0' : ''} ${i === 2 ? 'sm:border-l' : ''}`}><dt className="text-[13px] text-muted">{l}</dt><dd className="font-display text-[20px] font-bold tabular-nums">{v}</dd></div>
              ))}
            </dl>
            {added > 0 && <div className="h-1.5 bg-surface" title={`${Math.round((spent / added) * 100)}% spent`}><div className="h-full bg-brand transition-[width]" style={{ width: `${Math.min(100, (spent / added) * 100)}%` }} /></div>}
            <p className="border-t border-line bg-surface px-5 py-2.5 text-[13px] text-muted sm:px-6">{running ? `${running} ${running === 1 ? 'ad is' : 'ads are'} running now.` : 'No ad is running right now.'} You pay for delivered ad impressions. Undelivered funds stay unspent; contact support if the delivery window has ended.</p>
          </section>

          {topUp && topUpAd && (
            <section ref={topUpRef} aria-labelledby="topup-heading" className="mt-6 scroll-mt-24 rounded-3xl border-2 border-brand bg-elevated p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <div className="flex-1"><h2 id="topup-heading" className="font-display text-[20px] font-bold">Add funds</h2><p className="text-[14px] text-muted">More impressions for an ad you already run, at the same daily pace. A finished ad starts again.</p></div>
                <button type="button" onClick={() => setTopUp(null)} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-xl hover:bg-surface"><Icon.Close size={20} /></button>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block"><span className="text-[13px] font-semibold">Ad</span>
                  <select className={`mt-1 ${inputClass}`} value={topUp.id} onChange={(e) => setTopUp({ ...topUp, id: e.target.value })}>
                    {fundable.map((c) => <option key={c.id} value={c.id}>{c.headline} · {STATUS[c.status][0]}</option>)}
                  </select>
                </label>
                <label className="block"><span className="text-[13px] font-semibold">Amount (US dollars, from {usd(minimum, locale)})</span>
                  <input type="number" min={minimum / 100} step={0.01} inputMode="decimal" className={`mt-1 ${inputClass}`} value={topUp.amount} onChange={(e) => setTopUp({ ...topUp, amount: e.target.value })} />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[7, 15, 30, 50, 100].filter((d) => d * 100 >= minimum).map((d) => (
                  <button key={d} type="button" onClick={() => setTopUp({ ...topUp, amount: String(d) })} className={`h-9 rounded-full border px-4 text-[13px] font-semibold ${Number(topUp.amount) === d ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:bg-surface'}`}>{usd(d * 100, locale)}</button>
                ))}
              </div>
              <p className="mt-3 text-[15px]"><b className="font-display text-[20px]">{usd(topUpCents, locale)}</b> = about <b>{Math.floor((topUpCents * 1000) / (topUpAd.cpmCents ?? cpm)).toLocaleString(locale)} more impressions</b> for “{topUpAd.headline}”</p>
              {topUpCents >= minimum
                ? <div className="mt-4 max-w-lg"><PayPanel key={topUp.id} usdCents={topUpCents} plans={plans} label="Add funds" onPaid={() => { setTopUp(null); setNotice(`Funds added to “${topUpAd.headline}”.`); void load(); }} start={async (method, phone) => (await api<{ payment: Payment }>(`/ads/campaigns/${topUp.id}/funds`, { body: { method, phone, usdCents: topUpCents } })).payment} /></div>
                : <p className="mt-3 text-[13px] text-danger">Add at least {usd(minimum, locale)}.</p>}
            </section>
          )}

          <section className="mt-8" aria-labelledby="ad-videos">
            <div className="flex flex-wrap items-baseline gap-2"><h2 id="ad-videos" className="font-display text-[20px] font-bold">Ad videos</h2><span className="text-[13px] text-muted">{MIN_SECONDS}–{MAX_SECONDS} seconds · only played as ads, never in feeds</span></div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {uploads.map(({ key, upload, snap }) => (
                <article key={key} className="rounded-2xl border border-line p-3">
                  <div className="grid aspect-video place-items-center rounded-xl bg-surface"><Icon.Upload size={28} className="text-muted" /></div>
                  <p className="mt-2 truncate text-[14px] font-semibold">{snap.title}</p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full bg-brand transition-[width]" style={{ width: `${snap.total ? Math.round((snap.sent / snap.total) * 100) : 0}%` }} /></div>
                  <p className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                    <span className="flex-1">{snap.state === 'error' ? <span className="text-danger">{snap.error}</span> : snap.reconnecting ? 'Reconnecting…' : snap.state === 'finishing' ? 'Finishing…' : snap.state === 'compressing' ? `Making it smaller ${Math.round((snap.compress?.progress ?? 0) * 100)}%` : `Uploading ${snap.total ? Math.round((snap.sent / snap.total) * 100) : 0}%`}</span>
                    {snap.state === 'error' ? <button type="button" onClick={() => void upload.start()} className="font-semibold text-brand">Try again</button> : <button type="button" onClick={() => { void upload.cancel(); setUploads((all) => all.filter((u) => u.key !== key)); }} className="font-semibold">Cancel</button>}
                  </p>
                </article>
              ))}
              {adVideos.map((v) => {
                const ready = usableVideo(v);
                const problem = v.status === 'FAILED' ? (v.processingError ?? 'This video could not be processed.') : v.takenDownAt ? 'Removed' : v.status === 'READY' && !fits(v) ? `${duration(v.durationSeconds)}: an ad must be ${MIN_SECONDS}–${MAX_SECONDS} seconds` : null;
                return (
                  <article key={v.id} className="rounded-2xl border border-line p-3">
                    <div className="relative aspect-video overflow-hidden rounded-xl bg-surface">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                      {busyVideo(v) && <span className="absolute inset-0 grid place-items-center bg-black/40 text-[13px] font-semibold text-white"><span className="flex items-center gap-2"><Icon.Spinner size={18} className="animate-spin" />{v.processingStage ?? 'Processing'} {v.processingProgress ? `${v.processingProgress}%` : ''}</span></span>}
                      {v.durationSeconds > 0 && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 text-[12px] font-semibold tabular-nums text-white">{duration(v.durationSeconds)}</span>}
                    </div>
                    <p className="mt-2 truncate text-[14px] font-semibold" title={v.title}>{v.title}</p>
                    {problem && <p className="text-[12px] text-danger">{problem}</p>}
                    <div className="mt-2 flex gap-2">
                      <button type="button" disabled={!ready} onClick={() => useVideo(v)} className="h-9 flex-1 rounded-xl bg-brand px-3 text-[13px] font-bold text-on-brand disabled:opacity-40">Run this ad</button>
                      {v.playbackUrl && <a href={`/watch?v=${v.id}`} target="_blank" rel="noreferrer" className="grid h-9 w-9 place-items-center rounded-xl bg-surface hover:bg-surface-hover" aria-label="Preview"><Icon.Play size={18} /></a>}
                      <button type="button" onClick={() => void removeVideo(v)} className="grid h-9 w-9 place-items-center rounded-xl bg-surface hover:bg-surface-hover" aria-label={`Delete ${v.title}`}><Icon.Trash size={18} /></button>
                    </div>
                  </article>
                );
              })}
              {!adVideos.length && !uploads.length && (
                <button type="button" onClick={() => fileInput.current?.click()} className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line p-8 text-center hover:bg-surface sm:col-span-2 lg:col-span-3">
                  <Icon.Upload size={30} className="text-muted" />
                  <span className="text-[15px] font-semibold">Upload your first ad video</span>
                  <span className="text-[13px] text-muted">A short clip, {MIN_SECONDS} to {MAX_SECONDS} seconds. Upright or wide, any common format.</span>
                </button>
              )}
            </div>
          </section>

          {creating && (
            <section ref={formRef} className="mt-8 scroll-mt-20 rounded-3xl border border-line bg-elevated p-5 sm:p-6">
              <h2 className="font-display text-[20px] font-bold">New ad</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block"><span className="text-[13px] font-semibold">Business name</span><input className={`mt-1 ${inputClass}`} value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} maxLength={100} /></label>
                <label className="block"><span className="text-[13px] font-semibold">Business country</span><span className="mt-1 block"><CountrySelect value={form.country} onChange={(country) => setForm({ ...form, country })} emptyLabel="Choose" /></span></label>
                <label className="block sm:col-span-2"><span className="text-[13px] font-semibold">Headline</span><input className={`mt-1 ${inputClass}`} value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} maxLength={90} placeholder="What you offer, in a few words" /></label>
                <label className="block sm:col-span-2"><span className="text-[13px] font-semibold">Website (where “Visit” goes)</span><input className={`mt-1 ${inputClass}`} value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} inputMode="url" /></label>
                <label className="block sm:col-span-2"><span className="text-[13px] font-semibold">Ad video</span>
                  <select className={`mt-1 ${inputClass}`} value={form.videoId} onChange={(e) => setForm({ ...form, videoId: e.target.value })}>
                    <option value="">{readyAds.length || spaceVideos.length ? 'Choose a video' : 'Upload an ad video first'}</option>
                    {!!readyAds.length && <optgroup label="Ad videos">{readyAds.map((v) => <option key={v.id} value={v.id}>{v.title} ({duration(v.durationSeconds)})</option>)}</optgroup>}
                    {!!spaceVideos.length && <optgroup label="From your Space">{spaceVideos.map((v) => <option key={v.id} value={v.id}>{v.title} ({duration(v.durationSeconds)})</option>)}</optgroup>}
                  </select>
                </label>
                <label className="block"><span className="text-[13px] font-semibold">Video placements</span><input className={`mt-1 ${inputClass}`} value={form.placements} onChange={(e) => setForm({ ...form, placements: e.target.value })} placeholder="Paste public video links or IDs" maxLength={4000} /></label>
                <label className="block"><span className="text-[13px] font-semibold">Channel placements</span><input className={`mt-1 ${inputClass}`} value={form.channels} onChange={(e) => setForm({ ...form, channels: e.target.value })} placeholder="@channel, @another-channel" maxLength={1200} /></label>
                <p className="text-sm text-muted sm:col-span-2">Separate placements with commas. Ads can appear on any selected video or channel, subject to the country filter. Leave both blank to reach all eligible content.</p>
                <label className="block"><span className="text-[13px] font-semibold">Show it in</span><span className="mt-1 block"><CountrySelect value={form.target} onChange={(target) => setForm({ ...form, target })} emptyLabel="Every country" /></span></label>
                <label className="block"><span className="text-[13px] font-semibold">Funds (US dollars, at least {usd(minimum, locale)})</span>
                  <input type="number" min={minimum / 100} step={0.01} inputMode="decimal" className={`mt-1 ${inputClass}`} value={form.funds} onChange={(e) => setForm({ ...form, funds: e.target.value })} placeholder={String(minimum / 100)} />
                </label>
                <label className="block"><span className="text-[13px] font-semibold">Spread over {form.days} {form.days === 1 ? 'day' : 'days'}</span>
                  <input type="range" min={1} max={90} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} className="mt-3 w-full accent-[var(--brand)]" />
                </label>
                <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-4 py-3 sm:col-span-2">
                  <span className="text-[15px]"><b className="font-display text-[20px]">{usd(fundsCents, locale)}</b> = up to <b>{Math.floor((fundsCents * 1000) / cpm).toLocaleString(locale)} ad impressions</b>
                    <span className="block text-[13px] text-muted">About {Math.floor((fundsCents * 1000) / cpm / form.days).toLocaleString(locale)} impressions a day for {form.days} {form.days === 1 ? 'day' : 'days'}; delivery may continue during the campaign’s make-good window. Any undelivered funds remain unspent; contact support for a reviewed refund or delivery arrangement.</span></span>
                  <span className="ml-auto flex gap-2">
                    <button type="button" onClick={() => setCreating(false)} className="h-11 rounded-2xl px-4 text-[14px] font-semibold text-muted hover:bg-surface-hover">Cancel</button>
                    <button type="button" disabled={busy || !form.videoId || !form.country || form.headline.trim().length < 3 || form.businessName.trim().length < 2 || (!Number.isSafeInteger(fundsCents) || fundsCents < minimum)} onClick={() => void create()} className="h-11 rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">Continue to payment</button>
                  </span>
                </div>
              </div>
            </section>
          )}

          {paying && (
            <section className="mt-6 rounded-3xl border-2 border-brand bg-elevated p-5 sm:p-6">
              <div className="flex items-start gap-3"><div className="flex-1"><h2 className="font-display text-[20px] font-bold">Pay for “{paying.headline}”</h2><p className="text-[14px] text-muted">{usd(paying.totalCents, locale)} of funds. It starts when our team approves it, usually within a day.</p></div><button type="button" onClick={() => setPaying(null)} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={20} /></button></div>
              <div className="mt-4 max-w-lg"><PayPanel usdCents={paying.totalCents} plans={plans} label="Pay for ad" onPaid={paid} start={async (method, phone) => (await api<{ payment: Payment }>(`/ads/campaigns/${paying.id}/pay`, { body: { method, phone } })).payment} /></div>
            </section>
          )}

          <section className="mt-8" aria-labelledby="campaigns">
            <h2 id="campaigns" className="font-display text-[20px] font-bold">Your ads</h2>
            {!list.campaigns.length && <p className="mt-2 text-[14px] text-muted">No ads yet. Upload an ad video, then choose <b>Run this ad</b>.</p>}
            <div className="mt-3 space-y-3">
              {list.campaigns.map((c) => {
                const [label, cls] = STATUS[c.status];
                const ctr = c.impressions ? ((c.clicks / c.impressions) * 100).toFixed(1) : '0.0';
                return (
                  <article key={c.id} className="rounded-3xl border border-line bg-elevated p-5">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2"><span className="font-display text-[18px] font-bold">{c.headline}</span><span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${cls}`}>{label}</span></p>
                        <p className="mt-0.5 truncate text-[13px] text-muted">{c.businessName} · {c.video?.title ?? 'video removed'} · {c.targetCountries.length ? c.targetCountries.join(', ') : 'every country'} · {usd(c.totalCents, locale)} of funds{c.spentCents !== undefined ? `, ${usd(c.spentCents, locale)} spent` : ''}</p>
                        {c.startDate && c.endDate && <p className="text-[13px] text-muted">{new Date(c.startDate).toLocaleDateString(locale)} – {new Date(c.endDate).toLocaleDateString(locale)}</p>}
                        {c.viewsBought && <p className="text-[13px] text-muted">{c.impressions.toLocaleString(locale)} of {c.viewsBought.toLocaleString(locale)} impressions delivered (up to {c.viewsPerDay?.toLocaleString(locale)} a day){c.deliverUntil && c.impressions < c.viewsBought ? `; the rest by ${new Date(c.deliverUntil).toLocaleDateString(locale)}` : ''}</p>}
                        {c.reviewNote && <p className={`mt-1 text-[13px] ${c.status === 'REJECTED' ? 'text-danger' : 'text-muted'}`}>Review note: {c.reviewNote}</p>}
                      </div>
                      <dl className="grid grid-cols-3 gap-4 text-center">
                        <div><dt className="text-[11px] uppercase tracking-wide text-muted">Shown</dt><dd className="font-display text-[20px] font-bold tabular-nums">{c.impressions.toLocaleString(locale)}</dd></div>
                        <div><dt className="text-[11px] uppercase tracking-wide text-muted">Visits</dt><dd className="font-display text-[20px] font-bold tabular-nums">{c.clicks.toLocaleString(locale)}</dd></div>
                        <div><dt className="text-[11px] uppercase tracking-wide text-muted">Rate</dt><dd className="font-display text-[20px] font-bold tabular-nums">{ctr}%</dd></div>
                      </dl>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {c.status === 'DRAFT' && isAdmin && <button type="button" onClick={() => void startFree(c)} className="h-9 rounded-xl border border-brand px-4 text-[13px] font-bold text-brand hover:bg-brand-soft">Start now without payment</button>}
                      {c.status === 'DRAFT' && <><button type="button" onClick={() => setPaying(c)} className="h-9 rounded-xl bg-brand px-4 text-[13px] font-bold text-on-brand">Pay {usd(c.totalCents, locale)}</button><button type="button" onClick={() => void act(c, 'delete')} className="h-9 rounded-xl px-3 text-[13px] font-semibold text-muted hover:bg-surface">Delete</button></>}
                      {c.cpmCents && c.status !== 'DRAFT' && c.status !== 'REJECTED' && <button type="button" onClick={() => openTopUp(c)} className="flex h-9 items-center gap-1.5 rounded-xl bg-brand px-4 text-[13px] font-bold text-on-brand"><Icon.Plus size={16} />Add funds</button>}
                      {(c.status === 'ACTIVE' || c.status === 'PAUSED') && <button type="button" onClick={() => void act(c, 'pause')} className="h-9 rounded-xl bg-surface px-4 text-[13px] font-semibold hover:bg-surface-hover">{c.status === 'ACTIVE' ? 'Pause' : 'Resume'}</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
      {viewer.channel && <VerifyBusiness plans={plans} />}
    </div>
  );
}
