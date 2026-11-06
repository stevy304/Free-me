'use client';

import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';

interface Check { id: string; required: boolean; ok: boolean; label: string; detail: string; fix: string }

/** Administration → Launch: is this server ready for the public? Each item checked live, with what to do. */
export function AdminLaunch() {
  const [r, setR] = useState<{ ready: boolean; checks: Check[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { setError(null); api<{ ready: boolean; checks: Check[] }>('/admin/system/launch').then(setR).catch((e) => setError((e as Error).message)); };
  useEffect(load, []);
  if (!r) return error ? <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  const done = r.checks.filter((c) => c.ok).length;
  return (
    <div className="mt-5 max-w-3xl space-y-4">
      <div className={`flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 ${r.ready ? 'bg-brand-soft text-brand' : 'bg-accent-soft text-on-accent-soft'}`}>
        <p className="flex-1 text-[15px] font-semibold">{r.ready ? 'Ready to open to the public.' : 'Not ready yet: finish the items marked “Needed”.'} <span className="font-normal">{done} of {r.checks.length} done.</span></p>
        <button type="button" onClick={load} className="h-9 rounded-xl bg-elevated px-3 text-[13px] font-semibold text-ink">Check again</button>
      </div>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {r.checks.map((c) => (
          <li key={c.id} className="flex gap-3 p-4">
            <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${c.ok ? 'bg-brand text-on-brand' : c.required ? 'bg-danger/15 text-danger' : 'bg-surface text-muted'}`}>{c.ok ? <Icon.Check size={14} /> : c.required ? '!' : '·'}</span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">{c.label}{!c.ok && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${c.required ? 'bg-danger/10 text-danger' : 'bg-surface text-muted'}`}>{c.required ? 'Needed' : 'Advised'}</span>}</p>
              <p className="break-all text-[13px] text-muted">{c.detail}</p>
              {!c.ok && <p className="mt-1 text-[13px]">{c.fix}</p>}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted">The full step-by-step guide is in LAUNCH.md and DEPLOYMENT.md in the code.</p>
    </div>
  );
}
