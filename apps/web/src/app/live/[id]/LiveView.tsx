'use client';

import Link from 'next/link';
import { useState } from 'react';
import * as Icon from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import { VerifiedBadge } from '@/components/VerifiedBadge';
import { LiveChat, LiveVideo, type ChatLine } from '@/components/live/LiveChat';
import { api } from '@/lib/client-api';
import { useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';
import type { LiveInfo } from '../types';

/** Watching a live stream: the picture, who is live, viewers and chat; when it ends, the replay once it is ready. */
export function LiveView({ initial, chat }: { initial: LiveInfo; chat: ChatLine[] }) {
  const { locale } = useShell();
  const [s, setS] = useState(initial);
  const room = `live:${s.id}`;
  const reload = () => api<{ stream: LiveInfo }>(`/live/${s.id}`).then((r) => setS(r.stream)).catch(() => undefined);
  useRealtime<{ count: number }>('viewers', (d) => setS((x) => ({ ...x, viewers: d.count })), room);
  useRealtime('started', reload, room);
  useRealtime('ended', () => setS((x) => ({ ...x, status: 'ENDED', playbackUrl: null })), room);
  useRealtime<{ title: string }>('title', (d) => setS((x) => ({ ...x, title: d.title })), room);
  const live = s.status === 'LIVE' && !!s.playbackUrl;

  return (
    <div className="mx-auto grid max-w-[1600px] gap-5 px-0 pb-16 sm:px-6 sm:pt-4 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0">
        {live ? <LiveVideo src={s.playbackUrl!} className="aspect-video w-full sm:rounded-[24px]" /> : (
          <div className="grid aspect-video w-full place-items-center bg-[radial-gradient(circle_at_30%_30%,#123b38,#050a0a)] px-6 text-center text-white sm:rounded-[24px]">
            <div>
              <Avatar name={s.channel.name} src={s.channel.avatarUrl} size={72} className="mx-auto" />
              <p className="mt-4 font-display text-[22px] font-bold">{s.status === 'ENDED' ? 'This stream has ended' : 'Starting soon'}</p>
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
        </div>
      </div>
      <LiveChat streamId={s.id} initial={chat} live={live} className="mx-4 h-[460px] sm:mx-0 lg:sticky lg:top-20 lg:h-[calc(100dvh-7rem)]" />
    </div>
  );
}
