'use client';

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * One socket per tab to the API (/api/socket, WebSocket only), for instant updates: new comments, Sparks,
 * notifications, processing progress, payments, live chat and viewers. It reconnects by itself, and rooms are
 * joined again after a reconnect. Pages still load their data through the normal API; events only say "this changed".
 */
let socket: Socket | null = null;
let loading: Promise<Socket> | null = null;
const joined = new Map<string, number>();

export function getSocket(): Promise<Socket> {
  if (socket) return Promise.resolve(socket);
  loading ??= import('socket.io-client').then(({ io }) => {
    const s = io({ path: '/api/socket', addTrailingSlash: false, transports: ['websocket'], withCredentials: true });
    s.on('connect', () => { for (const r of joined.keys()) s.emit('join', r); });
    socket = s;
    return s;
  });
  return loading;
}

/** Runs `handler` whenever `event` arrives; with `room` (e.g. `video:<id>`), joins that room while mounted. */
export function useRealtime<T = unknown>(event: string, handler: (data: T) => void, room?: string | null, enabled = true) {
  const cb = useRef(handler); cb.current = handler;
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    let s: Socket | null = null; let off = false;
    const on = (d: T) => cb.current(d);
    void getSocket().then((sock) => {
      if (off) return;
      s = sock; sock.on(event, on);
      if (room) { joined.set(room, (joined.get(room) ?? 0) + 1); if (sock.connected) sock.emit('join', room); }
    });
    return () => {
      off = true;
      if (!s) return;
      s.off(event, on);
      if (room) { const n = (joined.get(room) ?? 1) - 1; if (n <= 0) { joined.delete(room); s.emit('leave', room); } else joined.set(room, n); }
    };
  }, [event, room, enabled]);
}

/** After a reconnect (or the first connect), e.g. to refetch what may have been missed while offline. */
export function useReconnect(handler: () => void) {
  const cb = useRef(handler); cb.current = handler;
  useEffect(() => {
    let s: Socket | null = null; let first = true;
    const on = () => { if (first) { first = false; return; } cb.current(); };
    void getSocket().then((sock) => { s = sock; sock.on('connect', on); });
    return () => { s?.off('connect', on); };
  }, []);
}
