'use client';

import type Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';

/** How close to the newest piece the player stays, and how far behind still counts as "live". */
const LATENCY = {
  normal: { syncCount: 3, edgeSeconds: 10 },
  low: { syncCount: 2, edgeSeconds: 5 },
} as const;

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

/**
 * The live player: HLS with adaptive quality (hls.js; Safari natively), and controls made for live.
 * - DVR: the timeline covers what has been broadcast (rewind, 10 s back and forward, drag to any moment).
 * - Live edge: a red LIVE dot while the player is at the newest pieces; once behind, it turns into "Go to live",
 *   which jumps back to the edge.
 * - Latency: the host's choice; low latency stays two pieces (2 s) from the edge and speeds up a little to catch up.
 * Keyboard: space/K play and pause, arrows 10 s, L live, M mute, F fullscreen.
 */
/** `muted`: start without sound and never ask for it (the host's own preview in Live Studio, which would echo). */
export function LivePlayer({ src, latency = 'normal', className = '', overlay, muted: startMuted = false }: { src: string; latency?: 'normal' | 'low'; className?: string; overlay?: React.ReactNode; muted?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(startMuted);
  const [range, setRange] = useState({ start: 0, end: 0, now: 0 });
  const [qualities, setQualities] = useState<number[]>([]);
  const [level, setLevel] = useState(-1);
  const [current, setCurrent] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [idle, setIdle] = useState(false);
  const cfg = LATENCY[latency];

  useEffect(() => {
    const v = el.current!;
    let off = false;
    if (startMuted) v.muted = true;
    setErr(null); setQualities([]); setLevel(-1); setCurrent(null);
    const play = () => { v.play().catch(() => { if (!off) { v.muted = true; setMuted(true); v.play().catch(() => undefined); } }); };
    if (v.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) {
      v.src = src;
      play();
    } else import('hls.js').then(({ default: H }) => {
      if (off) return;
      if (!H.isSupported()) { setErr('This browser cannot play live video.'); return; }
      // No liveMaxLatency: someone who rewinds stays where they are until they choose "Go to live".
      const x = new H({ liveSyncDurationCount: cfg.syncCount, maxLiveSyncPlaybackRate: latency === 'low' ? 1.1 : 1, maxBufferLength: 20, startLevel: -1, backBufferLength: 90 });
      hls.current = x;
      x.on(H.Events.MANIFEST_PARSED, (_, data) => { setQualities(data.levels.map((l) => l.height)); play(); });
      x.on(H.Events.LEVEL_SWITCHED, (_, data) => setCurrent(x.levels[data.level]?.height ?? null));
      x.on(H.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        // Opened in the first seconds of a stream: the playlist may not be published yet. Ask again shortly.
        if (d.details === H.ErrorDetails.MANIFEST_LOAD_ERROR || d.details === H.ErrorDetails.MANIFEST_LOAD_TIMEOUT || d.details === H.ErrorDetails.MANIFEST_PARSING_ERROR) {
          setTimeout(() => { if (!off && hls.current === x) x.loadSource(src); }, 2000);
        } else if (d.type === H.ErrorTypes.NETWORK_ERROR) x.startLoad();
        else x.recoverMediaError();
      });
      x.loadSource(src);
      x.attachMedia(v);
    }).catch(() => { if (!off) setErr('The live player could not load.'); });
    const tick = () => {
      const s = v.seekable;
      if (s.length) setRange({ start: s.start(0), end: s.end(s.length - 1), now: v.currentTime });
    };
    const timer = setInterval(tick, 500);
    v.addEventListener('timeupdate', tick);
    return () => { off = true; clearInterval(timer); v.removeEventListener('timeupdate', tick); hls.current?.destroy(); hls.current = null; v.removeAttribute('src'); v.load(); };
  }, [src, latency, cfg.syncCount, startMuted]);

  const behind = Math.max(0, range.end - range.now);
  const atEdge = range.end === 0 || behind <= cfg.edgeSeconds;
  const span = Math.max(1, range.end - range.start);

  const goLive = useCallback(() => {
    const v = el.current; if (!v) return;
    const target = hls.current?.liveSyncPosition ?? (v.seekable.length ? v.seekable.end(v.seekable.length - 1) - cfg.syncCount * 2 : v.currentTime);
    v.currentTime = target;
    if (v.paused) void v.play().catch(() => undefined);
  }, [cfg.syncCount]);
  const seekBy = useCallback((d: number) => {
    const v = el.current; if (!v || !v.seekable.length) return;
    const end = hls.current?.liveSyncPosition ?? v.seekable.end(v.seekable.length - 1);
    v.currentTime = Math.min(end, Math.max(v.seekable.start(0), v.currentTime + d));
  }, []);
  const toggle = useCallback(() => { const v = el.current; if (!v) return; if (v.paused) void v.play().catch(() => undefined); else v.pause(); }, []);
  const mute = useCallback(() => { const v = el.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); }, []);
  const fullscreen = useCallback(() => { if (document.fullscreenElement) void document.exitFullscreen(); else void box.current?.requestFullscreen?.().catch(() => undefined); }, []);

  // Controls hide after 3 s without movement while playing.
  useEffect(() => {
    if (!playing || menu) { setIdle(false); return; }
    const b = box.current; if (!b) return;
    let t = setTimeout(() => setIdle(true), 3000);
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    b.addEventListener('pointermove', wake); b.addEventListener('pointerdown', wake);
    return () => { clearTimeout(t); b.removeEventListener('pointermove', wake); b.removeEventListener('pointerdown', wake); };
  }, [playing, menu]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,select,textarea')) return;
    const k = e.key.toLowerCase();
    const done = () => { e.preventDefault(); setIdle(false); };
    if (k === ' ' || k === 'k') { done(); toggle(); }
    else if (k === 'arrowleft' || k === 'j') { done(); seekBy(-10); }
    else if (k === 'arrowright') { done(); seekBy(10); }
    else if (k === 'l') { done(); goLive(); }
    else if (k === 'm') { done(); mute(); }
    else if (k === 'f') { done(); fullscreen(); }
  };

  const btn = 'grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white hover:bg-white/15';
  const show = !playing || !idle || menu;
  return (
    <div ref={box} tabIndex={0} onKeyDown={onKey} aria-label="Live video" className={`group relative overflow-hidden bg-black outline-none ${className} ${show ? '' : 'cursor-none'}`}>
      <video ref={el} playsInline className="h-full w-full" onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onVolumeChange={(e) => setMuted(e.currentTarget.muted)} />
      {overlay}
      {muted && playing && !startMuted && (
        <button type="button" onClick={mute} className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg bg-black/70 px-2.5 py-1.5 text-[12px] font-bold text-white hover:bg-black/85"><Icon.VolumeOff size={16} />Tap for sound</button>
      )}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-2 pt-10 transition-opacity duration-200 ${show ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
        {/* DVR timeline: what has been broadcast so far; the right end is now. */}
        {range.end > range.start + 5 && (
          <input type="range" aria-label="Rewind the broadcast" min={range.start} max={range.end} step={1} value={Math.min(range.end, Math.max(range.start, range.now))}
            onChange={(e) => { const v = el.current; if (v) v.currentTime = Number(e.target.value); }}
            className="mb-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/25 accent-[#e5484d]"
            style={{ background: `linear-gradient(to right, #e5484d ${((range.now - range.start) / span) * 100}%, rgb(255 255 255 / 0.25) 0)` }} />
        )}
        <div className="flex items-center gap-1">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} className={btn}>{playing ? <Icon.Pause size={22} /> : <Icon.Play size={22} />}</button>
          <button type="button" onClick={() => seekBy(-10)} aria-label="Back 10 seconds" className={`${btn} text-[11px] font-bold`}>−10</button>
          <button type="button" onClick={() => seekBy(10)} disabled={atEdge} aria-label="Forward 10 seconds" className={`${btn} text-[11px] font-bold disabled:opacity-40`}>+10</button>
          <button type="button" onClick={mute} aria-label={muted ? 'Unmute' : 'Mute'} className={btn}>{muted ? <Icon.VolumeOff size={20} /> : <Icon.VolumeHigh size={20} />}</button>
          {/* Live edge: red while at the newest pieces; otherwise a button back to live, with how far behind. */}
          <button type="button" onClick={goLive} disabled={atEdge} aria-label={atEdge ? 'Live' : `Go to live (${clock(behind)} behind)`}
            className={`ml-1 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-extrabold uppercase tracking-wide ${atEdge ? 'cursor-default text-white' : 'bg-white/15 text-white hover:bg-white/25'}`}>
            <span className={`h-2 w-2 rounded-full ${atEdge ? 'bg-[#e5484d] motion-safe:animate-pulse' : 'bg-white/50'}`} />
            {atEdge ? 'Live' : <>Go to live<span className="font-semibold normal-case tracking-normal text-white/70">−{clock(behind)}</span></>}
          </button>
          <span className="ml-auto" />
          {latency === 'low' && <span className="hidden rounded-md bg-white/10 px-2 py-1 text-[11px] font-semibold text-white/80 sm:inline">Low latency</span>}
          {qualities.length > 1 && (
            <div className="relative">
              <button type="button" onClick={() => setMenu((m) => !m)} aria-label="Quality" aria-haspopup="menu" aria-expanded={menu} className="h-8 rounded-lg px-2 text-[12px] font-bold text-white hover:bg-white/15">
                {level === -1 ? `Auto${current ? ` · ${current}p` : ''}` : `${qualities[level]}p`}
              </button>
              {menu && (
                <div role="menu" className="absolute bottom-10 right-0 w-36 overflow-hidden rounded-xl bg-[#0b1413]/95 py-1 text-[13px] text-white shadow-xl">
                  {[-1, ...qualities.map((_, i) => i).reverse()].map((i) => (
                    <button key={i} type="button" role="menuitemradio" aria-checked={level === i} onClick={() => { if (hls.current) hls.current.currentLevel = i; setLevel(i); setMenu(false); }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-white/10 ${level === i ? 'font-bold text-[#2bb5ab]' : ''}`}>
                      {i === -1 ? 'Auto' : `${qualities[i]}p`}{level === i && <Icon.Check size={16} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={fullscreen} aria-label="Full screen" className={btn}><Icon.Fullscreen size={20} /></button>
        </div>
      </div>
      {err && <p className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-white">{err}</p>}
    </div>
  );
}
