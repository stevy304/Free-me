'use client';

import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { buttonClass } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { useShell } from '@/components/shell/ShellContext';
import { VideoRow } from '@/components/video/VideoCard';
import { api } from '@/lib/client-api';
import type { VideoCardData } from '@/lib/types';

interface Item { watchedAt: string; progressSeconds: number; completed: boolean; video: VideoCardData }

const dayLabel = (iso: string, locale: string) => {
  const d = new Date(iso); const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(locale, days < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(d);
};

/** Watch history grouped by day, with how far each video was watched; remove one or clear all. */
export function HistoryList() {
  const { locale } = useShell();
  const [items, setItems] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ items: Item[]; nextCursor: string | null }>('/me/history').then((r) => { setItems(r.items); setCursor(r.nextCursor); }).catch((e) => setError((e as Error).message)); }, []);
  const more = async () => { if (!cursor) return; setBusy(true); try { const r = await api<{ items: Item[]; nextCursor: string | null }>(`/me/history?cursor=${encodeURIComponent(cursor)}`); setItems((l) => [...(l ?? []), ...r.items]); setCursor(r.nextCursor); } finally { setBusy(false); } };
  const forget = async (id: string) => { await api(`/me/history/${id}`, { method: 'DELETE', body: {} }); setItems((l) => l!.filter((i) => i.video.id !== id)); };
  const clear = async () => { if (!window.confirm('Clear your whole Trail? This cannot be undone.')) return; await api('/me/history', { method: 'DELETE', body: {} }); setItems([]); setCursor(null); };

  if (error) return <EmptyState icon={<Icon.Offline size={36} strokeWidth={1.4} />} title="Your Trail could not be loaded">{error}</EmptyState>;
  if (!items) return <div className="grid place-items-center py-20"><Icon.Spinner className="animate-spin text-muted" /></div>;
  if (!items.length) return <EmptyState icon={<Icon.Trail size={36} strokeWidth={1.4} />} title="Your Trail is empty">Videos you watch while signed in appear here, so you can find them again and continue where you stopped.</EmptyState>;

  const groups: Array<[string, Item[]]> = [];
  for (const i of items) { const k = dayLabel(i.watchedAt, locale); const g = groups.at(-1); if (g && g[0] === k) g[1].push(i); else groups.push([k, [i]]); }
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-[30px] font-extrabold">Trail</h1><p className="text-[14px] text-muted">Everything you watched while signed in, and where you stopped.</p></div>
        <button type="button" onClick={clear} className={buttonClass.soft}><Icon.Trash size={18} />Clear your Trail</button>
      </div>
      {groups.map(([day, list]) => (
        <section key={day} className="mb-8">
          <h2 className="mb-3 text-[20px] font-bold" suppressHydrationWarning>{day}</h2>
          <div className="space-y-4">
            {list.map((i) => (
              <VideoRow key={i.video.id} v={i.video} locale={locale} large progress={i.completed ? 1 : i.video.durationSeconds ? i.progressSeconds / i.video.durationSeconds : 0}
                actions={<button type="button" onClick={() => forget(i.video.id)} aria-label={`Remove ${i.video.title} from your Trail`} className="grid h-10 w-10 place-items-center rounded-full hover:bg-surface"><Icon.Close size={20} /></button>} />
            ))}
          </div>
        </section>
      ))}
      {cursor && <button type="button" className={buttonClass.soft} onClick={more} disabled={busy}>{busy && <Icon.Spinner size={14} className="animate-spin" />}Show more</button>}
    </div>
  );
}
