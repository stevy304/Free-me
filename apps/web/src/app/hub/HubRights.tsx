'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import { useShell } from '@/components/shell/ShellContext';

type Policy = 'BLOCK' | 'MONETIZE' | 'TRACK';
interface Claim {
  id: string; policy: Policy; status: 'ACTIVE' | 'DISPUTED' | 'RELEASED'; matched: string; seconds: number; uploadStart: number; referenceStart: number;
  disputeReason: string | null; disputedAt: string | null; resolvedAt: string | null; createdAt: string;
  upload: { id: string; title: string; handle: string; name: string }; work: { id: string; title: string; handle: string; name: string };
}
interface Work { id: string; title: string; visibility: string; published: boolean; fingerprinted: boolean; protected: boolean; policy: Policy }
interface Rights { verified: boolean; works: Work[]; matchesOfMyWorks: Claim[]; claimsOnMyUploads: Claim[] }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const POLICY: Record<Policy, { label: string; effect: (owner: string) => string; tone: string }> = {
  BLOCK: { label: 'Block', effect: () => 'Not published', tone: 'bg-danger/10 text-danger' },
  MONETIZE: { label: 'Earn', effect: (o) => `Published · ads pay @${o}`, tone: 'bg-accent-soft text-on-accent-soft' },
  TRACK: { label: 'Track', effect: (o) => `Published · @${o} sees it`, tone: 'bg-surface text-muted' },
};
const STATUS: Record<Claim['status'], string> = { ACTIVE: 'Active', DISPUTED: 'Disputed', RELEASED: 'Released' };

/**
 * Creator Hub → Rights (Content ID): claims on my uploads (dispute), copies of my works found on other uploads
 * (release or keep), and my works' protection.
 */
export function HubRights() {
  const { locale } = useShell();
  const [r, setR] = useState<Rights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const load = useCallback(() => { api<Rights>('/rights').then(setR).catch((e) => setError((e as Error).message)); }, []);
  useEffect(load, [load]);

  const act = async (key: string, path: string, body: object = {}, method = 'POST') => {
    setBusy(key); setError(null);
    try { await api(path, { method, body }); load(); setDisputing(null); setReason(''); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!r) return error ? <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p> : <div className="grid place-items-center py-16"><Icon.Spinner className="animate-spin text-muted" /></div>;
  const section = 'rounded-2xl border border-line bg-elevated p-5';
  const empty = (text: string) => <p className="rounded-xl bg-surface px-4 py-6 text-center text-[14px] text-muted">{text}</p>;

  return (
    <div className="space-y-6 py-6">
      <div className="flex flex-wrap items-start gap-3 rounded-2xl bg-brand-soft px-5 py-4 text-[14px]">
        <Icon.Shield size={22} className="mt-0.5 shrink-0 text-brand" />
        <p className="min-w-0 flex-1">Every upload is fingerprinted, picture and sound. Your published videos are protected: if someone else uploads a copy, it is not published.
          {r.verified ? <> You are a <b>verified rights holder</b>: you can let copies of your works through and earn from their ads, or just track them.</> : <> Rights holders (labels, studios, TV channels) can ask Free Me to verify them to earn from copies instead.</>}</p>
      </div>
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      <section className={section} aria-labelledby="claims-mine">
        <h2 id="claims-mine" className="text-[17px] font-bold">Claims on your uploads</h2>
        <p className="mt-1 text-[13px] text-muted">When your video uses someone else&apos;s work. If it is yours, or you have permission, dispute it: the owner decides.</p>
        <div className="mt-4 space-y-3">
          {r.claimsOnMyUploads.length === 0 && empty('No claims on your uploads.')}
          {r.claimsOnMyUploads.map((c) => (
            <article key={c.id} className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[15px] font-semibold">{c.upload.title}</p>
                <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold ${c.status === 'RELEASED' ? 'bg-brand-soft text-brand' : POLICY[c.policy].tone}`}>{c.status === 'RELEASED' ? 'Released · published' : POLICY[c.policy].effect(c.work.handle)}</span>
              </div>
              <p className="mt-1 text-[14px] text-muted">Uses {c.seconds} s of the {c.matched} of <Link href={`/watch?v=${c.work.id}`} className="font-semibold text-ink hover:underline">“{c.work.title}”</Link> by <Link href={`/@${c.work.handle}`} className="text-brand hover:underline">@{c.work.handle}</Link> (your video at {clock(c.uploadStart)}, theirs at {clock(c.referenceStart)}) · <span suppressHydrationWarning>{timeAgo(c.createdAt, locale)}</span></p>
              {c.status === 'DISPUTED' && <p className="mt-2 text-[13px] text-muted">Disputed: “{c.disputeReason}”. Waiting for @{c.work.handle} to decide.</p>}
              {c.status === 'ACTIVE' && c.disputedAt && <p className="mt-2 text-[13px] text-muted">You disputed this claim; @{c.work.handle} kept it.</p>}
              {c.status === 'ACTIVE' && !c.disputedAt && (disputing === c.id ? (
                <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void act(c.id, `/rights/claims/${c.id}/dispute`, { reason }); }}>
                  <label htmlFor={`why-${c.id}`} className="text-[13px] font-semibold">Why is this claim wrong?</label>
                  <textarea id={`why-${c.id}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={1000} rows={3} placeholder="For example: I filmed this myself, or I have the owner's permission (say how)." className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-[14px] outline-none focus:border-brand" />
                  <div className="flex gap-2">
                    <button type="submit" disabled={reason.trim().length < 10 || busy === c.id} className="h-9 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Send dispute</button>
                    <button type="button" onClick={() => setDisputing(null)} className="h-9 rounded-xl px-4 text-[14px] font-semibold hover:bg-surface">Cancel</button>
                  </div>
                </form>
              ) : <button type="button" onClick={() => { setDisputing(c.id); setReason(''); }} className="mt-3 h-9 rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover">Dispute</button>)}
            </article>
          ))}
        </div>
      </section>

      <section className={section} aria-labelledby="claims-theirs">
        <h2 id="claims-theirs" className="text-[17px] font-bold">Copies of your works</h2>
        <p className="mt-1 text-[13px] text-muted">Other uploads that use your videos. Release a claim to let the upload be published.</p>
        <div className="mt-4 space-y-3">
          {r.matchesOfMyWorks.length === 0 && empty('No copies of your works found.')}
          {r.matchesOfMyWorks.map((c) => (
            <article key={c.id} className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[15px] font-semibold">“{c.upload.title}” <span className="font-normal text-muted">by @{c.upload.handle}</span></p>
                <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold ${c.status === 'DISPUTED' ? 'bg-accent-soft text-on-accent-soft' : c.status === 'RELEASED' ? 'bg-surface text-muted' : 'bg-brand-soft text-brand'}`}>{STATUS[c.status]}</span>
              </div>
              <p className="mt-1 text-[14px] text-muted">{c.seconds} s of the {c.matched} of your “{c.work.title}” (from {clock(c.referenceStart)}) · {POLICY[c.policy].label} · <span suppressHydrationWarning>{timeAgo(c.createdAt, locale)}</span></p>
              {c.status === 'DISPUTED' && <p className="mt-2 rounded-lg bg-surface px-3 py-2 text-[14px]"><b>@{c.upload.handle} disputes:</b> {c.disputeReason}</p>}
              {c.status !== 'RELEASED' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={busy === c.id} onClick={() => void act(c.id, `/rights/claims/${c.id}/release`)} className="h-9 rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover">Release</button>
                  {c.status === 'DISPUTED' && <button type="button" disabled={busy === c.id} onClick={() => void act(c.id, `/rights/claims/${c.id}/keep`)} className="h-9 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand">Keep the claim</button>}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className={section} aria-labelledby="works">
        <h2 id="works" className="text-[17px] font-bold">Your works</h2>
        <p className="mt-1 text-[13px] text-muted">Published videos are protected automatically. Turn on protection for a private video to register it as a reference work (for example a song or a film you own, without publishing it).</p>
        <div className="mt-4 divide-y divide-line">
          {r.works.length === 0 && empty('No videos yet.')}
          {r.works.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{w.title}</p>
                <p className="text-[12px] text-muted">{w.published ? 'Published' : 'Private'} · {w.fingerprinted ? 'Fingerprinted' : 'Fingerprint pending'}</p>
              </div>
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <span>Protected</span>
                <button type="button" role="switch" aria-checked={w.protected} aria-label={`Protect “${w.title}”`} disabled={busy === w.id} onClick={() => void act(w.id, `/rights/works/${w.id}`, { active: !w.protected }, 'PUT')}
                  className={`relative h-6 w-11 rounded-full transition-colors ${w.protected ? 'bg-brand' : 'bg-surface-hover'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] ${w.protected ? 'left-[22px]' : 'left-0.5'}`} /></button>
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <span className="sr-only">When someone copies “{w.title}”</span>
                <select value={w.policy} disabled={!r.verified || !w.protected || busy === w.id} onChange={(e) => void act(w.id, `/rights/works/${w.id}`, { policy: e.target.value }, 'PUT')}
                  title={r.verified ? 'What happens to copies' : 'Only verified rights holders can let copies through'} className="h-9 rounded-xl border border-line bg-surface px-2 text-[13px] font-semibold disabled:opacity-60">
                  <option value="BLOCK">Block copies</option><option value="MONETIZE">Earn from copies</option><option value="TRACK">Track copies</option>
                </select>
              </label>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
