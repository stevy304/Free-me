'use client';

import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';

interface SecretRow { name: string; label: string; purpose: string; hint: string; set: boolean; source: 'app' | 'environment' | null; updatedAt: string | null }

/**
 * Administration → Secrets: keys for outside services (the AI moderator's Anthropic key and others). Write-only:
 * the server stores them encrypted and never sends a value back. After Save the form closes at once and what was
 * typed is dropped from the page.
 */
export function AdminSecrets() {
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);

  useEffect(() => { api<{ secrets: SecretRow[] }>('/admin/secrets').then((r) => setRows(r.secrets)).catch((e) => setError((e as Error).message)); }, []);

  const close = () => { setValues({}); setOpen(false); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    if (!Object.keys(given).length) { close(); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ saved: string[]; secrets: SecretRow[] }>('/admin/secrets', { method: 'PUT', body: { values: given } });
      close();
      setRows(r.secrets);
      setSaved(r.saved);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async (row: SecretRow) => {
    if (!window.confirm(`Remove the saved ${row.label}?`)) return;
    setBusy(true); setError(null);
    try { const r = await api<{ saved: string[]; secrets: SecretRow[] }>('/admin/secrets', { method: 'PUT', body: { values: { [row.name]: '' } } }); setRows(r.secrets); setSaved(null); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!rows) return error ? <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  return (
    <div className="mt-5 max-w-3xl space-y-4">
      <p className="text-[14px] text-muted">Keys for outside services. They are stored encrypted and are never shown again, not even here: this page only says whether each one is set.</p>
      {saved && <p role="status" className="rounded-xl bg-brand-soft px-4 py-3 text-[14px] text-brand">Saved{saved.length ? ` (${saved.length})` : ''}. Stored encrypted; the values will never be shown again. They take effect within a minute.</p>}
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      <ul className="divide-y divide-line rounded-2xl border border-line">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-wrap items-start gap-3 p-4">
            <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${r.set ? 'bg-brand text-on-brand' : 'bg-surface text-muted'}`}>{r.set ? <Icon.Check size={14} /> : null}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">{r.label}</p>
              <p className="text-[13px] text-muted">{r.purpose}</p>
              <p className="mt-1 text-[13px]">{r.source === 'app' ? `Set here${r.updatedAt ? ` ${timeAgo(r.updatedAt)}` : ''}` : r.source === 'environment' ? 'Set in the server environment' : 'Not set'}</p>
            </div>
            {r.source === 'app' && <button type="button" disabled={busy} onClick={() => remove(r)} className="h-9 rounded-xl px-3 text-[13px] font-semibold text-danger hover:bg-danger/10">Remove</button>}
          </li>
        ))}
      </ul>

      {open ? (
        <form onSubmit={save} autoComplete="off" className="space-y-4 rounded-2xl border border-line p-4" aria-label="Add or replace keys">
          {rows.map((r) => (
            <label key={r.name} className="block">
              <span className="text-[14px] font-medium">{r.label}</span>
              <input type="password" name={`secret-${r.name}`} autoComplete="new-password" spellCheck={false} placeholder={r.set ? 'Leave empty to keep the current key' : r.hint}
                value={values[r.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [r.name]: e.target.value }))}
                className="mt-1 h-11 w-full rounded-xl border border-line bg-elevated px-3 font-mono text-[14px]" />
            </label>
          ))}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="h-10 rounded-xl bg-ink px-4 text-[14px] font-semibold text-bg disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" disabled={busy} onClick={close} className="h-10 rounded-xl px-4 text-[14px] font-semibold">Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => { setSaved(null); setError(null); setOpen(true); }} className="h-10 rounded-xl bg-ink px-4 text-[14px] font-semibold text-bg">Add or replace keys</button>
      )}
    </div>
  );
}
