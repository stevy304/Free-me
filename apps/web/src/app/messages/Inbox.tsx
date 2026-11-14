'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';

interface Person { id: string; name: string; handle: string | null; avatarUrl: string | null }
interface Row { id: string; other: Person; last: { body: string; at: string; mine: boolean } | null; unread: boolean }
interface Msg { id: string; body: string; mine: boolean; at: string }
interface Thread { id: string; other: Person; blocked: { byMe: boolean; byThem: boolean }; messages: Msg[]; nextCursor: string | null }

/**
 * Messages: conversations on the left, the open one on the right (on phones, one at a time). New messages arrive at
 * once (realtime); a message the safety check refuses is not sent and the reason is shown.
 */
export function Inbox({ initialId, to }: { initialId: string | null; to: string | null }) {
  const { locale } = useShell();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [active, setActive] = useState<string | null>(initialId);
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const loadList = useCallback(() => { api<{ conversations: Row[] }>('/messages').then((r) => setRows(r.conversations)).catch((e) => setError((e as Error).message)); }, []);
  const loadThread = useCallback(async (id: string) => {
    try {
      const t = await api<Thread>(`/messages/${id}`);
      setThread(t);
      await api(`/messages/${id}/read`, { method: 'POST', body: {} }).catch(() => undefined);
      setRows((list) => list?.map((r) => (r.id === id ? { ...r, unread: false } : r)) ?? list);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(loadList, [loadList]);
  // /messages?to=<handle> (the Message button on a Moment or a Space): open or start that conversation.
  useEffect(() => {
    if (!to) return;
    api<{ id: string }>(`/messages/with/${encodeURIComponent(to)}`, { method: 'POST', body: {} })
      .then((r) => { setActive(r.id); router.replace(`/messages?c=${r.id}`); })
      .catch((e) => setError((e as Error).message));
  }, [to, router]);
  useEffect(() => { setThread(null); setError(null); setMenu(false); if (active) void loadThread(active); }, [active, loadThread]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread?.messages.length]);
  // A message arrived (or was read elsewhere): refresh what is shown.
  useRealtime<{ conversationId: string }>('messages', (d) => { loadList(); if (d.conversationId === active) void loadThread(active); });

  const open = (id: string) => { setActive(id); router.replace(`/messages?c=${id}`); };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!active || !draft.trim() || sending) return;
    setSending(true); setError(null);
    try {
      const r = await api<{ message: Msg }>(`/messages/${active}`, { body: { body: draft } });
      setThread((t) => t && { ...t, messages: [r.message, ...t.messages] });
      setDraft('');
      loadList();
    } catch (err) { setError((err as Error).message); } finally { setSending(false); }
  };
  const setBlock = async (block: boolean) => {
    if (!active) return;
    setMenu(false);
    try { await api(`/messages/${active}/block`, { method: block ? 'POST' : 'DELETE', body: {} }); await loadThread(active); } catch (err) { setError((err as Error).message); }
  };

  const activeRow = rows?.find((r) => r.id === active);
  const other = thread?.other ?? activeRow?.other ?? null;
  const shown = [...(thread?.messages ?? [])].reverse();

  return (
    <div className="mx-auto flex h-[calc(100dvh-4.5rem)] max-w-[1200px] gap-5 px-0 py-0 sm:h-[calc(100dvh-5.5rem)] sm:px-6 sm:py-4">
      {/* Conversations */}
      <aside className={`min-h-0 w-full flex-col rounded-none border-line bg-elevated sm:rounded-2xl sm:border lg:flex lg:w-[340px] lg:shrink-0 ${active ? 'hidden' : 'flex'}`}>
        <div className="px-5 pb-2 pt-5">
          <h1 className="flex items-center gap-2 text-[22px] font-extrabold uppercase tracking-wide text-brand">Messages<span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-on-brand"><Icon.Message size={15} /></span></h1>
          <div className="imigongo mt-3" aria-hidden />
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!rows && <div className="grid place-items-center py-10"><Icon.Spinner className="animate-spin text-muted" /></div>}
          {rows && rows.length === 0 && <p className="px-4 py-10 text-center text-[14px] text-muted">No messages yet. Open a Moment or a Space and press <b>Message</b> to start a conversation.</p>}
          {rows?.map((r) => (
            <button key={r.id} type="button" onClick={() => open(r.id)} className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left ${r.id === active ? 'bg-brand-soft' : 'hover:bg-surface'}`}>
              <Avatar name={r.other.name} src={r.other.avatarUrl} size={46} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={`truncate text-[15px] ${r.unread ? 'font-extrabold' : 'font-semibold'}`}>{r.other.name}</span>
                  {r.last && <span className="shrink-0 text-[12px] text-muted" suppressHydrationWarning>{timeAgo(r.last.at, locale)}</span>}
                </span>
                <span className={`flex items-center gap-2 truncate text-[13px] ${r.unread ? 'font-semibold text-ink' : 'text-muted'}`}>
                  <span className="truncate">{r.last ? `${r.last.mine ? 'You: ' : ''}${r.last.body}` : ''}</span>
                  {r.unread && <span className="ml-auto h-2.5 w-2.5 shrink-0 rounded-full bg-[#e8505b]" aria-label="Unread" />}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* The open conversation */}
      <section className={`min-h-0 flex-1 flex-col rounded-none border-line bg-elevated sm:rounded-2xl sm:border lg:flex ${active ? 'flex' : 'hidden'}`} aria-label={other ? `Conversation with ${other.name}` : 'Conversation'}>
        {!active ? (
          <div className="grid flex-1 place-items-center p-8 text-center text-muted">
            <div><span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand-soft text-brand"><Icon.Message size={30} /></span><p className="mt-4 text-[15px]">Choose a conversation.</p></div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-line px-4 py-3">
              <button type="button" onClick={() => { setActive(null); router.replace('/messages'); }} aria-label="Back to messages" className="grid h-9 w-9 place-items-center rounded-full hover:bg-surface lg:hidden"><Icon.ChevronLeft size={20} /></button>
              {other && (
                other.handle
                  ? <Link href={`/@${other.handle}`} className="flex min-w-0 items-center gap-3"><Avatar name={other.name} src={other.avatarUrl} size={40} /><span className="min-w-0"><span className="block truncate font-display text-[16px] font-bold">{other.name}</span><span className="block text-[12px] text-muted">@{other.handle}</span></span></Link>
                  : <span className="flex min-w-0 items-center gap-3"><Avatar name={other.name} src={other.avatarUrl} size={40} /><span className="truncate font-display text-[16px] font-bold">{other.name}</span></span>
              )}
              <div className="relative ml-auto">
                <button type="button" onClick={() => setMenu((m) => !m)} aria-label="More" aria-haspopup="menu" aria-expanded={menu} className="grid h-9 w-9 place-items-center rounded-full hover:bg-surface"><Icon.More size={18} /></button>
                {menu && thread && (
                  <div role="menu" className="absolute right-0 top-full z-20 mt-2 w-[200px] rounded-2xl border border-line bg-elevated p-1.5 shadow-[var(--shadow)]">
                    <button type="button" role="menuitem" onClick={() => void setBlock(!thread.blocked.byMe)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[14px] font-semibold text-danger hover:bg-surface"><Icon.Warning size={17} />{thread.blocked.byMe ? 'Unblock' : 'Block'}</button>
                  </div>
                )}
              </div>
            </header>
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {!thread && <div className="grid place-items-center py-10"><Icon.Spinner className="animate-spin text-muted" /></div>}
              {thread && shown.length === 0 && <p className="py-10 text-center text-[14px] text-muted">Say hello to {thread.other.name}. Messages are checked against the Community Guidelines before they are delivered.</p>}
              <div className="flex flex-col gap-1.5">
                {shown.map((m, i) => {
                  const prev = shown[i - 1];
                  const gap = !prev || prev.mine !== m.mine;
                  return (
                    <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'} ${gap ? 'mt-2' : ''}`}>
                      <p title={new Date(m.at).toLocaleString(locale)} className={`max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px] leading-snug ${m.mine ? 'rounded-br-md bg-brand text-on-brand' : 'rounded-bl-md bg-surface text-ink'}`}>{m.body}</p>
                    </div>
                  );
                })}
              </div>
              <div ref={end} />
            </div>
            {error && <p role="alert" className="mx-4 mb-2 rounded-xl bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p>}
            {thread?.blocked.byMe || thread?.blocked.byThem ? (
              <p className="border-t border-line px-4 py-4 text-center text-[14px] text-muted">{thread.blocked.byMe ? 'You blocked this account. Unblock it to send messages.' : 'You cannot send messages to this account.'}</p>
            ) : (
              <form onSubmit={send} className="flex items-end gap-2 border-t border-line p-3">
                <label htmlFor="dm-draft" className="sr-only">Message</label>
                <textarea id="dm-draft" rows={1} value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)} placeholder="Write a message…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
                  className="max-h-40 min-h-[46px] flex-1 resize-none rounded-xl border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-brand" />
                <button type="submit" disabled={!draft.trim() || sending} aria-label="Send" className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-xl bg-brand text-on-brand disabled:opacity-50">
                  {sending ? <Icon.Spinner size={18} className="animate-spin" /> : <Icon.Message size={22} filled />}
                </button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}
