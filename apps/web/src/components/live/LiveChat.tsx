'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { getSocket, useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';
import { hlsSettings } from '@/lib/network';

export interface ChatLine { id: string; text: string; at: string; author: { name: string; handle: string | null; avatarUrl: string | null; verified: boolean; host: boolean } }

/** Live chat: lines arrive over the socket; signed-in viewers write (one line, up to 200 characters). */
export function LiveChat({ streamId, initial, live, rules, className = '' }: { streamId: string; initial: ChatLine[]; live: boolean; rules?: { mode: 'everyone' | 'followers' | 'off'; slowModeSeconds: number }; className?: string }) {
  const { viewer, t: tr } = useShell();
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
    const r = await s.timeout(5000).emitWithAck('live:chat', { streamId, text: t }).catch(() => ({ ok: false, error: tr('chat.notConnected') }));
    if (r.ok) setText(''); else setError(r.error ?? tr('chat.notSent'));
  };

  return (
    <section aria-label={tr('live.chat')} className={`flex min-h-0 flex-col rounded-3xl border border-line bg-elevated ${className}`}>
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 font-display text-[16px] font-bold">{tr('live.chat')}
        {rules && rules.mode !== 'everyone' && <span className="rounded-full bg-surface px-2 py-0.5 font-sans text-[11px] font-semibold text-muted">{rules.mode === 'off' ? tr('chat.off') : tr('chat.followersOnly')}</span>}
        {rules && rules.mode !== 'off' && rules.slowModeSeconds > 0 && <span className="rounded-full bg-surface px-2 py-0.5 font-sans text-[11px] font-semibold text-muted">Slow mode · {rules.slowModeSeconds < 60 ? `${rules.slowModeSeconds}s` : `${rules.slowModeSeconds / 60} min`}</span>}
      </h2>
      <ol ref={list} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-[14px]" aria-live="polite">
        {lines.map((l) => (
          <li key={l.id} className="flex gap-2.5">
            <Avatar name={l.author.name} src={l.author.avatarUrl} size={26} />
            <p className="min-w-0 break-words leading-snug"><span className={`mr-1.5 inline-flex items-center gap-1 font-semibold ${l.author.host ? 'rounded bg-brand px-1.5 text-on-brand' : 'text-muted'}`}>{l.author.name}{l.author.verified && <VerifiedBadge size={12} />}</span>{l.text}</p>
          </li>
        ))}
        {!lines.length && <li className="py-6 text-center text-muted">{live ? tr('chat.empty') : tr('chat.notLive')}</li>}
      </ol>
      <div className="border-t border-line p-3">
        {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
        {viewer ? (
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} disabled={!live} placeholder={live ? tr('chat.placeholder') : tr('chat.closed')} aria-label={tr('chat.message')} className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[14px] outline-none focus:border-brand disabled:opacity-60" />
            <button type="submit" disabled={!live || !text.trim()} aria-label={tr('chat.send')} className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-on-brand disabled:opacity-50"><Icon.Send size={18} /></button>
          </form>
        ) : <Link href={`/login?returnTo=/live/${streamId}`} className="block rounded-xl bg-surface px-3 py-2.5 text-center text-[14px] font-semibold hover:bg-surface-hover">{tr('chat.signIn')}</Link>}
      </div>
    </section>
  );
}

/** Plays a live HLS stream (Safari natively, elsewhere hls.js), starting near the live edge. */
export function LiveVideo({ src, muted = false, className = '' }: { src: string; muted?: boolean; className?: string }) {
  const el = useRef<HTMLVideoElement>(null);
  const player = useRef<Hls | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qualities, setQualities] = useState<number[]>([]);
  const [selected, setSelected] = useState(-1);
  const [current, setCurrent] = useState<number | null>(null);
  useEffect(() => {
    const v = el.current!;
    let off = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setErr(null);
    setQualities([]);
    setSelected(-1);
    setCurrent(null);
    const play = () => { v.play().catch(() => { if (!off) { v.muted = true; v.play().catch(() => undefined); } }); };
    if (v.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) {
      v.src = src;
      v.onerror = () => {
        if (off) return;
        setErr('Waiting for the live video signal…');
        clearTimeout(retry);
        retry = setTimeout(() => { if (!off) { v.load(); play(); } }, Math.min(10_000, 1000 * 2 ** Math.min(attempts++, 4)));
      };
      play();
    } else import('hls.js').then(({ default: H }) => {
      if (off) return;
      if (!H.isSupported()) { setErr('This browser cannot play live video.'); return; }
      const x = new H({ liveSyncDurationCount: 3, lowLatencyMode: false, maxBufferLength: 20, startLevel: -1, ...hlsSettings('live') });
      player.current = x;
      x.on(H.Events.MANIFEST_PARSED, (_, data) => {
        attempts = 0; setErr(null);
        setQualities(data.levels.map((level) => level.height));
        play();
      });
      x.on(H.Events.LEVEL_SWITCHED, (_, data) => setCurrent(x.levels[data.level]?.height ?? null));
      x.on(H.Events.ERROR, (_e, d) => {
        if (!d.fatal || off) return;
        if (d.type === H.ErrorTypes.NETWORK_ERROR) {
          setErr('Waiting for the live video signal…'); clearTimeout(retry);
          retry = setTimeout(() => {
            if (off) return;
            if (d.details === H.ErrorDetails.MANIFEST_LOAD_ERROR || d.details === H.ErrorDetails.MANIFEST_LOAD_TIMEOUT) x.loadSource(src);
            else x.startLoad();
          }, Math.min(10_000, 1000 * 2 ** Math.min(attempts++, 4)));
        } else x.recoverMediaError();
      });
      x.loadSource(src);
      x.attachMedia(v);
    }).catch(() => { if (!off) setErr('The live player could not load.'); });
    return () => { off = true; clearTimeout(retry); v.onerror = null; player.current?.destroy(); player.current = null; v.removeAttribute('src'); v.load(); };
  }, [src]);

  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      <video ref={el} controls playsInline onPlaying={() => setErr(null)} muted={muted} className="h-full w-full" />
      {qualities.length > 1 && (
        <label className="absolute right-3 top-3 flex items-center gap-2 rounded-lg bg-black/85 px-2 py-1.5 text-xs font-semibold text-white">
          Quality
          <select aria-label="Quality" value={selected} onChange={(e) => {
            const level = Number(e.target.value);
            if (player.current) player.current.loadLevel = level;
            setSelected(level);
          }} className="rounded bg-[#202020] px-1 py-0.5">
            <option value={-1}>{selected === -1 && current ? `Auto · ${current}p` : 'Auto'}</option>
            {qualities.map((height, i) => <option key={i} value={i}>{height}p</option>)}
          </select>
        </label>
      )}
      {err && <p className="absolute inset-0 grid place-items-center p-6 text-center text-white">{err}</p>}
    </div>
  );
}
