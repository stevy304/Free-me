'use client';

import Link from 'next/link';
import { useState } from 'react';
import { REPORT_DETAILS_MAX, REPORT_REASONS } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { Dialog, buttonClass, inputClass } from '@/components/Dialog';
import { api } from '@/lib/client-api';
import { duration } from '@/lib/format';

/** Report a video to the moderators. Copyright problems go to the copyright notice form instead. */
export function ReportDialog({ videoId, open, onClose, currentTime }: { videoId: string; open: boolean; onClose: () => void; currentTime: () => number }) {
  const [reason, setReason] = useState<string>('');
  const [details, setDetails] = useState('');
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | 'sent' | 'already'>(null);

  const reset = () => { setReason(''); setDetails(''); setAt(null); setError(null); setDone(null); };
  const close = () => { onClose(); setTimeout(reset, 200); };
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ alreadyReported: boolean }>(`/videos/${videoId}/reports`, { body: { reason, details: details.trim() || undefined, timestampSeconds: at ?? undefined } });
      setDone(r.alreadyReported ? 'already' : 'sent');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Dialog open={open} onClose={close} title="Thanks for reporting" footer={<button type="button" className={buttonClass.primary} onClick={close}>Done</button>}>
        <div className="flex gap-3 py-2 text-[15px] leading-relaxed">
          <Icon.CheckCircle size={28} filled className="shrink-0 text-brand" />
          <p>{done === 'already' ? 'You already reported this video. A moderator will look at it.' : 'A moderator will review the video against the Community Guidelines. You can follow what happens in '}{done === 'sent' && <Link href="/you/reports" className="font-medium text-brand" onClick={close}>Your reports</Link>}{done === 'sent' && '.'}</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} title="Report video"
      footer={<><button type="button" className={buttonClass.quiet} onClick={close}>Cancel</button><button type="button" className={buttonClass.primary} disabled={!reason || busy} onClick={send}>{busy && <Icon.Spinner size={16} className="animate-spin" />}Report</button></>}>
      <p className="mb-3 text-[14px] text-muted">What is wrong with this video? Reports are confidential: the creator is not told who sent them.</p>
      <fieldset className="-mx-2">
        <legend className="sr-only">Reason</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r.code} className={`flex cursor-pointer gap-3 rounded-lg px-2 py-2 hover:bg-surface ${reason === r.code ? 'bg-surface' : ''}`}>
            <input type="radio" name="reason" value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} className="mt-1 accent-[var(--brand)]" />
            <span><span className="block text-[15px] font-medium">{r.label}</span><span className="block text-[13px] text-muted">{r.hint}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="mt-3 rounded-xl border border-line p-3 text-[14px]">
        <p className="flex items-center gap-2 font-medium"><Icon.Copyright size={18} />Is it your work, used without permission?</p>
        <p className="mt-1 text-muted">Send a <Link href={`/legal/copyright/notice?v=${videoId}`} className="font-medium text-brand" onClick={close}>copyright notice</Link> instead: it is the legal route for removing copied content.</p>
      </div>
      {reason && (
        <div className="mt-4 space-y-3">
          <label className="block text-[13px] font-medium">Details (optional)
            <textarea value={details} maxLength={REPORT_DETAILS_MAX} onChange={(e) => setDetails(e.target.value)} rows={3} placeholder="What should the moderator look at?" className={`${inputClass} mt-1 resize-y`} />
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={at !== null} onChange={(e) => setAt(e.target.checked ? Math.floor(currentTime()) : null)} className="accent-[var(--brand)]" />
            The problem is at {duration(at ?? Math.floor(currentTime()))}
          </label>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}
