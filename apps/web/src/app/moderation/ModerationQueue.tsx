'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { REPORT_REASONS } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { Dialog, buttonClass, inputClass } from '@/components/Dialog';
import { useShell } from '@/components/shell/ShellContext';
import { api } from '@/lib/client-api';
import { duration, timeAgo } from '@/lib/format';

interface Item {
  id: string; reason: string; reasonLabel: string; details: string | null; timestampSeconds: number | null; status: string; createdAt: string; resolvedAt: string | null; resolution: string | null; reporterEmail: string | null; automatic?: boolean;
  notice: { claimantName: string; claimantEmail: string; claimantAddress: string; originalWork: string; signature: string } | null;
  counter: { name: string; address: string; statement: string; submittedAt: string } | null;
  video: { id: string; title: string; status: string; visibility: string; takenDownAt: string | null; takedownReason: string | null; thumbnailUrl: string | null; durationSeconds: number; heldForReviewAt?: string | null };
  channel: { handle: string; name: string; strikes: { copyright: number; guidelines: number } };
  openReportsOnVideo: number;
}
type State = 'open' | 'counter' | 'closed';

/** Review queue: oldest open reports first; decide to remove, dismiss or restore, with a note the creator reads. */
export function ModerationQueue() {
  const { locale } = useShell();
  const [state, setState] = useState<State>('open');
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ item: Item; action: 'remove' | 'dismiss' | 'restore' } | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setItems(null); setError(null);
    api<{ reports: Item[]; open: number }>(`/moderation/reports?state=${state}${reason ? `&reason=${reason}` : ''}`).then((r) => { setItems(r.reports); setOpen(r.open); }).catch((e) => setError((e as Error).message));
  }, [state, reason]);
  useEffect(() => { load(); }, [load]);

  const decide = async () => {
    if (!deciding) return;
    setBusy(true); setError(null);
    try { await api(`/moderation/reports/${deciding.item.id}/decision`, { body: { action: deciding.action, notes: notes.trim() || undefined } }); setDeciding(null); setNotes(''); load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const tabs: Array<[State, string]> = [['open', `Open (${open})`], ['counter', 'Counter-notices'], ['closed', 'Closed']];
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6">
      <h1 className="flex items-center gap-2 text-[28px] font-semibold"><Icon.Flag size={28} className="text-brand" />Moderation</h1>
      <p className="text-[14px] text-muted">Every decision is recorded in the audit log and emailed to the creator (and to the rights holder for copyright).</p>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <div role="tablist" className="flex gap-1">
          {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={state === k} onClick={() => setState(k)} className={`-mb-px border-b-2 px-4 py-2.5 text-[14px] font-medium ${state === k ? 'border-ink' : 'border-transparent text-muted hover:text-ink'}`}>{l}</button>)}
        </div>
        <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" className="mb-2 rounded-lg border border-line bg-bg px-3 py-1.5 text-[14px]">
          <option value="">All reasons</option><option value="COPYRIGHT">Copyright</option>{REPORT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </div>
      {error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      {!items ? <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" /> : items.length === 0
        ? <div className="mt-10 text-center text-[15px] text-muted"><Icon.CheckCircle size={40} filled className="mx-auto mb-3 text-brand" />Nothing to review here.</div>
        : <div className="mt-5 space-y-4">{items.map((r) => (
          <article key={r.id} className="rounded-2xl border border-line p-4 text-[14px]">
            <div className="flex flex-col gap-4 md:flex-row">
              <Link href={`/watch?v=${r.video.id}${r.timestampSeconds ? `&t=${r.timestampSeconds}` : ''}`} className="relative block aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-surface md:w-56">
                {r.video.thumbnailUrl && <img src={r.video.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[11px] text-white">{duration(r.video.durationSeconds)}</span>
              </Link>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${r.reason === 'COPYRIGHT' ? 'bg-brand-soft text-brand' : 'bg-danger/10 text-danger'}`}>{r.reasonLabel}</span>
                  <span className="text-muted" suppressHydrationWarning>{timeAgo(r.createdAt, locale)}</span>
                  {r.openReportsOnVideo > 1 && <span className="text-[12px] font-medium text-danger">{r.openReportsOnVideo} open reports on this video</span>}
                  {r.video.heldForReviewAt && !r.video.takenDownAt && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[12px] font-semibold text-danger">Hidden until you decide (many reports)</span>}
                  {r.video.takenDownAt && <span className="rounded-full bg-surface px-2.5 py-0.5 text-[12px] font-medium">Removed</span>}
                </div>
                <p className="mt-1.5 text-[16px] font-semibold">{r.video.title}</p>
                <p className="text-muted"><Link href={`/@${r.channel.handle}`} className="hover:underline">@{r.channel.handle}</Link> · strikes: {r.channel.strikes.copyright} copyright, {r.channel.strikes.guidelines} guidelines</p>
                {r.timestampSeconds != null && <p className="mt-1"><span className="text-muted">At</span> {duration(r.timestampSeconds)}</p>}
                {r.details && <p className="mt-1 whitespace-pre-line"><span className="text-muted">Details:</span> {r.details}</p>}
                {r.notice && (
                  <div className="mt-2 rounded-xl bg-surface p-3">
                    <p className="font-medium">Copyright notice</p>
                    <p><span className="text-muted">From:</span> {r.notice.claimantName} &lt;{r.notice.claimantEmail}&gt;, {r.notice.claimantAddress}</p>
                    <p><span className="text-muted">Work:</span> {r.notice.originalWork}</p>
                    <p><span className="text-muted">Signed:</span> {r.notice.signature} (good-faith and accuracy statements confirmed)</p>
                  </div>
                )}
                {r.counter && (
                  <div className="mt-2 rounded-xl border border-brand/40 bg-brand-soft/40 p-3">
                    <p className="font-medium">Counter-notice <span className="font-normal text-muted" suppressHydrationWarning>({timeAgo(r.counter.submittedAt, locale)})</span></p>
                    <p><span className="text-muted">From:</span> {r.counter.name}, {r.counter.address}</p>
                    <p className="whitespace-pre-line">{r.counter.statement}</p>
                    <p className="mt-1 text-[12px] text-muted">Restore 10 to 14 business days after the counter-notice unless the claimant shows that a court action was filed.</p>
                  </div>
                )}
                <p className="mt-1 text-[12px] text-muted">{r.automatic ? 'Raised by the automatic check' : `Reported by ${r.reporterEmail}`}</p>
                {r.video.status === 'FLAGGED' && !r.video.takenDownAt && <p className="mt-1 text-[12px] font-semibold text-accent">Held: not processed or public until you decide. Release lets it go live as its creator chose.</p>}
                {r.resolution && <p className="mt-2 rounded-lg bg-surface px-3 py-2"><span className="text-muted">Decision:</span> {r.resolution}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!r.video.takenDownAt && state !== 'closed' && <button type="button" className={`${buttonClass.primary} bg-danger hover:bg-danger`} onClick={() => setDeciding({ item: r, action: 'remove' })}><Icon.Trash size={16} />Remove video</button>}
                  {state === 'open' && <button type="button" className={buttonClass.soft} onClick={() => setDeciding({ item: r, action: 'dismiss' })}>{r.video.status === 'FLAGGED' && !r.video.takenDownAt ? 'Release' : 'Dismiss'}</button>}
                  {r.video.takenDownAt && <button type="button" className={buttonClass.soft} onClick={() => setDeciding({ item: r, action: 'restore' })}><Icon.Check size={16} />Restore video</button>}
                </div>
              </div>
            </div>
          </article>
        ))}</div>}
      <Dialog open={!!deciding} onClose={() => setDeciding(null)} title={deciding?.action === 'remove' ? 'Remove video' : deciding?.action === 'restore' ? 'Restore video' : deciding?.item.video.status === 'FLAGGED' ? 'Release held video' : 'Dismiss report'}
        footer={<><button type="button" className={buttonClass.quiet} onClick={() => setDeciding(null)}>Cancel</button><button type="button" className={buttonClass.primary} disabled={busy || (deciding?.action === 'remove' && !notes.trim())} onClick={decide}>{busy && <Icon.Spinner size={14} className="animate-spin" />}Confirm</button></>}>
        <p className="text-[14px] text-muted">{deciding?.action === 'remove' ? 'The video disappears everywhere, its media moves behind signed links, every open report on it is closed and the creator gets a strike.' : deciding?.action === 'restore' ? 'The video becomes watchable again and the strike is lifted.' : 'Nothing changes for the video.'}</p>
        <label className="mt-3 block text-[13px] font-medium">{deciding?.action === 'remove' ? 'Reason the creator will read (required)' : 'Note (optional)'}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} mt-1`} />
        </label>
      </Dialog>
    </div>
  );
}
