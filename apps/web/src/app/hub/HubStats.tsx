'use client';

import { useEffect, useMemo, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { compactNumber } from '@/lib/format';
import { useShell } from '@/components/shell/ShellContext';

interface Day { day: string; views: number; watchSeconds: number; newFollowers?: number }
interface Overview {
  days: number; series: Day[];
  totals: { views: number; watchSeconds: number; newFollowers: number; followers: number; previous: { views: number; watchSeconds: number; newFollowers: number } };
  topVideos: Array<{ id: string; title: string; thumbnailUrl: string | null; durationSeconds: number; views: number; watchSeconds: number; averageViewSeconds: number }>;
}
interface VideoStats { video: { id: string; title: string; durationSeconds: number }; lifetime: { views: number; watchSeconds: number; averageViewSeconds: number }; retention: { viewers: number; points: Array<{ at: number; percent: number }> | null } }

const PERIODS = [7, 28, 90, 365] as const;
type Metric = 'views' | 'watchSeconds' | 'newFollowers';
const METRICS: Array<[Metric, string]> = [['views', 'Views'], ['watchSeconds', 'Watch time (hours)'], ['newFollowers', 'New followers']];
const hours = (s: number) => Math.round((s / 3600) * 10) / 10;
const dur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const dayLabel = (d: string, locale: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** A round axis maximum (1, 2, 5 × 10^n) above the data, so grid lines fall on readable numbers. */
const niceMax = (v: number) => { if (v <= 0) return 4; const p = 10 ** Math.floor(Math.log10(v)); return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p; };

/** The chart's real width, so 1 SVG unit = 1 CSS pixel and text stays 11px on phones and wide screens alike. */
function useWidth(fallback: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

/** Creator Hub → Stats: how the Space is doing over a period, and how far viewers get in each video. */
export function HubStats() {
  const { locale } = useShell();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(28);
  const [metric, setMetric] = useState<Metric>('views');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  useEffect(() => { setData(null); setError(null); api<Overview>(`/hub/stats?days=${days}`).then(setData).catch((e) => setError((e as Error).message)); }, [days]);

  if (error) return <p role="alert" className="py-10 text-center text-[14px] text-danger">{error}</p>;
  const t = data?.totals;
  const tiles: Array<[string, string, number, number]> = t ? [
    ['Views', compactNumber(t.views, locale), t.views, t.previous.views],
    ['Watch time', `${hours(t.watchSeconds).toLocaleString(locale)} h`, t.watchSeconds, t.previous.watchSeconds],
    ['New followers', `+${compactNumber(t.newFollowers, locale)}`, t.newFollowers, t.previous.newFollowers],
  ] : [];
  return (
    <div className="space-y-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-muted">{t ? `${compactNumber(t.followers, locale)} people tune in to your Space` : 'Loading…'}</p>
        <div role="radiogroup" aria-label="Period" className="flex rounded-xl bg-surface p-1">
          {PERIODS.map((p) => <button key={p} type="button" role="radio" aria-checked={days === p} onClick={() => setDays(p)} className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold ${days === p ? 'bg-elevated text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>{p === 365 ? '1 year' : `${p} days`}</button>)}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {t ? tiles.map(([label, value, now, before]) => (
          <div key={label} className="rounded-2xl border border-line bg-elevated p-4">
            <p className="text-[13px] font-medium text-muted">{label}</p>
            <p className="mt-1 font-display text-[28px] font-extrabold tabular-nums" suppressHydrationWarning>{value}</p>
            <p className="mt-0.5 text-[12px] text-muted">{change(now, before, days)}</p>
          </div>
        )) : [0, 1, 2].map((i) => <div key={i} className="h-[112px] animate-pulse rounded-2xl bg-surface" />)}
      </div>
      <section className="rounded-2xl border border-line bg-elevated p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[16px] font-bold">{METRICS.find(([k]) => k === metric)![1]} per day</h2>
          <div role="radiogroup" aria-label="What to show" className="flex flex-wrap gap-1">
            {METRICS.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={metric === k} onClick={() => setMetric(k)} className={`rounded-full px-3 py-1 text-[12px] font-semibold ${metric === k ? 'bg-ink text-bg' : 'bg-surface text-muted hover:text-ink'}`}>{l}</button>)}
          </div>
        </div>
        {data ? <DailyBars series={data.series} metric={metric} locale={locale} /> : <div className="mt-4 h-[220px] animate-pulse rounded-xl bg-surface" />}
        {data && (
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-muted hover:text-ink">Show as table</summary>
            <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-line">
              <table className="w-full text-left tabular-nums"><thead className="sticky top-0 bg-surface"><tr><th className="px-3 py-1.5 font-semibold">Day</th><th className="px-3 py-1.5 text-right font-semibold">Views</th><th className="px-3 py-1.5 text-right font-semibold">Watch time (h)</th><th className="px-3 py-1.5 text-right font-semibold">New followers</th></tr></thead>
                <tbody>{[...data.series].reverse().map((d) => <tr key={d.day} className="border-t border-line"><td className="px-3 py-1">{dayLabel(d.day, locale)}</td><td className="px-3 py-1 text-right">{d.views}</td><td className="px-3 py-1 text-right">{hours(d.watchSeconds)}</td><td className="px-3 py-1 text-right">{d.newFollowers ?? 0}</td></tr>)}</tbody></table>
            </div>
          </details>
        )}
      </section>
      <section className="rounded-2xl border border-line bg-elevated p-4 sm:p-5">
        <h2 className="text-[16px] font-bold">Top videos</h2>
        <p className="text-[13px] text-muted">Views counted in this period. Choose one to see how far viewers get.</p>
        {data && !data.topVideos.length && <p className="py-6 text-center text-[14px] text-muted">No views in this period yet.</p>}
        <ul className="mt-3 divide-y divide-line">
          {data?.topVideos.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setVideoId(videoId === v.id ? null : v.id)} aria-expanded={videoId === v.id} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-surface/60">
                <span className="block aspect-video w-[96px] shrink-0 overflow-hidden rounded-lg bg-surface">{v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" />}</span>
                <span className="min-w-0 flex-1"><span className="line-clamp-2 text-[14px] font-semibold">{v.title}</span><span className="text-[12px] text-muted">Average view {dur(v.averageViewSeconds)} of {dur(v.durationSeconds)}</span></span>
                <span className="text-right text-[13px] tabular-nums"><span className="block font-semibold" suppressHydrationWarning>{compactNumber(v.views, locale)} views</span><span className="text-muted">{hours(v.watchSeconds)} h</span></span>
                <Icon.ChevronDown size={18} className={`shrink-0 text-muted transition-transform ${videoId === v.id ? 'rotate-180' : ''}`} />
              </button>
              {videoId === v.id && <Retention videoId={v.id} days={days} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function change(now: number, before: number, days: number) {
  if (!before) return now ? `New activity vs the previous ${days} days` : `Same as the previous ${days} days`;
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? `Same as the previous ${days} days` : `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs the previous ${days} days`;
}

/** One series of daily bars: thin rounded bars on a recessive grid, a tooltip per day. */
function DailyBars({ series, metric, locale }: { series: Day[]; metric: Metric; locale: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const val = (d: Day) => (metric === 'watchSeconds' ? hours(d.watchSeconds) : metric === 'newFollowers' ? d.newFollowers ?? 0 : d.views);
  const max = niceMax(Math.max(...series.map(val)));
  const [box, W] = useWidth(720); const H = 220; const left = 36; const bottom = 22; const top = 8;
  const plotW = W - left - 4; const plotH = H - bottom - top;
  const step = plotW / series.length;
  const bw = Math.max(1, Math.min(18, step - 2)); // 2px gap between bars
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(series.length / 6);
  const h = hover !== null ? series[hover] : null;
  return (
    <div ref={box} className="relative mt-4">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" role="img" aria-label={`${metric === 'views' ? 'Views' : metric === 'watchSeconds' ? 'Watch time in hours' : 'New followers'} per day`} onMouseLeave={() => setHover(null)}>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={left} x2={W - 4} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeWidth={1} />
            <text x={left - 6} y={y(tk) + 4} textAnchor="end" className="fill-[var(--muted)] text-[11px] tabular-nums">{compactNumber(tk, locale)}</text>
          </g>
        ))}
        {series.map((d, i) => {
          const v = val(d); const x = left + i * step + (step - bw) / 2; const yy = y(v); const r = Math.min(4, bw / 2, (top + plotH - yy) / 2);
          return (
            <g key={d.day}>
              {v > 0 && <path d={`M${x},${top + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${top + plotH} Z`} fill="var(--chart-1)" opacity={hover === null || hover === i ? 1 : 0.45} />}
              <rect x={left + i * step} y={top} width={step} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
              {i % labelEvery === 0 && <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="fill-[var(--muted)] text-[11px]">{dayLabel(d.day, locale)}</text>}
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg border border-line bg-elevated px-3 py-2 text-[12px] shadow-[var(--shadow)]" style={{ left: `${((left + hover * step + step / 2) / W) * 100}%` }}>
          <p className="font-semibold">{dayLabel(h.day, locale)}</p>
          <p className="tabular-nums">{h.views} views · {hours(h.watchSeconds)} h{h.newFollowers !== undefined ? ` · +${h.newFollowers} followers` : ''}</p>
        </div>
      )}
    </div>
  );
}

/** How far signed-in viewers get: share still watching at each 5% of the video. */
function Retention({ videoId, days }: { videoId: string; days: number }) {
  const [s, setS] = useState<VideoStats | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { api<VideoStats>(`/hub/videos/${videoId}/stats?days=${days}`).then(setS).catch(() => undefined); }, [videoId, days]);
  const [box, W] = useWidth(640); const H = 180; const left = 40; const bottom = 22; const top = 8; const plotW = W - left - 8; const plotH = H - top - bottom;
  const pts = useMemo(() => s?.retention.points?.map((p) => ({ ...p, x: left + (p.at / 100) * plotW, y: top + plotH - (p.percent / 100) * plotH })) ?? [], [s, plotW, plotH]);
  if (!s) return <div className="mb-3 h-[180px] animate-pulse rounded-xl bg-surface" />;
  if (!s.retention.points) return <p className="mb-3 rounded-xl bg-surface px-4 py-3 text-[13px] text-muted">The viewing curve appears once 5 signed-in viewers have watched ({s.retention.viewers} so far).</p>;
  const h = hover !== null ? pts[hover] : null;
  return (
    <div className="mb-4 rounded-xl bg-surface/60 p-3">
      <p className="text-[13px] font-semibold">Still watching</p>
      <p className="text-[12px] text-muted">From {s.retention.viewers} signed-in viewers</p>
      <div ref={box} className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" role="img" aria-label="Share of viewers still watching through the video" onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(20, Math.round(((x - left) / plotW) * 20)))); }}>
          {[0, 50, 100].map((p) => <g key={p}><line x1={left} x2={W - 8} y1={top + plotH - (p / 100) * plotH} y2={top + plotH - (p / 100) * plotH} stroke="var(--line)" /><text x={left - 6} y={top + plotH - (p / 100) * plotH + 4} textAnchor="end" className="fill-[var(--muted)] text-[11px]">{p}%</text></g>)}
          {[0, 50, 100].map((p) => <text key={p} x={left + (p / 100) * plotW} y={H - 6} textAnchor={p === 0 ? 'start' : p === 100 ? 'end' : 'middle'} className="fill-[var(--muted)] text-[11px]">{dur((p / 100) * s.video.durationSeconds)}</text>)}
          <path d={`M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" />
          {h && <><line x1={h.x} x2={h.x} y1={top} y2={top + plotH} stroke="var(--muted)" strokeDasharray="3 3" /><circle cx={h.x} cy={h.y} r={5} fill="var(--chart-1)" stroke="var(--bg-elevated)" strokeWidth={2} /></>}
        </svg>
        {h && <div className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-[12px] shadow-[var(--shadow)]" style={{ left: `${(h.x / W) * 100}%` }}><span className="font-semibold tabular-nums">{h.percent}%</span> still watching at {dur((h.at / 100) * s.video.durationSeconds)}</div>}
      </div>
    </div>
  );
}
