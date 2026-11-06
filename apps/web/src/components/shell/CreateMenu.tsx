'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useUploads } from '../hub/UploadsContext';

/** "Create": upload a video, post a Moment, upload a podcast, go live, or open Creator Hub. Shows upload progress while files are uploading. */
export function CreateMenu() {
  const { openDialog, items } = useUploads();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const active = items.filter((i) => ['starting', 'compressing', 'uploading', 'paused', 'finishing'].includes(i.snap.state));
  const sent = active.reduce((a, i) => a + i.snap.sent, 0); const total = active.reduce((a, i) => a + i.snap.total, 0);
  return (
    <div ref={box} className="relative flex items-center gap-2">
      {active.length > 0 && (
        <button type="button" onClick={() => openDialog(active[0].id)} className="hidden h-10 items-center gap-2 rounded-xl bg-brand-soft px-3 text-[13px] font-semibold text-brand sm:flex" aria-label="Show upload">
          <Icon.Spinner size={16} className="animate-spin" />{active.length === 1 ? 'Uploading' : `Uploading ${active.length}`} {total ? Math.floor((sent / total) * 100) : 0}%
        </button>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand hover:bg-brand-strong">
        <Icon.Plus size={20} /><span className="hidden sm:inline">Create</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-2xl border border-line bg-elevated py-2 shadow-[var(--shadow)]">
          <button role="menuitem" type="button" onClick={() => { setOpen(false); openDialog(null, 'video'); }} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Upload size={20} strokeWidth={1.6} />Upload video</button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); openDialog(null, 'moment'); }} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Moments size={20} />Post a Moment</button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); openDialog(null, 'podcast'); }} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Mic size={20} />Upload podcast</button>
          <Link role="menuitem" href="/go-live" onClick={() => setOpen(false)} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Live size={20} />Go live</Link>
          <Link role="menuitem" href="/studio/ads" onClick={() => setOpen(false)} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Megaphone size={20} />Create an ad</Link>
          <Link role="menuitem" href="/hub" onClick={() => setOpen(false)} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Icon.Hub size={20} />Creator Hub</Link>
        </div>
      )}
    </div>
  );
}
