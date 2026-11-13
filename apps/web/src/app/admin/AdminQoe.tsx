'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

type By = 'country' | 'codec' | 'device' | 'network';
interface Row { key: string; sessions: number; startupMedianMs: number | null; startupP90Ms: number | null; rebufferRatio: number; stalledShare: number; averageShortSide: number | null; errorRate: number; hoursWatched: number }
interface Qoe { hours: number; by: By | null; total: Row | null; groups: Row[] }

const BY: Array<[By, string]> = [['country', 'Country'], ['codec', 'Codec'], ['device', 'Device'], ['network', 'Connection']];
const s = (ms: number | null) => (ms === null ? '—' : `≤ ${(ms / 1000).toFixed(1)} s`);
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
/** Where a number stops being fine: what the alerts use (deploy/monitoring/alerts.yml). */
const bad = { rebuffer: 0.02, p90: 5000, error: 0.01 };

/** Playback quality as viewers experienced it (API media/qoe.ts), overall and split by one dimension. */
export function AdminQoe() {
  const [hours, setHours] = useState(24);
  const [by, setBy] = useState<By>('country');
  const [data, setData] = useState<Qoe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<Qoe>(`/admin/qoe?hours=${hours}&by=${by}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [hours, by]);
  useEffect(() => { void load(); }, [load]);
  const t = data?.total;
  return (
    <section className="mt-6" aria-labelledby="qoe-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="qoe-heading" className="text-2xl font-bold">Playback quality</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">What viewers experienced, counted from every playback: how fast video starts, how often it stops to load, the picture size shown and failures. No viewer or video is recorded.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Period" value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded-xl border border-line bg-bg px-3 py-2 text-sm">
            {[[1, 'Last hour'], [24, 'Last 24 hours'], [168, 'Last 7 days'], [720, 'Last 30 days']].map(([h, l]) => <option key={h} value={h}>{l}</option>)}
          </select>
          <select aria-label="Split by" value={by} onChange={(e) => setBy(e.target.value as By)} className="rounded-xl border border-line bg-bg px-3 py-2 text-sm">
            {BY.map(([k, l]) => <option key={k} value={k}>By {l.toLowerCase()}</option>)}
          </select>
        </div>
      </div>
      {error && <p role="alert" className="mt-4 text-danger">{error}</p>}
      {t && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            ['Playbacks', t.sessions.toLocaleString(), `${t.hoursWatched.toLocaleString()} h watched`, false],
            ['First frame, 90%', s(t.startupP90Ms), `median ${s(t.startupMedianMs)}`, (t.startupP90Ms ?? 0) > bad.p90],
            ['Rebuffering', pct(t.rebufferRatio), `${pct(t.stalledShare)} of playbacks stopped`, t.rebufferRatio > bad.rebuffer],
            ['Picture', t.averageShortSide ? `${t.averageShortSide}p` : '—', 'average shown', false],
            ['Failures', pct(t.errorRate), 'of playbacks', t.errorRate > bad.error],
          ].map(([label, value, note, warn]) => (
            <article key={label as string} className={`rounded-2xl border p-4 ${warn ? 'border-danger/50 bg-danger/5' : 'border-line bg-elevated'}`}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
              <p className="mt-1 text-2xl font-extrabold tabular-nums">{value}</p>
              <p className="text-xs text-muted">{note}</p>
            </article>
          ))}
        </div>
      )}
      {data && data.groups.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[720px] text-left text-sm tabular-nums">
            <thead className="bg-surface text-xs uppercase tracking-wide text-muted"><tr>
              <th className="px-3 py-2">{BY.find(([k]) => k === by)![1]}</th><th className="px-3 py-2 text-right">Playbacks</th><th className="px-3 py-2 text-right">First frame (median / 90%)</th>
              <th className="px-3 py-2 text-right">Rebuffering</th><th className="px-3 py-2 text-right">Stopped</th><th className="px-3 py-2 text-right">Picture</th><th className="px-3 py-2 text-right">Failures</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {data.groups.map((g) => (
                <tr key={g.key}>
                  <td className="px-3 py-2 font-semibold">{g.key === 'ZZ' ? 'Unknown' : g.key}</td>
                  <td className="px-3 py-2 text-right">{g.sessions.toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right ${(g.startupP90Ms ?? 0) > bad.p90 ? 'text-danger' : ''}`}>{s(g.startupMedianMs)} / {s(g.startupP90Ms)}</td>
                  <td className={`px-3 py-2 text-right ${g.rebufferRatio > bad.rebuffer ? 'text-danger' : ''}`}>{pct(g.rebufferRatio)}</td>
                  <td className="px-3 py-2 text-right">{pct(g.stalledShare)}</td>
                  <td className="px-3 py-2 text-right">{g.averageShortSide ? `${g.averageShortSide}p` : '—'}</td>
                  <td className={`px-3 py-2 text-right ${g.errorRate > bad.error ? 'text-danger' : ''}`}>{pct(g.errorRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && !data.total?.sessions && <p className="mt-4 text-sm text-muted">No playbacks counted in this period yet.</p>}
    </section>
  );
}
