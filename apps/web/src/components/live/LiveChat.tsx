'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { getSocket, useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';

export interface ChatLine { id: string; text: string; at: string; author: { name: string; handle: string | null; avatarUrl: string | null; verified: boolean; host: boolean } }

/** Live chat: lines arrive over the socket; signed-in viewers write (one line, up to 200 characters). */
export function LiveChat({ streamId, initial, live, rules, className = '' }: { streamId: string; initial: ChatLine[]; live: boolean; rules?: { mode: 'everyone' | 'followers' | 'off'; slowModeSeconds: number }; className?: string }) {
  const { viewer } = useShell();
  const [lines, setLines] = useState<ChatLine[]>(initial);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  useRealtime<ChatLine>('chat', (l) => setLines((cur) => (cur.some((x) => x.id === l.id) ? cur : [...cur.slice(-199), l])), `live:${streamId}`);
  useEffect(() => { const el = list.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight; }, [lines]);

  const send = async () => {
    const t = text.trim(); if (!t) return;
    setError(null);
    const s = await getSocket();
    const r = await s.timeout(5000).emitWithAck('live:chat', { streamId, text: t }).catch(() => ({ ok: false, error: 'Not connected. Try again.' }));
    if (r.ok) setText(''); else setError(r.error ?? 'Not sent.');
  };

  return (
    <section aria-label="Live chat" className={`flex min-h-0 flex-col rounded-3xl border border-line bg-elevated ${className}`}>
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 font-display text-[16px] font-bold">Live chat
        {rules && rules.mode !== 'everyone' && <span className="rounded-full bg-surface px-2 py-0.5 font-sans text-[11px] font-semibold text-muted">{rules.mode === 'off' ? 'Off' : 'Followers only'}</span>}
        {rules && rules.mode !== 'off' && rules.slowModeSeconds > 0 && <span className="rounded-full bg-surface px-2 py-0.5 font-sans text-[11px] font-semibold text-muted">Slow mode · {rules.slowModeSeconds < 60 ? `${rules.slowModeSeconds}s` : `${rules.slowModeSeconds / 60} min`}</span>}
      </h2>
      <ol ref={list} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-[14px]" aria-live="polite">
        {lines.map((l) => (
          <li key={l.id} className="flex gap-2.5">
            <Avatar name={l.author.name} src={l.author.avatarUrl} size={26} />
            <p className="min-w-0 break-words leading-snug"><span className={`mr-1.5 inline-flex items-center gap-1 font-semibold ${l.author.host ? 'rounded bg-brand px-1.5 text-on-brand' : 'text-muted'}`}>{l.author.name}{l.author.verified && <VerifiedBadge size={12} />}</span>{l.text}</p>
          </li>
        ))}
        {!lines.length && <li className="py-6 text-center text-muted">{live ? 'Say hello to start the conversation.' : 'Chat opens when the stream is live.'}</li>}
      </ol>
      <div className="border-t border-line p-3">
        {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
        {viewer ? (
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} disabled={!live} placeholder={live ? 'Say something…' : 'Chat is closed'} aria-label="Chat message" className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[14px] outline-none focus:border-brand disabled:opacity-60" />
            <button type="submit" disabled={!live || !text.trim()} aria-label="Send" className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-on-brand disabled:opacity-50"><Icon.Send size={18} /></button>
          </form>
        ) : <Link href={`/login?returnTo=/live/${streamId}`} className="block rounded-xl bg-surface px-3 py-2.5 text-center text-[14px] font-semibold hover:bg-surface-hover">Sign in to chat</Link>}
      </div>
    </section>
  );
}

