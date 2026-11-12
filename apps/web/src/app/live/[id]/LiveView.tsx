'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { LiveChat, type ChatLine } from '@/components/live/LiveChat';
import { LivePlayer } from '@/components/live/LivePlayer';
import { PollCard, type Poll } from '@/components/live/LivePoll';
import { api } from '@/lib/client-api';
import { useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';
import type { LiveInfo } from '../types';

/** Watching a live stream: the picture, who is live, viewers and chat; when it ends, the replay once it is ready. */
export function LiveView({ initial, chat }: { initial: LiveInfo; chat: ChatLine[] }) {
  const { locale, viewer } = useShell();
  const [s, setS] = useState(initial);
  const [reconnecting, setReconnecting] = useState(false);
  const room = `live:${s.id}`;
  const reload = () => api<{ stream: LiveInfo }>(`/live/${s.id}`).then((r) => setS(r.stream)).catch(() => undefined);
  useRealtime<{ count: number }>('viewers', (d) => setS((x) => ({ ...x, viewers: d.count })), room);
  useRealtime('started', reload, room);
  useRealtime('ended', () => setS((x) => ({ ...x, status: 'ENDED', playbackUrl: null })), room);
  useRealtime<{ title: string }>('title', (d) => setS((x) => ({ ...x, title: d.title })), room);
  useRealtime<Pick<LiveInfo, 'title' | 'description' | 'chat' | 'captionsEnabled' | 'latencyMode'>>('settings', (d) => setS((x) => ({ ...x, ...d })), room);
  useRealtime<{ poll: Poll | null }>('poll', (d) => setS((x) => ({ ...x, poll: d.poll })), room);
  // Live captions: the latest line from the host, shown over the picture while the viewer has them on.
  const [cc, setCc] = useState(() => { try { return localStorage.getItem('fm:live-cc') !== 'off'; } catch { return true; } });
  const [caption, setCaption] = useState<{ text: string; at: number } | null>(null);
  useRealtime<{ text: string; at: number }>('caption', (d) => setCaption({ text: d.text, at: Date.now() }), room);
  useEffect(() => { if (!caption) return; const t = setTimeout(() => setCaption((c) => (c && Date.now() - c.at >= 5500 ? null : c)), 6000); return () => clearTimeout(t); }, [caption]);
  const toggleCc = () => setCc((v) => { try { localStorage.setItem('fm:live-cc', v ? 'off' : 'on'); } catch { /* blocked */ } return !v; });
  useRealtime<{ reconnectUntil: number | null }>('live:signal', (d) => setReconnecting(d.reconnectUntil !== null), room);
  const live = s.status === 'LIVE' && !!s.playbackUrl;

  return (
    <div className="mx-auto grid max-w-[1600px] gap-5 px-0 pb-16 sm:px-6 sm:pt-4 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0">
        {live ? (
          <div className="relative">
            <LivePlayer src={s.playbackUrl!} latency={s.latencyMode ?? 'normal'} className="aspect-video w-full sm:rounded-[24px]" />
            {cc && caption && s.captionsEnabled !== false && (
              <p aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-20 mx-auto w-fit max-w-[88%] rounded-lg bg-black/75 px-3 py-1.5 text-center text-[clamp(14px,2.2vw,22px)] font-semibold leading-snug text-white">{caption.text}</p>
            )}
            {s.captionsEnabled !== false && (
              <button type="button" onClick={toggleCc} aria-pressed={cc} aria-label="Live captions" title="Live captions"
                className={`absolute right-3 top-3 grid h-8 place-items-center rounded-lg px-2 text-[11px] font-extrabold tracking-wide ${cc ? 'bg-white text-[#04201e]' : 'bg-black/60 text-white hover:bg-black/75'}`}>CC</button>
            )}
            {reconnecting && (
              <div role="status" className="pointer-events-none absolute inset-x-3 top-3 w-fit rounded-xl border border-amber-400/40 bg-[#1c170f]/95 px-4 py-3 text-sm text-amber-50">
                <strong className="block">Host reconnecting</strong>
                <span>Stay here. The broadcast will resume if the host reconnects.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="grid aspect-video w-full place-items-center bg-[radial-gradient(circle_at_30%_30%,#123b38,#050a0a)] px-6 text-center text-white sm:rounded-[24px]">
            <div>
              <Avatar name={s.channel.name} src={s.channel.avatarUrl} size={72} className="mx-auto" />
              <p className="mt-4 font-display text-[22px] font-bold">{s.status === 'ENDED' ? 'This stream has ended' : 'Starting soon'}</p>
              {s.status !== 'ENDED' && s.scheduledFor && <p className="mt-1 text-[15px] text-white/80" suppressHydrationWarning>{new Date(s.scheduledFor).toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>}
              {s.status === 'ENDED' && (s.replayVideoId ? <Link href={`/watch?v=${s.replayVideoId}`} className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-[14px] font-bold text-black"><Icon.Play size={18} />Watch the replay</Link> : <p className="mt-1 text-[14px] text-white/70">{s.channel.name} may publish the recording later.</p>)}
            </div>
          </div>
        )}
        <div className="px-4 pt-4 sm:px-0">
          <div className="flex flex-wrap items-center gap-2">
            {live && <span className="flex items-center gap-1.5 rounded-md bg-[#e5484d] px-2 py-0.5 text-[12px] font-extrabold uppercase text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />Live</span>}
            {live && <span className="flex items-center gap-1 text-[13px] font-semibold text-muted"><Icon.Eye size={16} />{s.viewers.toLocaleString(locale)} watching</span>}
          </div>
          <h1 className="mt-2 font-display text-[22px] font-extrabold leading-tight sm:text-[26px]">{s.title}</h1>
          <div className="mt-3 flex items-center gap-3">
            <Link href={`/@${s.channel.handle}`} className="flex min-w-0 items-center gap-3"><Avatar name={s.channel.name} src={s.channel.avatarUrl} size={44} /><span className="min-w-0"><span className="flex items-center gap-1 truncate font-semibold">{s.channel.name}{s.channel.isVerified && <VerifiedBadge size={15} />}</span><span className="block text-[13px] text-muted">@{s.channel.handle}</span></span></Link>
            <Link href={`/@${s.channel.handle}`} className="ml-auto flex h-10 items-center rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover">Visit Space</Link>
          </div>
          {live && s.poll && <div className="mt-4"><PollCard key={s.poll.id} streamId={s.id} poll={s.poll} signedIn={!!viewer} /></div>}
          {s.description && <p className="mt-4 whitespace-pre-line rounded-2xl bg-surface p-4 text-[14px] leading-relaxed">{s.description}</p>}
        </div>
      </div>
      <LiveChat streamId={s.id} initial={chat} live={live} rules={s.chat} className="mx-4 h-[460px] sm:mx-0 lg:sticky lg:top-20 lg:h-[calc(100dvh-7rem)]" />
    </div>
  );
}
