'use client';

import { Loader2, Plus, SquarePlay, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useUploads } from '../studio/UploadsContext';

/** "Create": upload a video or open your videos. Shows upload progress while files are uploading. */
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
  const active = items.filter((i) => ['starting', 'uploading', 'paused', 'finishing'].includes(i.snap.state));
  const sent = active.reduce((a, i) => a + i.snap.sent, 0); const total = active.reduce((a, i) => a + i.snap.total, 0);
  return (
    <div ref={box} className="relative flex items-center gap-2">
      {active.length > 0 && (
        <button type="button" onClick={() => openDialog(active[0].id)} className="hidden h-9 items-center gap-2 rounded-full bg-brand-soft px-3 text-[13px] font-medium text-brand sm:flex" aria-label="Show upload">
          <Loader2 size={16} className="animate-spin" />{active.length === 1 ? 'Uploading' : `Uploading ${active.length}`} {total ? Math.floor((sent / total) * 100) : 0}%
        </button>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex h-9 items-center gap-1.5 rounded-full bg-surface pl-2.5 pr-3.5 text-[14px] font-medium hover:bg-surface-hover">
        <Plus size={22} strokeWidth={1.6} /><span className="hidden sm:inline">Create</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-line bg-elevated py-2 shadow-[var(--shadow)]">
          <button role="menuitem" type="button" onClick={() => { setOpen(false); openDialog(); }} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><Upload size={20} strokeWidth={1.6} />Upload video</button>
          <Link role="menuitem" href="/studio" onClick={() => setOpen(false)} className="flex w-full items-center gap-4 px-4 py-2.5 text-[14px] hover:bg-surface"><SquarePlay size={20} strokeWidth={1.6} />Your videos</Link>
        </div>
      )}
    </div>
  );
}
