'use client';

import { useCallback, useEffect, useState } from 'react';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';

interface Request {
  id: string; status: string; businessName: string; registrationNumber: string; phone: string; website: string | null; createdAt: string;
  channel: { handle: string; name: string; email: string };
}

/**
 * Verified business requests waiting for review. Check the registration (RDB or tax number) and call the phone number
 * outside the app; approving lets the business pay for the badge, rejecting tells it why.
 */
export function AdminBusinesses() {
  const [rows, setRows] = useState<Request[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setRows((await api<{ requests: Request[] }>('/admin/billing/verifications')).requests); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  const decide = async (r: Request, approve: boolean) => {
    setError(null);
    try { await api(`/admin/billing/verifications/${r.id}`, { body: { approve, note: notes[r.id] ?? '' } }); await load(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <section>
      <h2 className="text-[18px] font-semibold">Businesses asking for the Verified badge ({rows?.length ?? 0})</h2>
      <p className="text-[13px] text-muted">Check the registration number and call the phone number before approving. The business pays only after you approve.</p>
      {error && <p role="alert" className="mt-2 rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <ul className="mt-2 space-y-2">
        {rows?.map((r) => (
          <li key={r.id} className="rounded-2xl border border-line p-4">
            <p className="font-semibold">{r.businessName} <span className="font-normal text-muted">· @{r.channel.handle} ({r.channel.name}) · {r.channel.email}</span></p>
            <p className="text-[14px] text-muted">Registration {r.registrationNumber} · {r.phone}{r.website ? <> · <a href={r.website} target="_blank" rel="noreferrer noopener" className="text-brand underline">{r.website}</a></> : null}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input aria-label="Note for the business" className={`${inputClass} max-w-sm`} placeholder="Note (required to reject)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
              <button type="button" onClick={() => void decide(r, true)} className="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand">Approve</button>
              <button type="button" onClick={() => void decide(r, false)} className="h-10 rounded-xl border border-line px-4 text-sm font-semibold text-danger">Reject</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
