'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '../Avatar';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import { useShell } from './ShellContext';
import { useRealtime, useReconnect } from '@/lib/realtime';

interface Item {
  id: string; type: 'NEW_VIDEO' | 'COMMENT' | 'REPLY' | 'SPARK' | 'LIVE'; count: number; read: boolean; at: string; text: string; href: string;
  actor: { name: string; handle: string | null; avatarUrl: string | null };
  video: { id: string; title: string; thumbnailUrl: string | null } | null;
}

/** The bell: unread count (updated the moment something happens, and when the tab comes back), and a panel of what happened. */
export function NotificationBell() {
  const { locale } = useShell();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => { api<{ unread: number }>('/me/notifications/unread').then((r) => setUnread(r.unread)).catch(() => undefined); }, []);
  // Instantly when something happens (the socket), and every few minutes in case the connection dropped.
  useRealtime('notifications', () => { refresh(); if (open) api<{ notifications: Item[]; unread: number }>('/me/notifications').then((r) => { setItems(r.notifications); setUnread(r.unread); }).catch(() => undefined); });
  useReconnect(refresh);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 300_000);
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    api<{ notifications: Item[]; unread: number }>('/me/notifications').then((r) => { setItems(r.notifications); setUnread(r.unread); }).catch(() => setItems([]));
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const markRead = async (ids?: string[]) => {
    const r = await api<{ unread: number }>('/me/notifications/read', { body: ids ? { ids } : {} }).catch(() => null);
    if (r) setUnread(r.unread);
    setItems((list) => list?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)) ?? list);
  };
  const go = (n: Item) => { setOpen(false); if (!n.read) void markRead([n.id]); router.push(n.href); };

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'} aria-expanded={open}
        className="relative grid h-10 w-10 place-items-center rounded-xl bg-surface text-ink hover:bg-surface-hover">
        <Icon.Bell size={20} />
        {unread > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-[#f2a93b] px-1 text-[11px] font-bold text-[#2a1a00] ring-2 ring-bg">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="fixed inset-x-2 top-[68px] z-50 overflow-hidden rounded-2xl border border-line bg-elevated shadow-[var(--shadow)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-[400px]">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-[15px] font-bold">Notifications</p>
            {unread > 0 && <button type="button" onClick={() => markRead()} className="text-[13px] font-semibold text-brand hover:underline">Mark all as read</button>}
          </div>
          <div className="max-h-[min(70vh,520px)] overflow-y-auto">
            {items === null ? <p className="flex items-center justify-center gap-2 py-10 text-[14px] text-muted"><Icon.Spinner size={16} className="animate-spin" />Loading</p>
              : items.length === 0 ? <div className="px-6 py-10 text-center"><Icon.Bell size={28} className="mx-auto text-muted" /><p className="mt-2 text-[14px] font-semibold">Nothing new yet</p><p className="mt-1 text-[13px] text-muted">Tune in to Spaces to hear about their new videos.</p></div>
              : items.map((n) => (
                <button key={n.id} type="button" onClick={() => go(n)} className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface ${n.read ? '' : 'bg-brand-soft/40'}`}>
                  <Avatar name={n.actor.name} src={n.actor.avatarUrl} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-3 text-[13.5px] leading-snug">{n.text}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted" suppressHydrationWarning>
                      {n.type === 'SPARK' ? <Icon.Spark size={13} /> : n.type === 'NEW_VIDEO' ? <Icon.Play size={13} /> : <Icon.Comment size={13} />}{timeAgo(n.at, locale)}
                    </span>
                  </span>
                  {n.video?.thumbnailUrl && <img src={n.video.thumbnailUrl} alt="" className="aspect-video w-[86px] shrink-0 rounded-lg object-cover" />}
                  {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
                </button>
              ))}
          </div>
          <Link href="/settings" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-[12px] text-muted hover:text-ink">Settings</Link>
        </div>
      )}
    </div>
  );
}
