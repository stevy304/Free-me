'use client';

import Link from 'next/link';
import { useState } from 'react';
import { REPORT_DETAILS_MAX, signatureMatches } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { buttonClass, inputClass } from '@/components/Dialog';
import { api } from '@/lib/client-api';

interface Video { id: string; title: string; thumbnailUrl: string | null; channel: { name: string; handle: string } }

/** Reads a Free Me video address (or a bare id) and returns the video id. */
const videoIdFrom = (text: string) => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text)?.[1] ?? null;

/** Copyright notice form: the elements notice-and-takedown laws require, with the sworn statements and a typed signature. */
export function NoticeForm({ initialVideo, email }: { initialVideo: Video | null; email: string }) {
  const [video, setVideo] = useState<Video | null>(initialVideo);
  const [link, setLink] = useState('');
  const [finding, setFinding] = useState(false);
  const [f, setF] = useState({ claimantName: '', claimantEmail: email, claimantAddress: '', originalWork: '', details: '', at: '', goodFaith: false, accurate: false, signature: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  const find = async () => {
    const id = videoIdFrom(link);
    if (!id) { setError('Paste the address of the video on Free Me (it contains watch?v=…).'); return; }
    setFinding(true); setError(null);
    try { setVideo((await api<{ video: Video }>(`/videos/${id}`)).video); } catch (e) { setError((e as Error).message); } finally { setFinding(false); }
  };
  const seconds = (() => { const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(f.at.trim()); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined; })();
  const ready = video && f.claimantName.trim().length >= 3 && f.claimantEmail && f.claimantAddress.trim().length >= 8 && f.originalWork.trim().length >= 10 && f.details.trim().length >= 10 && f.goodFaith && f.accurate && signatureMatches(f.claimantName, f.signature);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ report: { id: string } }>('/copyright/notices', { body: { videoId: video!.id, claimantName: f.claimantName, claimantEmail: f.claimantEmail, claimantAddress: f.claimantAddress, originalWork: f.originalWork, details: f.details, timestampSeconds: seconds, goodFaith: f.goodFaith, accurate: f.accurate, signature: f.signature } });
      setSent(r.report.id); window.scrollTo({ top: 0 });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Icon.CheckCircle size={56} filled className="mx-auto text-brand" />
        <h1 className="mt-4 text-[24px] font-bold">Notice received</h1>
        <p className="mt-2 text-[15px] text-muted">Reference {sent}. We sent a confirmation to {f.claimantEmail}. A moderator will review it and email you the decision. You can also follow it in <Link href="/you/reports" className="text-brand">Your reports</Link>.</p>
      </div>
    );
  }

  const field = 'block text-[14px] font-medium';
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/legal/copyright" className="inline-flex items-center gap-1 text-[14px] text-muted hover:text-ink"><Icon.ArrowLeft size={16} />Copyright policy</Link>
      <h1 className="mt-3 flex items-center gap-2 text-[28px] font-bold"><Icon.Copyright size={28} className="text-brand" />Copyright notice</h1>
      <p className="mt-1 text-[15px] text-muted">Ask us to remove a video that uses your work without permission. Only the rights owner or their authorised agent may send this. The creator will see your name and the work you identify.</p>

      <section className="mt-6 space-y-3 rounded-2xl border border-line p-4">
        <h2 className="text-[16px] font-semibold">1. The video on Free Me</h2>
        {video ? (
          <div className="flex items-center gap-3">
            <div className="aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-surface">{video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" />}</div>
            <div className="min-w-0 flex-1"><p className="line-clamp-2 font-medium">{video.title}</p><p className="text-[13px] text-muted">@{video.channel.handle}</p></div>
            <button type="button" className={buttonClass.quiet} onClick={() => setVideo(null)}>Change</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste the video address" aria-label="Video address" className={inputClass} />
            <button type="button" className={buttonClass.soft} onClick={find} disabled={finding}>{finding && <Icon.Spinner size={14} className="animate-spin" />}Find</button>
          </div>
        )}
        <label className={field}>What in the video is your work?<textarea value={f.details} onChange={set('details')} rows={3} maxLength={REPORT_DETAILS_MAX} placeholder="e.g. The soundtrack from 0:00 to 3:10 is my song." className={`${inputClass} mt-1`} /></label>
        <label className={field}>Where it starts (optional, like 1:24)<input value={f.at} onChange={set('at')} placeholder="m:ss" className={`${inputClass} mt-1 w-32`} /></label>
      </section>

      <section className="mt-4 space-y-3 rounded-2xl border border-line p-4">
        <h2 className="text-[16px] font-semibold">2. Your original work</h2>
        <label className={field}>Title and where it is published<textarea value={f.originalWork} onChange={set('originalWork')} rows={2} placeholder="e.g. Song &quot;Inkingi&quot; (2025), released on my album; https://…" className={`${inputClass} mt-1`} /></label>
      </section>

      <section className="mt-4 space-y-3 rounded-2xl border border-line p-4">
        <h2 className="text-[16px] font-semibold">3. You</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>Full legal name<input value={f.claimantName} onChange={set('claimantName')} autoComplete="name" className={`${inputClass} mt-1`} /></label>
          <label className={field}>Email<input type="email" value={f.claimantEmail} onChange={set('claimantEmail')} autoComplete="email" className={`${inputClass} mt-1`} /></label>
        </div>
        <label className={field}>Postal address<input value={f.claimantAddress} onChange={set('claimantAddress')} autoComplete="street-address" className={`${inputClass} mt-1`} /></label>
      </section>

      <section className="mt-4 space-y-3 rounded-2xl border border-line p-4 text-[14px]">
        <h2 className="text-[16px] font-semibold">4. Statements and signature</h2>
        <label className="flex gap-3"><input type="checkbox" checked={f.goodFaith} onChange={set('goodFaith')} className="mt-1 accent-[var(--brand)]" /><span>I believe in good faith that the use described above is not authorised by the copyright owner, its agent or the law.</span></label>
        <label className="flex gap-3"><input type="checkbox" checked={f.accurate} onChange={set('accurate')} className="mt-1 accent-[var(--brand)]" /><span>The information in this notice is accurate and, under penalty of perjury, I am the owner of the rights, or authorised to act for the owner.</span></label>
        <label className={field}>Signature: type your full name<input value={f.signature} onChange={set('signature')} className={`${inputClass} mt-1`} />{f.signature && !signatureMatches(f.claimantName, f.signature) && <span className="mt-1 block text-[12px] font-normal text-danger">Type your name exactly as in section 3.</span>}</label>
      </section>

      {error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted">False notices can make you liable for damages.</p>
        <button type="button" className={buttonClass.primary} disabled={!ready || busy} onClick={send}>{busy && <Icon.Spinner size={14} className="animate-spin" />}Send notice</button>
      </div>
    </div>
  );
}
