'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

interface Health {
  storage: string; windowHours: number; sampleLimit: number;
  metrics: Array<{ kind: 'startup' | 'buffer' | 'recovery'; count: number; medianMs: number | null; p95Ms: number | null }>;
}
const LABELS = { startup: 'Time to first frame', buffer: 'Buffering interruptions', recovery: 'Connection recovery' };
const seconds = (ms: number | null) => ms === null ? '—' : `${(ms / 1000).toFixed(2)} s`;

export function AdminPlaybackHealth() {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { setData(await api<Health>('/admin/playback-health')); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="mt-6" aria-labelledby="playback-health-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="playback-health-heading" className="text-2xl font-bold">Playback Health</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">Measurements reported by viewers after frames appear and interruptions finish. Pauses and seeking are excluded from buffering.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void load()} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <p role="alert" className="mt-4 text-danger">{error}</p>}
      {data && (
        <>
          <p className="mt-4 text-xs text-muted">Latest {data.sampleLimit.toLocaleString()} samples within {data.windowHours} hours · stored on {data.storage}. Samples are diagnostics, not unique viewer counts.</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {data.metrics.map((m) => (
              <article key={m.kind} className="rounded-2xl border border-line bg-elevated p-5">
                <h3 className="font-bold">{LABELS[m.kind]}</h3>
                <p className="mt-3 text-3xl font-extrabold tabular-nums">{seconds(m.medianMs)}</p>
                <p className="mt-1 text-sm text-muted">Median · {m.count} samples</p>
                <p className="mt-4 text-sm">95th percentile <strong className="tabular-nums">{seconds(m.p95Ms)}</strong></p>
                {m.count === 0 && <p className="mt-3 text-sm text-muted">Waiting for measurements.</p>}
              </article>
            ))}
          </div>
          <p className="mt-4 max-w-3xl text-sm text-muted">Startup covers video frames on supported browsers. Recovery includes time spent offline until playback returns. Abandoned interruptions and failed starts have no completed duration sample. No viewer, video, or device identifiers are stored.</p>
        </>
      )}
    </section>
  );
}
