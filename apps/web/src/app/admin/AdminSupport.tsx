'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import type { Payment } from '@/lib/types';
import { usd } from '@/lib/money';
import { useShell } from '@/components/shell/ShellContext';

type Item = Payment & { providerReference: string; channel: { name: string; handle: string } | null };
export function AdminSupport() {
  const { locale } = useShell();
  const [rows, setRows] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => setRows((await api<{ payments: Item[] }>('/admin/billing/support')).payments);
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  return <section className="rounded-2xl border border-line bg-elevated p-5">
    <h2 className="font-display text-lg font-bold">Audience support · settlement review</h2>
    <p className="mt-2 text-sm text-muted">Clear funds only after checking the provider settlement, fees and any dispute. Zero platform commission applies during the pilot. This action moves existing pending earnings to available; it does not issue a payout or refund.</p>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    {!rows.length && <p className="mt-3 text-sm text-muted">No received support awaiting clearance.</p>}
    <ul className="mt-3 divide-y divide-line">{rows.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div><p className="font-semibold">{p.channel?.name ?? 'Creator'} · {usd(p.usdCents, locale)}</p><p className="break-all text-xs text-muted">{p.method} · {p.providerReference} · {p.payerReference ? `Payer reference: ${p.payerReference} · ` : ''}{p.id} · {p.paidAt ? new Date(p.paidAt).toLocaleDateString(locale) : ''}</p></div>
      <button disabled={busy} className="rounded-xl bg-brand px-3 py-2 font-semibold text-on-brand disabled:opacity-50" onClick={async () => {
        setBusy(true); setError(''); try { await api(`/admin/billing/support/${p.id}/clear`, { body: {} }); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Settlement checked · clear funds</button>
    </li>)}</ul>
  </section>;
}
