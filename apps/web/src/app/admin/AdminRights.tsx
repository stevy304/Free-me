'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';

interface Holder { handle: string; name: string; rightsVerifiedAt: string }

/**
 * Administration → Rights (Content ID): verify rights holders (labels, studios, TV channels) after checking who they
 * are. Verified Spaces may let copies of their works through and earn from them, instead of blocking them.
 */
export function AdminRights() {
  const [data, setData] = useState<{ holders: Holder[]; claims: Record<string, number> } | null>(null);
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ holders: Holder[]; claims: Record<string, number> }>('/admin/rights').then(setData).catch((e) => setError((e as Error).message)); }, []);
  useEffect(load, [load]);
  const set = async (h: string, verified: boolean) => {
    setBusy(true); setError(null);
    try { await api(`/admin/rights/${encodeURIComponent(h.replace(/^@/, ''))}`, { body: { verified } }); setHandle(''); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!data) return error ? <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  return (
    <div className="mt-5 max-w-3xl space-y-4">
      <p className="text-[14px] text-muted">Every upload is fingerprinted (picture and sound) and checked against protected works. Verify a rights holder only after checking who they are and that they own what they will register: they can then earn from copies of their works.</p>
      <div className="grid grid-cols-3 gap-3">
        {(['ACTIVE', 'DISPUTED', 'RELEASED'] as const).map((k) => <div key={k} className="rounded-2xl bg-surface p-4"><p className="text-[12px] text-muted">{k === 'ACTIVE' ? 'Active claims' : k === 'DISPUTED' ? 'Disputed' : 'Released'}</p><p className="font-display text-[24px] font-bold tabular-nums">{data.claims[k] ?? 0}</p></div>)}
      </div>
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      <form onSubmit={(e) => { e.preventDefault(); if (handle.trim()) void set(handle.trim(), true); }} className="flex flex-wrap gap-2">
        <label htmlFor="rights-handle" className="sr-only">Space handle</label>
        <input id="rights-handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle of the rights holder's Space" className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[14px]" />
        <button type="submit" disabled={busy || !handle.trim()} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Verify as rights holder</button>
      </form>
      <ul className="divide-y divide-line rounded-2xl border border-line">
        {data.holders.length === 0 && <li className="p-4 text-[14px] text-muted">No verified rights holders yet.</li>}
        {data.holders.map((h) => (
          <li key={h.handle} className="flex items-center gap-3 p-4">
            <span className="min-w-0 flex-1"><b>{h.name}</b> <span className="text-muted">@{h.handle}</span></span>
            <button type="button" disabled={busy} onClick={() => void set(h.handle, false)} className="h-9 rounded-xl px-3 text-[13px] font-semibold text-danger hover:bg-danger/10">Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
