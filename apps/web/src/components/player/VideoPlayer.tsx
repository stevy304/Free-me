'use client';

import * as Icon from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';

interface Level { index: number; height: number; width: number; label: string }
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const label = (h: number, w: number) => `${Math.min(h, w)}p`;

/**
 * Adaptive video player: hls.js (Safari plays HLS natively), quality and speed menus, theater mode, picture-in-picture,
 * fullscreen and the usual keyboard shortcuts (k/space, j/l, arrows, m, f, t, 0-9, <, >). A view is reported once,
 * after real watching (30 s, or half of a short video). `startAt` resumes where the viewer stopped; `onProgress` is
 * called every 10 seconds of playback, on pause, at the end and when the page is left, to remember the position.
 */
export function VideoPlayer({ src, poster, videoId, durationHint, autoPlay = true, theater, onTheater, onEnded, startAt = 0, onProgress }: {
  src: string; poster?: string | null; videoId?: string; durationHint?: number; autoPlay?: boolean; theater?: boolean; onTheater?: () => void; onEnded?: () => void;
  startAt?: number; onProgress?: (seconds: number, ended: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1); // -1 = auto
  const [playingLevel, setPlayingLevel] = useState<number | null>(null);
  const [menu, setMenu] = useState<null | 'main' | 'quality' | 'speed'>(null);
  const [idle, setIdle] = useState(false);
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [flash, setFlash] = useState<'play' | 'pause' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watched = useRef(0);
  const reported = useRef(false);
  const lastT = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(0);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const save = useCallback((ended = false) => {
    const el = video.current;
    if (!el || !progressRef.current || el.currentTime < 1) return;
    lastSaved.current = Date.now();
    progressRef.current(Math.floor(el.currentTime), ended);
  }, []);

  // Resume once the video knows its length.
  useEffect(() => {
    const el = video.current!;
    if (!(startAt > 0)) return;
    const go = () => { if (el.duration && startAt < el.duration - 5) el.currentTime = startAt; };
    if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
    return () => el.removeEventListener('loadedmetadata', go);
  }, [src, startAt]);

  // Remember the position when the viewer leaves the page or switches tabs.
  useEffect(() => {
    const leave = () => save();
    const vis = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', vis);
    return () => { save(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', vis); };
  }, [src, save]);

  // Source: native HLS on Safari/iOS, hls.js elsewhere.
  useEffect(() => {
    const el = video.current!;
    setError(null); setLevels([]); setLevel(-1); reported.current = false; watched.current = 0;
    const v = Number(store.get('fm_volume') ?? '1'); const m = store.get('fm_muted') === '1';
    el.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; el.muted = m; setVolume(el.volume); setMuted(m);
    let cancelled = false;
    if (el.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) {
      el.src = src;
    } else {
      import('hls.js').then(({ default: H }) => {
        if (cancelled) return;
        if (!H.isSupported()) { setError('This browser cannot play this video.'); return; }
        const h = new H({ capLevelToPlayerSize: true, startLevel: -1, maxBufferLength: 30, backBufferLength: 60 });
        hls.current = h;
        h.on(H.Events.MANIFEST_PARSED, () => setLevels(h.levels.map((l, index) => ({ index, height: l.height, width: l.width, label: label(l.height, l.width) })).reverse()));
        h.on(H.Events.LEVEL_SWITCHED, (_e, d) => { const l = h.levels[d.level]; setPlayingLevel(l ? Math.min(l.height, l.width) : null); });
        let recoveries = 0;
        h.on(H.Events.ERROR, (_e, d) => {
          if (d.details === H.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) { setError('This browser cannot play H.264 video. Open the video in Chrome, Edge, Safari or Firefox.'); setWaiting(false); return; }
          if (!d.fatal) return;
          if (d.type === H.ErrorTypes.NETWORK_ERROR && recoveries++ < 3) h.startLoad();
          else if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries++ < 3) h.recoverMediaError();
          else { setError('This video cannot be played right now. Check your connection and try again.'); setWaiting(false); }
        });
        h.loadSource(src); h.attachMedia(el);
      });
    }
    if (autoPlay) el.play().catch(() => { el.muted = true; setMuted(true); el.play().catch(() => undefined); });
    return () => { cancelled = true; hls.current?.destroy(); hls.current = null; el.removeAttribute('src'); el.load(); };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const s = Number(store.get('fm_speed') ?? '1'); if (SPEEDS.includes(s)) { setSpeed(s); if (video.current) video.current.playbackRate = s; } }, []);

  const toggle = useCallback(() => {
    const el = video.current!;
    if (el.paused || el.ended) { void el.play(); setFlash('play'); } else { el.pause(); setFlash('pause'); }
    setTimeout(() => setFlash(null), 500);
  }, []);
  const seek = useCallback((t: number) => { const el = video.current!; el.currentTime = Math.max(0, Math.min((el.duration || duration) - 0.05, t)); }, [duration]);
  const setVol = (v: number, m = v === 0) => { const el = video.current!; el.volume = v; el.muted = m; setVolume(v); setMuted(m); store.set('fm_volume', String(v)); store.set('fm_muted', m ? '1' : '0'); };
  const setRate = (s: number) => { video.current!.playbackRate = s; setSpeed(s); store.set('fm_speed', String(s)); };
  const chooseLevel = (i: number) => { if (hls.current) { hls.current.currentLevel = i; hls.current.loadLevel = i; } setLevel(i); setMenu(null); };
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void box.current?.requestFullscreen?.(); };
  const pip = async () => { const el = video.current!; try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture(); } catch { /* not allowed */ } };

  const poke = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { if (!video.current?.paused) { setIdle(true); setMenu(null); } }, 2500);
  }, []);

  // Keyboard shortcuts while the page (not a text field) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = video.current; if (!el) return;
      const k = e.key.toLowerCase();
      const handled = () => { e.preventDefault(); poke(); };
      if (k === ' ' || k === 'k') { handled(); toggle(); }
      else if (k === 'j') { handled(); seek(el.currentTime - 10); }
      else if (k === 'l') { handled(); seek(el.currentTime + 10); }
      else if (k === 'arrowleft') { handled(); seek(el.currentTime - 5); }
      else if (k === 'arrowright') { handled(); seek(el.currentTime + 5); }
      else if (k === 'arrowup') { handled(); setVol(Math.min(1, el.volume + 0.05), false); }
      else if (k === 'arrowdown') { handled(); setVol(Math.max(0, el.volume - 0.05)); }
      else if (k === 'm') { handled(); setVol(el.volume || 1, !el.muted); }
      else if (k === 'f') { handled(); fullscreen(); }
      else if (k === 't' && onTheater) { handled(); onTheater(); }
      else if (/^[0-9]$/.test(k)) { handled(); seek(((el.duration || duration) * Number(k)) / 10); }
      else if (e.key === '>' ) { handled(); setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]); }
      else if (e.key === '<') { handled(); setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek, poke, onTheater, duration, speed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const f = () => setFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);

  const onTime = () => {
    const el = video.current!;
    setTime(el.currentTime);
    if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
    const delta = el.currentTime - lastT.current;
    if (!el.paused && delta > 0 && delta < 2) watched.current += delta;
    lastT.current = el.currentTime;
    if (!el.paused && Date.now() - lastSaved.current > 10_000) save();
    const need = Math.min(30, (el.duration || duration) * 0.5);
    if (videoId && !reported.current && need > 0 && watched.current >= need) {
      reported.current = true;
      fetch(`/api/videos/${videoId}/views`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: Math.round(watched.current) }), credentials: 'same-origin' }).catch(() => undefined);
    }
  };

  const pct = (n: number) => `${duration ? Math.min(100, (n / duration) * 100) : 0}%`;
  const VolIcon = muted || volume === 0 ? Icon.VolumeOff : volume < 0.5 ? Icon.VolumeLow : Icon.VolumeHigh;
  const autoLabel = level === -1 ? `Auto${playingLevel ? ` (${playingLevel}p)` : ''}` : levels.find((l) => l.index === level)?.label ?? 'Auto';
  const btn = 'grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white hover:bg-white/10';
  const showUi = !playing || !idle || menu !== null;

  return (
    <div ref={box} onMouseMove={poke} onMouseLeave={() => playing && setIdle(true)}
      className={`group relative aspect-video w-full select-none overflow-hidden bg-black ${full ? '' : 'rounded-[24px]'} ${showUi ? '' : 'cursor-none'}`}>
      <video ref={video} playsInline poster={poster ?? undefined} className="h-full w-full" onClick={toggle} onDoubleClick={fullscreen}
        onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); save(); }} onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)} onCanPlay={() => setWaiting(false)}
        onTimeUpdate={onTime} onDurationChange={(e) => setDuration(e.currentTarget.duration)} onEnded={() => { setPlaying(false); save(true); onEnded?.(); }}
        onVolumeChange={(e) => { setMuted(e.currentTarget.muted); setVolume(e.currentTarget.volume); }} />
      {waiting && !error && <Icon.Spinner className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/90" />}
      {flash && <div className="pointer-events-none absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 animate-ping place-items-center rounded-full bg-[rgb(43_181_171/0.6)] text-white [animation-iteration-count:1]">{flash === 'play' ? <Icon.Play size={30} /> : <Icon.Pause size={30} />}</div>}
      {error && <div className="absolute inset-0 grid place-items-center bg-black/80 px-6 text-center text-[15px] text-white">{error}</div>}

      {/* Controls: a floating capsule above the bottom edge, not a bar across it. */}
      <div className={`absolute inset-x-2 bottom-2 transition-all duration-200 sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:w-[min(92%,860px)] sm:-translate-x-1/2 ${showUi ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}>
        {menu && (
          <div className="absolute bottom-[68px] right-0 w-[min(100%,300px)] overflow-hidden rounded-2xl border border-white/10 bg-[rgb(16_32_31/0.92)] p-2 text-[14px] text-white shadow-2xl backdrop-blur-md" role="menu">
            {menu === 'main' && (
              <>
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/50">Playback</p>
                <button type="button" className="flex w-full items-center justify-between rounded-xl px-3 py-3 hover:bg-white/10" onClick={() => setMenu('speed')}><span>Speed</span><span className="flex items-center gap-1 text-white/70">{speed === 1 ? 'Normal' : `${speed}×`}<Icon.ChevronRight size={16} /></span></button>
                {levels.length > 0 && <button type="button" className="flex w-full items-center justify-between rounded-xl px-3 py-3 hover:bg-white/10" onClick={() => setMenu('quality')}><span>Quality</span><span className="flex items-center gap-1 text-white/70">{autoLabel}<Icon.ChevronRight size={16} /></span></button>}
              </>
            )}
            {menu === 'speed' && (
              <>
                <button type="button" className="flex w-full items-center gap-2 rounded-xl px-2 py-2 font-semibold hover:bg-white/10" onClick={() => setMenu('main')}><Icon.ChevronLeft size={18} />Speed</button>
                <div className="grid grid-cols-4 gap-1.5 p-1.5">
                  {SPEEDS.map((sp) => <button key={sp} type="button" role="menuitemradio" aria-checked={speed === sp} className={`rounded-xl py-2.5 text-[13px] font-semibold ${speed === sp ? 'bg-[#2bb5ab] text-[#04201e]' : 'bg-white/10 hover:bg-white/20'}`} onClick={() => { setRate(sp); setMenu(null); }}>{sp === 1 ? '1×' : `${sp}×`}</button>)}
                </div>
              </>
            )}
            {menu === 'quality' && (
              <>
                <button type="button" className="flex w-full items-center gap-2 rounded-xl px-2 py-2 font-semibold hover:bg-white/10" onClick={() => setMenu('main')}><Icon.ChevronLeft size={18} />Quality</button>
                <button type="button" role="menuitemradio" aria-checked={level === -1} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/10" onClick={() => chooseLevel(-1)}><span className="w-4">{level === -1 && <Icon.Check size={16} />}</span>Auto{playingLevel ? <span className="text-white/60">({playingLevel}p)</span> : null}</button>
                {levels.map((l) => <button key={l.index} type="button" role="menuitemradio" aria-checked={level === l.index} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/10" onClick={() => chooseLevel(l.index)}><span className="w-4">{level === l.index && <Icon.Check size={16} />}</span>{l.label}{Math.min(l.height, l.width) >= 720 && <span className="rounded bg-[#f5b95c] px-1 text-[10px] font-bold text-[#10201f]">HD</span>}</button>)}
              </>
            )}
          </div>
        )}
        <div className="flex h-14 items-center gap-1.5 rounded-[20px] border border-white/10 bg-[rgb(16_32_31/0.72)] pl-2 pr-1.5 text-white shadow-[0_8px_30px_rgb(0_0_0/0.35)] backdrop-blur-md">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause (k)' : 'Play (k)'} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#2bb5ab] text-[#04201e] transition-transform hover:scale-105">{playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}</button>
          <span className="w-11 shrink-0 text-right text-[12px] font-semibold tabular-nums">{fmt(time)}</span>
          {/* Seek track */}
          <div className="group/bar relative mx-1.5 flex h-8 min-w-0 flex-1 cursor-pointer items-center" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)} aria-valuetext={`${fmt(time)} of ${fmt(duration)}`} tabIndex={0}
            onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ x: e.clientX - r.left, t: ((e.clientX - r.left) / r.width) * duration }); }}
            onMouseLeave={() => setHover(null)}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * duration); }}>
            <div className="relative h-1.5 w-full rounded-full bg-white/20 transition-[height] group-hover/bar:h-2">
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: pct(buffered) }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-[#f5b95c]" style={{ width: pct(time) }} />
              <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgb(245_185_92/0.35)] transition-transform group-hover/bar:scale-110" style={{ left: pct(time) }} />
            </div>
            {hover && <span className="absolute -top-9 -translate-x-1/2 rounded-lg bg-[rgb(16_32_31/0.92)] px-2 py-1 text-[12px] font-semibold tabular-nums text-white" style={{ left: Math.max(22, hover.x) }}>{fmt(hover.t)}</span>}
          </div>
          <span className="w-11 shrink-0 text-[12px] font-semibold tabular-nums text-white/60">{fmt(duration)}</span>
          <div className="group/vol relative hidden items-center sm:flex">
            <button type="button" className={btn} onClick={() => setVol(volume || 1, !muted)} aria-label={muted ? 'Unmute (m)' : 'Mute (m)'}><VolIcon size={20} /></button>
            <div className="pointer-events-none absolute bottom-12 left-1/2 flex h-32 w-10 -translate-x-1/2 items-center justify-center rounded-2xl bg-[rgb(16_32_31/0.92)] opacity-0 transition-opacity group-hover/vol:pointer-events-auto group-hover/vol:opacity-100 group-focus-within/vol:pointer-events-auto group-focus-within/vol:opacity-100">
              <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => setVol(Number(e.target.value))} aria-label="Volume" className="w-24 -rotate-90 accent-[#f5b95c]" />
            </div>
          </div>
          <button type="button" className={`${btn} sm:hidden`} onClick={() => setVol(volume || 1, !muted)} aria-label={muted ? 'Unmute' : 'Mute'}><VolIcon size={20} /></button>
          <button type="button" onClick={() => setMenu(menu ? null : 'main')} aria-label="Speed and quality" aria-expanded={menu !== null} className="hidden h-8 shrink-0 items-center rounded-lg bg-white/10 px-2 text-[12px] font-semibold hover:bg-white/20 sm:flex">{level === -1 ? (playingLevel ? `${playingLevel}p` : 'Auto') : autoLabel}{speed !== 1 && ` · ${speed}×`}</button>
          <button type="button" onClick={() => setMenu(menu ? null : 'main')} aria-label="Settings" className={`${btn} sm:hidden`}><Icon.Settings size={19} /></button>
          <button type="button" className={`${btn} hidden sm:grid`} onClick={pip} aria-label="Picture in picture"><Icon.MiniPlayer size={19} /></button>
          {onTheater && !full && <button type="button" className={`${btn} hidden lg:grid`} onClick={onTheater} aria-label={theater ? 'Default view (t)' : 'Wide view (t)'}><Icon.Theater size={20} filled={theater} /></button>}
          <button type="button" className={btn} onClick={fullscreen} aria-label={full ? 'Exit full screen (f)' : 'Full screen (f)'}>{full ? <Icon.ExitFullscreen size={19} /> : <Icon.Fullscreen size={19} />}</button>
        </div>
      </div>
    </div>
  );
}
