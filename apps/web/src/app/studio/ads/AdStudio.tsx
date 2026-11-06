'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { CountrySelect, inputClass } from '@/components/Pickers';
import { PayPanel, usePaymentWatch } from '@/components/billing/PayPanel';
import { api } from '@/lib/client-api';
import { duration } from '@/lib/format';
import { usd } from '@/lib/money';
import { VideoUpload, type UploadSnapshot } from '@/lib/uploader';
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
  const premium = viewer.premium.active;
  const [plans, setPlans] = useState<Plans | null>(null);
  const [list, setList] = useState<{ business: { name: string; country: string } | null; campaigns: Campaign[] } | null>(null);
  const [adVideos, setAdVideos] = useState<HubVideo[]>([]);
  const [spaceVideos, setSpaceVideos] = useState<HubVideo[]>([]);
  const [uploads, setUploads] = useState<Array<{ key: number; upload: VideoUpload; snap: UploadSnapshot }>>([]);
  const [form, setForm] = useState({ businessName: '', country: viewer.profile?.country ?? null as string | null, headline: '', destinationUrl: 'https://', videoId: '', days: 7, target: null as string | null });
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<Campaign | null>(null);
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
    if (!premium) return;
    try {
      const [p, l] = await Promise.all([api<Plans>('/billing/plans'), api<typeof list>('/ads/campaigns'), loadVideos()]);
      setPlans(p); setList(l);
      if (l?.business) setForm((f) => ({ ...f, businessName: f.businessName || l.business!.name, country: f.country ?? l.business!.country }));
    } catch (e) { setError((e as Error).message); }
  }, [premium, loadVideos]);
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
      const r = await api<{ campaign: Campaign }>('/ads/campaigns', { body: { businessName: form.businessName, country: form.country, headline: form.headline, destinationUrl: form.destinationUrl, videoId: form.videoId, days: form.days, targetCountries: form.target ? [form.target] : [] } });
      setCreating(false); setPaying(r.campaign); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const act = async (c: Campaign, what: 'pause' | 'delete') => {
    setError(null);
    try { await api(`/ads/campaigns/${c.id}${what === 'pause' ? '/pause' : ''}`, { method: what === 'pause' ? 'POST' : 'DELETE', body: what === 'pause' ? {} : undefined }); await load(); } catch (e) { setError((e as Error).message); }
  };

  if (!premium) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <section className="flex flex-col items-center gap-4 rounded-[28px] bg-[#071312] px-6 py-10 text-center text-white">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-[#f5b95c] text-[#2a1a02]"><Icon.Megaphone size={32} /></span>
          <h1 className="font-display text-[30px] font-extrabold">Ad Studio is part of Premium</h1>
          <p className="max-w-md text-[15px] text-[#c9d6d4]">Upload short video ads, choose the countries, and run them before videos on Free Me by the day. You see how many people saw your ad and visited your site.</p>
          <Link href="/premium" className="flex h-11 items-center gap-2 rounded-2xl bg-gradient-to-r from-[#f5b95c] to-[#e39a2a] px-5 text-[14px] font-bold text-[#2a1a02]"><Icon.PremiumStar size={18} filled />Upgrade</Link>
        </section>
      </div>
    );
  }
  if (!plans || !list) return error ? <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  const rate = plans.ads.usdCentsPerDay;
  const readyAds = adVideos.filter(usableVideo);
  const running = list.campaigns.filter((c) => c.status === 'ACTIVE').length;
  const shown = list.campaigns.reduce((n, c) => n + c.impressions, 0);
  const visits = list.campaigns.reduce((n, c) => n + c.clicks, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="flex items-center gap-2 font-display text-[28px] font-extrabold"><Icon.Megaphone size={28} />Ad Studio</h1>
          <p className="mt-1 max-w-2xl text-[15px] text-muted">Upload a short video ad, then run it before videos. <b className="text-ink">{usd(rate, locale)} a day</b>, paid up front. Never more than {plans.ads.maxAdsPerVideo} ads on a video, and viewers can skip after 5 seconds.</p>
        </div>
        {viewer.channel && <button type="button" onClick={() => fileInput.current?.click()} className="flex h-11 items-center gap-2 rounded-2xl bg-surface px-4 text-[14px] font-bold hover:bg-surface-hover"><Icon.Upload size={20} />Upload ad video</button>}
        {viewer.channel && !creating && <button type="button" onClick={() => setCreating(true)} className="flex h-11 items-center gap-2 rounded-2xl bg-brand px-4 text-[14px] font-bold text-on-brand hover:bg-brand-strong"><Icon.Plus size={20} />New ad</button>}
        <input ref={fileInput} type="file" accept="video/*" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
      </div>
      {notice && <p role="status" className="mt-4 rounded-2xl bg-brand-soft px-4 py-3 text-[14px] font-semibold text-brand">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      {!viewer.channel ? (
        <section className="mt-6 rounded-3xl border border-line bg-elevated p-6">
          <h2 className="font-display text-[20px] font-bold">First, create your Space</h2>
          <p className="mt-2 text-[15px] text-muted">Ads are shown under your Space’s name and verified badge. <Link href="/channel/create" className="font-semibold text-brand underline">Create your Space</Link>, then come back to upload your first ad.</p>
        </section>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-3 gap-3">
            {([['Running now', running], ['Times shown', shown], ['Visits to your site', visits]] as const).map(([l, n]) => (
              <div key={l} className="rounded-2xl border border-line p-4"><dt className="text-[13px] text-muted">{l}</dt><dd className="font-display text-[24px] font-extrabold tabular-nums">{n.toLocaleString(locale)}</dd></div>
            ))}
          </dl>

          <section className="mt-8" aria-labelledby="ad-videos">
            <div className="flex items-baseline gap-2"><h2 id="ad-videos" className="font-display text-[20px] font-bold">Ad videos</h2><span className="text-[13px] text-muted">{MIN_SECONDS}–{MAX_SECONDS} seconds · only played as ads, never in feeds</span></div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {uploads.map(({ key, upload, snap }) => (
                <article key={key} className="rounded-2xl border border-line p-3">
                  <div className="grid aspect-video place-items-center rounded-xl bg-surface"><Icon.Upload size={28} className="text-muted" /></div>
                  <p className="mt-2 truncate text-[14px] font-semibold">{snap.title}</p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full bg-brand transition-[width]" style={{ width: `${snap.total ? Math.round((snap.sent / snap.total) * 100) : 0}%` }} /></div>
                  <p className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                    <span className="flex-1">{snap.state === 'error' ? <span className="text-danger">{snap.error}</span> : snap.state === 'finishing' ? 'Finishing…' : `Uploading ${snap.total ? Math.round((snap.sent / snap.total) * 100) : 0}%`}</span>
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
                <label className="block"><span className="text-[13px] font-semibold">Show it in</span><span className="mt-1 block"><CountrySelect value={form.target} onChange={(target) => setForm({ ...form, target })} emptyLabel="Every country" /></span></label>
                <label className="block"><span className="text-[13px] font-semibold">Days: {form.days}</span>
                  <input type="range" min={1} max={90} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} className="mt-3 w-full accent-[var(--brand)]" />
                </label>
                <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-4 py-3 sm:col-span-2">
                  <span className="text-[15px]">{form.days} {form.days === 1 ? 'day' : 'days'} × {usd(rate, locale)} = <b className="font-display text-[20px]">{usd(rate * form.days, locale)}</b></span>
                  <span className="ml-auto flex gap-2">
                    <button type="button" onClick={() => setCreating(false)} className="h-11 rounded-2xl px-4 text-[14px] font-semibold text-muted hover:bg-surface-hover">Cancel</button>
                    <button type="button" disabled={busy || !form.videoId || !form.country || form.headline.trim().length < 3 || form.businessName.trim().length < 2} onClick={() => void create()} className="h-11 rounded-2xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">Continue to payment</button>
                  </span>
                </div>
              </div>
            </section>
          )}

          {paying && (
            <section className="mt-6 rounded-3xl border-2 border-brand bg-elevated p-5 sm:p-6">
              <div className="flex items-start gap-3"><div className="flex-1"><h2 className="font-display text-[20px] font-bold">Pay for “{paying.headline}”</h2><p className="text-[14px] text-muted">{paying.days} {paying.days === 1 ? 'day' : 'days'}. It starts when our team approves it, usually within a day.</p></div><button type="button" onClick={() => setPaying(null)} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={20} /></button></div>
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
            </div>
          </section>
        </>
      )}
    </div>
  );
}
