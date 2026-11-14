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

/** "1:02:03" since the stream started. */
const uptime = (startedAt: string, now: number) => {
  const t = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

/** Watching a live stream: the picture, who is live, viewers and chat; when it ends, the replay once it is ready. */
export function LiveView({ initial, chat }: { initial: LiveInfo; chat: ChatLine[] }) {
  const { locale, viewer, t } = useShell();
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
  // How long it has been on (ticks while live), and sharing: the phone's share sheet, or the link copied.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  const [shared, setShared] = useState(false);
  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === 'function') { await navigator.share({ title: s.title, url }).catch(() => undefined); return; }
    try { await navigator.clipboard.writeText(url); setShared(true); setTimeout(() => setShared(false), 2000); } catch { /* not allowed */ }
  };

  return (
    <div className="mx-auto grid max-w-[1600px] gap-5 px-0 pb-16 sm:px-6 sm:pt-4 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0">
        {live ? (
          <div className="relative">
            <LivePlayer src={s.playbackUrl!} latency={s.latencyMode ?? 'normal'} className="aspect-video w-full sm:rounded-2xl" />
            {cc && caption && s.captionsEnabled !== false && (
              <p aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-20 mx-auto w-fit max-w-[88%] rounded-lg bg-black/75 px-3 py-1.5 text-center text-[clamp(14px,2.2vw,22px)] font-semibold leading-snug text-white">{caption.text}</p>
            )}
            {s.captionsEnabled !== false && (
              <button type="button" onClick={toggleCc} aria-pressed={cc} aria-label="Live captions" title="Live captions"
                className={`absolute right-3 top-3 grid h-8 place-items-center rounded-lg px-2 text-[11px] font-extrabold tracking-wide ${cc ? 'bg-white text-[#062320]' : 'bg-black/60 text-white hover:bg-black/75'}`}>CC</button>
            )}
            {reconnecting && (
              <div role="status" className="pointer-events-none absolute inset-x-3 top-3 w-fit rounded-xl border border-amber-400/40 bg-[#1c170f]/95 px-4 py-3 text-sm text-amber-50">
                <strong className="block">{t('live.hostReconnecting')}</strong>
                <span>{t('live.stayHere')}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="grid aspect-video w-full place-items-center bg-[radial-gradient(circle_at_30%_30%,#123b38,#0b0908)] px-6 text-center text-white sm:rounded-2xl">
            <div>
              <Avatar name={s.channel.name} src={s.channel.avatarUrl} size={72} className="mx-auto" />
              <p className="mt-4 font-display text-[22px] font-bold">{s.status === 'ENDED' ? t('live.ended') : t('live.startingSoon')}</p>
              {s.status !== 'ENDED' && s.scheduledFor && <p className="mt-1 text-[15px] text-white/80" suppressHydrationWarning>{new Date(s.scheduledFor).toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>}
              {s.status === 'ENDED' && (s.replayVideoId ? <Link href={`/watch?v=${s.replayVideoId}`} className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-[14px] font-bold text-black"><Icon.Play size={18} />{t('live.watchReplay')}</Link> : <p className="mt-1 text-[14px] text-white/70">{t('live.mayPublish', { name: s.channel.name })}</p>)}
            </div>
          </div>
        )}
        <div className="px-4 pt-4 sm:px-0">
          <div className="flex flex-wrap items-center gap-2">
            {live && <span className="flex items-center gap-1.5 rounded-md bg-[#e5484d] px-2 py-0.5 text-[12px] font-extrabold uppercase text-white"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />{t('live.badge')}</span>}
            {live && <span className="flex items-center gap-1 text-[13px] font-semibold text-muted"><Icon.Eye size={16} />{t('live.watching', { count: s.viewers.toLocaleString(locale) })}</span>}
            {live && s.startedAt && <span className="text-[13px] text-muted" suppressHydrationWarning>· {t('live.for', { time: uptime(s.startedAt, now) })}</span>}
          </div>
          <h1 className="mt-2 font-display text-[22px] font-extrabold leading-tight sm:text-[26px]">{s.title}</h1>
          <div className="mt-3 flex items-center gap-3">
            <Link href={`/@${s.channel.handle}`} className="flex min-w-0 items-center gap-3"><Avatar name={s.channel.name} src={s.channel.avatarUrl} size={44} /><span className="min-w-0"><span className="flex items-center gap-1 truncate font-semibold">{s.channel.name}{s.channel.isVerified && <VerifiedBadge size={15} />}</span><span className="block text-[13px] text-muted">@{s.channel.handle}</span></span></Link>
            <button type="button" onClick={() => void share()} className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover"><Icon.Share size={18} />{shared ? t('live.linkCopied') : t('live.share')}</button>
            <Link href={`/@${s.channel.handle}`} className="flex h-10 items-center rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover">{t('live.visitSpace')}</Link>
          </div>
          {live && s.poll && <div className="mt-4"><PollCard key={s.poll.id} streamId={s.id} poll={s.poll} signedIn={!!viewer} /></div>}
          {s.description && <p className="mt-4 whitespace-pre-line rounded-2xl bg-surface p-4 text-[14px] leading-relaxed">{s.description}</p>}
        </div>
      </div>
      <LiveChat streamId={s.id} initial={chat} live={live} rules={s.chat} className="mx-4 h-[460px] sm:mx-0 lg:sticky lg:top-20 lg:h-[calc(100dvh-7rem)]" />
    </div>
  );
}
