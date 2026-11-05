'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import * as Icon from '@/components/icons';
import { useShell } from '@/components/shell/ShellContext';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import type { VideoCardData } from '@/lib/types';
import type { HomeFeed } from './types';

/**
 * "Your interests": the topics For you is built from, editable in place. Explains, in plain words, that nothing else
 * (no watch-behaviour tracking) decides what appears.
 */
export function InterestsPanel({ interests, fromCreators }: { interests: HomeFeed['interests']; fromCreators: VideoCardData[] }) {
  const { viewer, locale } = useShell();
  const router = useRouter();
  const [picked, setPicked] = useState(new Set(interests.filter((i) => i.picked).map((i) => i.slug)));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = editing ? interests : interests.filter((i) => picked.has(i.slug)).concat(picked.size ? [] : interests.slice(0, 8));

  const toggle = (slug: string) => {
    if (!editing) return;
    const next = new Set(picked);
    if (next.has(slug)) next.delete(slug); else if (next.size < 12) next.add(slug);
    setPicked(next);
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { await api('/me/interests', { method: 'PUT', body: { categories: [...picked] } }); setEditing(false); router.refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <aside className="flex flex-col rounded-[20px] border border-line bg-elevated p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold">Your interests</h2>
          <p className="mt-1 text-[13px] leading-5 text-muted">For you is built from these and the creators you tune in to. Nothing else.</p>
        </div>
        {viewer && !editing && <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-brand hover:bg-brand-soft">Edit</button>}
      </div>
      <div className="mt-3.5 flex flex-wrap gap-2">
        {shown.map((i) => {
          const on = picked.has(i.slug);
          const cls = `rounded-[10px] px-3 py-1.5 text-[13px] font-medium ${on ? 'bg-brand-soft font-semibold text-brand' : 'bg-surface hover:bg-surface-hover'}`;
          return editing
            ? <button key={i.slug} type="button" aria-pressed={on} onClick={() => toggle(i.slug)} className={cls}>{on && <Icon.Check size={13} strokeWidth={3} className="-ml-0.5 mr-1 inline" />}{i.name}</button>
            : <Link key={i.slug} href={`/explore?topic=${i.slug}`} className={cls}>{i.name}</Link>;
        })}
        {!viewer && <Link href="/login?returnTo=/" className="rounded-[10px] bg-surface px-3 py-1.5 text-[13px] font-semibold text-brand hover:bg-surface-hover">+ Pick yours</Link>}
      </div>
      {editing && (
        <div className="mt-3 flex items-center gap-2">
          <span className="mr-auto text-[12px] text-muted">{picked.size}/12 picked</span>
          <button type="button" onClick={() => { setEditing(false); setPicked(new Set(interests.filter((i) => i.picked).map((i) => i.slug))); }} className="h-9 rounded-xl px-3 text-[13px] font-semibold hover:bg-surface">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="flex h-9 items-center gap-2 rounded-xl bg-brand px-4 text-[13px] font-semibold text-on-brand hover:bg-brand-strong disabled:opacity-60">{busy && <Icon.Spinner size={14} className="animate-spin" />}Save</button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      {viewer && fromCreators.length > 0 && !editing && (
        <>
          <h2 className="mt-6 text-[17px] font-bold">New from your creators</h2>
          <div className="mt-3 grid gap-3">
            {fromCreators.slice(0, 3).map((v) => (
              <Link key={v.id} href={`/watch?v=${v.id}`} className="group flex items-center gap-3">
                <div className="aspect-[16/10] w-[88px] shrink-0 overflow-hidden rounded-xl bg-surface">{v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" />}</div>
                <div className="min-w-0"><p className="line-clamp-2 text-[14px] font-semibold leading-tight group-hover:underline">{v.title}</p><p className="text-[12px] text-muted" suppressHydrationWarning>{v.channel.name} · {timeAgo(v.publishedAt, locale)}</p></div>
              </Link>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
