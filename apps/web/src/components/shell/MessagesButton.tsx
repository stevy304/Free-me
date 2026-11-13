'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { useRealtime, useReconnect } from '@/lib/realtime';

/** Messages in the header: how many conversations have something unread (updated the moment a message arrives). */
export function MessagesButton() {
  const [unread, setUnread] = useState(0);
  const load = useCallback(() => { api<{ count: number }>('/messages/unread').then((r) => setUnread(r.count)).catch(() => undefined); }, []);
  useEffect(load, [load]);
  useRealtime('messages', load);
  useReconnect(load);
  return (
    <Link href="/messages" aria-label={unread ? `Messages, ${unread} unread` : 'Messages'} className="relative grid h-11 w-11 place-items-center rounded-full hover:bg-surface">
      <Icon.Message size={23} />
      {unread > 0 && <span className="absolute right-1 top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[#e8505b] px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
    </Link>
  );
}
