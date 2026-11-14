'use client';

import type Hls from 'hls.js';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Icon from '@/components/icons';
import { hlsSettings } from '@/lib/network';

/** What keeps playing after the viewer leaves the watch page. */
export interface DockVideo {
  id: string; title: string; channelName: string; src: string; poster: string | null; time: number; signedIn: boolean;
}

// A tiny store outside React, so the watch page can hand over without threading a context through the app.
let current: DockVideo | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** The watch page calls this when it goes away: the video if it was playing, or null. */
export function handOffToDock(v: DockVideo | null) { current = v; emit(); }
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

/**
 * Mini-player: a video that was playing keeps playing in a corner (a bar above the dock on phones) while the viewer
 * browses. Tap to return to the full page at the same moment; close to stop. Hidden on watch pages, where the main
 * player is. It saves progress like the main player, so "Continue watching" stays right.
 */
export function MiniDock() {
  const dock = useSyncExternalStore(subscribe, () => current, () => null);
  const pathname = usePathname();
  const onWatch = pathname?.startsWith('/watch') ?? false;
  if (!dock || onWatch) return null;
  return <Dock key={dock.id} v={dock} />;
}

function Dock({ v }: { v: DockVideo }) {
  const router = useRouter();
  const el = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  // Watch time played here, reported like the main player's (the server only counts it after a counted view).
  const unsent = useRef(0);
  const lastT = useRef(v.time);

  const save = (ended = false) => {
    const played = Math.floor(unsent.current);
    if (played >= 1) {
      unsent.current -= played;
      fetch(`/api/videos/${v.id}/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: played }), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
    }
    const t = Math.floor(el.current?.currentTime ?? v.time);
    if (!v.signedIn || t < 1) return;
    fetch(`/api/videos/${v.id}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: t, ended }), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
  };

  useEffect(() => {
    const video = el.current!;
    let hls: Hls | null = null;
    let off = false;
    const start = () => {
      if (v.time > 0) video.currentTime = v.time;
      // The viewer just clicked a link, so playing with sound is allowed; if a browser refuses, it waits paused.
      video.play().catch(() => undefined);
    };
    if (video.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) {
      video.src = v.src;
      video.addEventListener('loadedmetadata', start, { once: true });
    } else {
      import('hls.js').then(({ default: H }) => {
        if (off || !H.isSupported()) return;
        hls = new H({ startPosition: v.time, maxBufferLength: 20, ...hlsSettings('vod') });
        hls.on(H.Events.MANIFEST_PARSED, start);
        hls.loadSource(v.src);
        hls.attachMedia(video);
      }).catch(() => undefined);
    }
    const tick = () => {
      setProgress(video.duration ? video.currentTime / video.duration : 0);
      const delta = video.currentTime - lastT.current;
      if (!video.paused && delta > 0 && delta < 2) unsent.current += delta;
      lastT.current = video.currentTime;
    };
    const timer = setInterval(() => save(), 15_000);
    video.addEventListener('timeupdate', tick);
    return () => { off = true; clearInterval(timer); video.removeEventListener('timeupdate', tick); hls?.destroy(); };
  }, [v.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { save(); el.current?.pause(); handOffToDock(null); };
  const expand = () => {
    const t = Math.floor(el.current?.currentTime ?? v.time);
    save();
    el.current?.pause();
    handOffToDock(null);
    router.push(`/watch?v=${v.id}${t > 0 ? `&t=${t}` : ''}`);
  };
  const toggle = () => { const x = el.current; if (!x) return; if (x.paused) void x.play().catch(() => undefined); else { x.pause(); save(); } };

  return (
    <div role="region" aria-label="Mini-player" className="fixed inset-x-3 bottom-[92px] z-40 overflow-hidden rounded-2xl border border-white/10 bg-[#14110f] text-white shadow-[0_18px_50px_rgb(0_0_0/0.45)] md:inset-x-auto md:bottom-6 md:right-6 md:w-[320px]">
      <div className="flex items-center gap-3 md:block">
        <button type="button" onClick={expand} aria-label={`Back to ${v.title}`} className="group relative aspect-video w-[132px] shrink-0 bg-black md:w-full">
          <video ref={el} playsInline poster={v.poster ?? undefined} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); save(true); }} className="h-full w-full object-cover" />
          <span className="absolute inset-0 hidden place-items-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100 md:grid"><Icon.Fullscreen size={24} /></span>
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 py-2 pr-2 md:px-3 md:py-2.5">
          <button type="button" onClick={expand} className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[14px] font-semibold">{v.title}</span>
            <span className="block truncate text-[12px] text-white/60">{v.channelName}</span>
          </button>
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-white/10">{playing ? <Icon.Pause size={22} /> : <Icon.Play size={22} />}</button>
          <button type="button" onClick={close} aria-label="Close the mini-player" className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-white/10"><Icon.Close size={20} /></button>
        </div>
      </div>
      <div className="h-[3px] bg-white/10"><div className="h-full bg-[#22ada2]" style={{ width: `${progress * 100}%` }} /></div>
    </div>
  );
}
