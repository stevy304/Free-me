'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { inputClass } from '@/components/Pickers';

interface Account { id: string; version: number; accountIdentifier: string; accountHolderName: string; channel: { name: string; handle: string } }
interface TestBody { phone: string; accountHolderName: string; amountRwf: number; requestId: string; scenario: 'success' | 'failure' | 'pending' }
interface Transfer { id: number; reference: string; status: string }

export function AdminPayouts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [test, setTest] = useState({ phone: '', accountHolderName: '', amountRwf: 1000, scenario: 'success' as TestBody['scenario'] });
  const [sent, setSent] = useState<{ body: TestBody; transfer: Transfer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [queue, config] = await Promise.all([api<{ accounts: Account[] }>('/admin/billing/payout-accounts'), api<{ enabled: boolean }>('/admin/billing/payout-sandbox')]);
      setAccounts(queue.accounts); setEnabled(config.enabled);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="space-y-5 rounded-2xl border border-line p-5">
      <div>
        <h2 className="text-lg font-bold">Payout account review</h2>
        <p className="mt-1 text-sm text-muted">Confirm wallet ownership and the account name before approving. Record the check reference, or explain which details the creator needs to update.</p>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {accounts.length ? accounts.map((a) => <article key={a.id} className="space-y-3 rounded-xl bg-surface p-4">
        <p className="text-sm"><strong>{a.channel.name}</strong> @{a.channel.handle} · {a.accountHolderName} · {a.accountIdentifier}</p>
        <label className="block text-sm font-semibold">Review note shared with creator<input className={`mt-1 ${inputClass}`} maxLength={500} value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} /></label>
        <div className="flex flex-wrap gap-2">
          {[true, false].map((approve) => <button key={String(approve)} type="button" disabled={busy || (notes[a.id]?.trim().length ?? 0) < 3} onClick={() => void run(async () => {
            await api(`/admin/billing/payout-accounts/${a.id}`, { body: { version: a.version, approve, note: notes[a.id] } }); await load();
          })} className="rounded-xl border border-line bg-elevated px-4 py-2 text-sm font-semibold disabled:opacity-50">{approve ? 'Approve account' : 'Return details'}</button>)}
        </div>
      </article>) : <p className="text-sm text-muted">No payout accounts awaiting review.</p>}
      <details className="border-t border-line pt-4">
        <summary className="cursor-pointer font-bold">Flutterwave transfer sandbox</summary>
        <p className="mt-2 text-sm text-muted">Uses Flutterwave test credentials and simulated transfers. Creator balances and real withdrawal statuses are unchanged. Keep the reference if a request times out, and check the provider dashboard before retrying.</p>
        {!enabled ? <p className="mt-3 text-sm text-muted">Sandbox access is awaiting operator configuration.</p> : <>
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const body: TestBody = { ...test, requestId: crypto.randomUUID() };
              // Retain the reference inputs even if the provider response is lost.
              setSent({ body, transfer: { id: 0, reference: `FMTEST_${body.requestId}${body.scenario === 'success' ? '_PMCKDU_1' : body.scenario === 'failure' ? '_PMCK_ST_FDU_1' : ''}`, status: 'Requesting' } });
              const transfer = await api<Transfer>('/admin/billing/payout-sandbox', { body });
              setSent({ body, transfer });
            });
          }}>
            <label className="text-sm">Test MTN wallet<input required className={inputClass} value={test.phone} onChange={(e) => setTest({ ...test, phone: e.target.value })} /></label>
            <label className="text-sm">Test account name<input required minLength={2} maxLength={100} className={inputClass} value={test.accountHolderName} onChange={(e) => setTest({ ...test, accountHolderName: e.target.value })} /></label>
            <label className="text-sm">Amount in RWF<input required type="number" min={100} max={100000} className={inputClass} value={test.amountRwf} onChange={(e) => setTest({ ...test, amountRwf: Number(e.target.value) })} /></label>
            <label className="text-sm">Simulated result<select className={inputClass} value={test.scenario} onChange={(e) => setTest({ ...test, scenario: e.target.value as TestBody['scenario'] })}><option value="success">Success</option><option value="failure">Failure</option><option value="pending">Pending</option></select></label>
            <button disabled={busy || !!sent} className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-on-brand disabled:opacity-50">Start sandbox transfer</button>
          </form>
          {sent && <div className="mt-4 break-all rounded-xl bg-surface p-4 text-sm">
            <p><strong>TEST · {sent.transfer.status}</strong></p><p className="mt-1">{sent.transfer.reference}</p>
            <p className="mt-2 text-muted">Simulated success or failure can take about a minute.</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busy || !sent.transfer.id} className="rounded-xl border border-line px-3 py-2 disabled:opacity-50" onClick={() => void run(async () => {
                const transfer = await api<Transfer>(`/admin/billing/payout-sandbox/${sent.transfer.id}/check`, { body: sent.body });
                setSent({ ...sent, transfer });
              })}>Check provider status</button>
              <button type="button" disabled={busy} className="rounded-xl px-3 py-2" onClick={() => setSent(null)}>New test</button>
            </div>
          </div>}
        </>}
      </details>
    </section>
  );
}
