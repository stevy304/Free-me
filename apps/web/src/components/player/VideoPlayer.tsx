'use client';

import * as Icon from '@/components/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { languageName } from '@free-me/shared';
import { AdBreak, type AdSlot } from './AdBreak';
import { DATA_SAVER_MAX, dataSaverActive } from '@/lib/datasaver';
import { av1Preferred, codecFamily } from '@/lib/codecs';
import { QoeSession } from '@/lib/qoe';

export interface CaptionTrack { language: string; auto: boolean; url: string }

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
 * fullscreen, captions and the usual keyboard shortcuts (k/space, j/l, arrows, m, f, t, c, 0-9, <, >). A view is reported once,
 * after real watching (30 s, or half of a short video). `startAt` resumes where the viewer stopped; `onProgress` is
 * called every 10 seconds of playback, on pause, at the end and when the page is left, to remember the position.
 */
/** How long autoplay waits to learn whether an ad plays first. */
const ADS_WAIT_MS = 1500;

export function VideoPlayer({ src, poster, videoId, durationHint, autoPlay = true, theater, onTheater, onEnded, startAt = 0, onProgress, onPlayingChange, storyboard, captions = [], withAds = false }: {
  src: string; poster?: string | null; videoId?: string; durationHint?: number; autoPlay?: boolean; theater?: boolean; onTheater?: () => void; onEnded?: () => void;
  startAt?: number; onProgress?: (seconds: number, ended: boolean) => void; onPlayingChange?: (playing: boolean) => void;
  /** WebVTT of seek-bar previews (cues point into a sprite sheet with #xywh). */
  storyboard?: string | null;
  /** Subtitle tracks (WebVTT), drawn by the player above its controls. */
  captions?: CaptionTrack[];
  /** Play ads from monetised creators' campaigns (the watch page; at most two per video). */
  withAds?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const firstPlay = useRef<{ started: number | null; measured: boolean }>({ started: null, measured: false });
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [offline, setOffline] = useState(false);
  const [slow, setSlow] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [reload, setReload] = useState(0);
  const retryQuality = useRef<number | null>(null);
  const interrupted = useRef<{ t: number; auto: boolean } | null>(null);
  const wantsPlayback = useRef(false);
  const frame = useRef<number | null>(null);
  const bufferingSince = useRef<number | null>(null);
  const recoverySince = useRef<number | null>(null);
  // This playback's experience (lib/qoe.ts): sent when the viewer leaves the video or the page.
  const qoe = useRef<QoeSession | null>(null);
  const reportHealth = (kind: 'startup' | 'buffer' | 'recovery', ms: number) => {
    if (!videoId || !Number.isFinite(ms) || ms < 0 || ms > 86_400_000) return;
    if (kind === 'startup') qoe.current?.startup(ms); else qoe.current?.stall(ms);
    void fetch(`/api/videos/${videoId}/playback-health`, {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, durationMs: Math.round(ms) }),
    }).catch(() => undefined);
  };
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1); // -1 = auto
  // Data saver caps "Auto" at 360p; "Sound only" plays the shared audio rendition alone (a fraction of the data).
  const [saver, setSaver] = useState(false);
  const [audio, setAudio] = useState<{ for: string; url: string } | null>(null);
  const [soundOnly, setSoundOnly] = useState(false);
  const resumeAt = useRef<{ t: number; play: boolean } | null>(null);
  useEffect(() => {
    setSoundOnly(false);
    setAudio(null);
    resumeAt.current = null;
    reported.current = false; playTicket.current = null;
    unsent.current = 0;
    watched.current = 0;
    lastT.current = 0;
  }, [src]);
  const playSrc = soundOnly && audio?.for === src ? audio.url : src;
  const [playingLevel, setPlayingLevel] = useState<number | null>(null);
  const [menu, setMenu] = useState<null | 'main' | 'quality' | 'speed' | 'captions'>(null);
  const { cc, chooseCc, cueText } = useCaptions(video, captions);
  const [ccStyle, setCcStyle] = useCaptionStyle();
  const [idle, setIdle] = useState(false);
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number; w: number } | null>(null);
  const dragging = useRef(false);
  const cues = useStoryboard(storyboard);
  const [flash, setFlash] = useState<'play' | 'pause' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!videoId) return;
    const session = new QoeSession(videoId);
    qoe.current = session;
    const leave = () => { if (document.visibilityState === 'hidden') session.send(); };
    const hide = () => session.send();
    document.addEventListener('visibilitychange', leave);
    window.addEventListener('pagehide', hide);
    return () => { document.removeEventListener('visibilitychange', leave); window.removeEventListener('pagehide', hide); session.send(); if (qoe.current === session) qoe.current = null; };
  }, [videoId, src]);
  useEffect(() => { if (error) qoe.current?.failed(); }, [error]);
  const watched = useRef(0);
  const reported = useRef(false);
  /** The play ticket for the current video (asked for when playback really starts). */
  const playTicket = useRef<Promise<string | null> | null>(null);
  // Watch time after the view was counted, not yet reported (sent with each progress save: every 30 s while playing,
  // on pause, leave and end). The server checks it against real time.
  const unsent = useRef(0);
  const videoIdRef = useRef(videoId);
  videoIdRef.current = videoId;
  const beat = useCallback(() => {
    const s = Math.floor(unsent.current);
    if (!reported.current || s < 1 || !videoIdRef.current) return;
    unsent.current -= s;
    fetch(`/api/videos/${videoIdRef.current}/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: s }), credentials: 'same-origin', keepalive: true }).catch(() => undefined);
  }, []);
  const lastT = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(0);
  // Ads: the slots for this video, which have played, and the one playing now (the video waits under it).
  const [adSlots, setAdSlots] = useState<AdSlot[]>([]);
  const [ad, setAd] = useState<AdSlot | null>(null);
  const adsPlayed = useRef(new Set<number>());
  // Autoplay waits for this: the ad before the video (if any) plays first, so the video never flashes on before it.
  // Never more than ADS_WAIT_MS, so a slow answer costs a moment, not the start.
  const adsReady = useRef<Promise<void>>(Promise.resolve());
  const preRoll = useRef(false);
  useEffect(() => {
    setAdSlots([]); setAd(null); adsPlayed.current = new Set(); preRoll.current = false;
    if (!withAds || !videoId) { adsReady.current = Promise.resolve(); return; }
    let off = false;
    const fetched = fetch(`/api/videos/${videoId}/ads`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { slots: [] })).then((j: { slots: AdSlot[] }) => {
      if (off || !j.slots?.length) return;
      setAdSlots(j.slots);
      const pre = j.slots.find((x) => x.at === 0);
      if (pre && (video.current?.currentTime ?? 0) < 3 && !(startAt > 0)) { video.current?.pause(); adsPlayed.current.add(0); preRoll.current = true; setAd(pre); }
      else if (pre) adsPlayed.current.add(0); // resuming part-way: no ad before
    }).catch(() => undefined);
    adsReady.current = Promise.race([fetched, new Promise<void>((done) => setTimeout(done, ADS_WAIT_MS))]);
    return () => { off = true; };
  }, [videoId, withAds]); // eslint-disable-line react-hooks/exhaustive-deps
  const adDone = () => { preRoll.current = false; setAd(null); video.current?.play().catch(() => undefined); };
  useEffect(() => { onPlayingChange?.(playing); }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const save = useCallback((ended = false) => {
    lastSaved.current = Date.now();
    beat();
    const el = video.current;
    if (!el || !progressRef.current || el.currentTime < 1) return;
    progressRef.current(Math.floor(el.currentTime), ended);
  }, [beat]);

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
    const vis = () => { if (document.visibilityState === 'hidden') { bufferingSince.current = null; save(); } };
    window.addEventListener('pagehide', leave); document.addEventListener('visibilitychange', vis);
    return () => { save(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', vis); };
  }, [src, save]);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('offline', update);
    window.addEventListener('online', update);
    return () => {
      window.removeEventListener('offline', update);
      window.removeEventListener('online', update);
    };
  }, []);

  useEffect(() => {
    if (!waiting || !playing || ad) return;
    const timer = setTimeout(() => setSlow(true), 2200);
    return () => { clearTimeout(timer); setSlow(false); };
  }, [waiting, playing, ad]);

  const retry = useCallback((play: boolean) => {
    const el = video.current;
    if (!el || !navigator.onLine || ad || preRoll.current) return;
    retryQuality.current = hls.current?.manualLevel ?? null;
    resumeAt.current = { t: interrupted.current?.t ?? el.currentTime, play };
    setNetworkError(false);
    setWaiting(play);
    setReload((n) => n + 1);
  }, [ad]);

  // A fatal error while offline is recoverable when the browser reports a connection again.
  useEffect(() => {
    if (offline || !networkError || !interrupted.current?.auto || ad) return;
    interrupted.current.auto = false;
    retry(true);
  }, [offline, networkError, ad, retry]);

  const failNetwork = () => {
    const el = video.current;
    if (!el || interrupted.current) return;
    // Some native players pause themselves on a network error before reporting it.
    recoverySince.current ??= performance.now();
    interrupted.current = { t: el.currentTime || lastT.current, auto: !navigator.onLine && wantsPlayback.current };
    setTime(interrupted.current.t);
    setNetworkError(true);
    setWaiting(false);
  };

  useEffect(() => {
    firstPlay.current = { started: null, measured: false };
    bufferingSince.current = null;
    recoverySince.current = null;
  }, [playSrc]);

  // Source: native HLS on Safari/iOS, hls.js elsewhere.
  useEffect(() => {
    const el = video.current!;
    const url = playSrc;
    const back = resumeAt.current; resumeAt.current = null;
    const quality = retryQuality.current; retryQuality.current = null;
    const savedSpeed = Number(store.get('fm_speed') ?? '1');
    const playbackRate = SPEEDS.includes(savedSpeed) ? savedSpeed : 1;
    const restore = () => {
      el.playbackRate = playbackRate;
      setSpeed(playbackRate);
      if (!back) return;
      el.currentTime = back.t;
      if (back.play) void el.play().catch(() => undefined);
    };
    el.addEventListener('loadedmetadata', restore, { once: true });
    interrupted.current = null;
    wantsPlayback.current = false;
    setNetworkError(false);
    setError(null); setLevels([]); setLevel(-1);
    const v = Number(store.get('fm_volume') ?? '1'); const m = store.get('fm_muted') === '1';
    el.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; el.muted = m; setVolume(el.volume); setMuted(m);
    let cancelled = false;
    const start = () => {
      if (cancelled || preRoll.current) return;
      firstPlay.current.started ??= performance.now();
      el.play().catch(() => {
        if (cancelled) return;
        el.muted = true;
        setMuted(true);
        void el.play().catch(() => undefined);
      });
    };
    const autoplay = () => {
      if (back || !autoPlay) return;
      if (withAds) void adsReady.current.then(start);
      else start();
    };
    if (el.canPlayType('application/vnd.apple.mpegurl') && !/Chrome|Firefox|Edg/.test(navigator.userAgent)) {
      el.src = url;
      qoe.current?.setCodec('native');
      autoplay();
    } else {
      Promise.all([import('hls.js'), av1Preferred()]).then(([{ default: H }, av1]) => {
        if (cancelled) return;
        if (!H.isSupported()) { setError('This browser cannot play this video.'); return; }
        // Popular videos also come in AV1 (fewer bytes). hls.js keeps to one codec for the whole playback; this says
        // which one when both are there. A device that cannot decode one never sees it (hls.js drops those).
        const family = av1 ? 'av01' : 'avc1';
        // startFragPrefetch: the first segment downloads while the player is still setting up.
        const h = new H({ capLevelToPlayerSize: true, startLevel: -1, startFragPrefetch: true, maxBufferLength: 30, backBufferLength: 60, videoPreference: { videoCodec: family } });
        hls.current = h;
        h.on(H.Events.MANIFEST_PARSED, () => {
          autoplay();
          // The quality menu and data saver work on the chosen codec's renditions only (each quality is listed once).
          const pool = h.levels.map((l, index) => ({ l, index })).filter(({ l }) => codecFamily(l.codecSet) === family);
          const usable = pool.length ? pool : h.levels.map((l, index) => ({ l, index }));
          setLevels(usable.map(({ l, index }) => ({ index, height: l.height, width: l.width, label: label(l.height, l.width) })).reverse());
          const track = h.audioTracks[0];
          if (track?.url && url === src) setAudio({ for: src, url: track.url });
          // Data saver: "Auto" stays at 360p or below (the viewer can still pick a higher quality).
          const cap = usable.reduce((best, { l, index: i }) => (Math.min(l.width, l.height) <= DATA_SAVER_MAX && (best < 0 || l.height * l.width > h.levels[best].height * h.levels[best].width) ? i : best), -1);
          const top = usable.reduce((a, b) => (b.l.height * b.l.width > a.l.height * a.l.width ? b : a)).index;
          const on = dataSaverActive() && cap >= 0 && cap !== top;
          setSaver(on);
          if (on) { h.autoLevelCapping = cap; h.nextLoadLevel = Math.min(h.nextLoadLevel, cap); }
          if (quality !== null && quality >= 0 && quality < h.levels.length) {
            h.autoLevelCapping = -1;
            h.loadLevel = quality;
            setLevel(quality);
            setSaver(false);
          }
        });
        h.on(H.Events.LEVEL_SWITCHED, (_e, d) => {
          const l = h.levels[d.level]; setPlayingLevel(l ? Math.min(l.height, l.width) : null);
          const f = codecFamily(l?.codecSet);
          qoe.current?.setCodec(f === 'av01' ? 'av1' : f === 'avc1' ? 'h264' : 'other');
        });
        let recoveries = 0;
        h.on(H.Events.ERROR, (_e, d) => {
          if (d.details === H.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) { setError('This browser cannot play H.264 video. Open the video in Chrome, Edge, Safari or Firefox.'); setWaiting(false); return; }
          if (!d.fatal) return;
          if (d.type === H.ErrorTypes.NETWORK_ERROR) {
            if (navigator.onLine && recoveries++ < 3) h.startLoad();
            else failNetwork();
          }
          else if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries++ < 3) h.recoverMediaError();
          else { setError('This video cannot be played right now. Check your connection and try again.'); setWaiting(false); }
        });
        h.loadSource(url); h.attachMedia(el);
      });
    }
    return () => {
      cancelled = true;
      el.removeEventListener('loadedmetadata', restore);
      if (frame.current !== null) el.cancelVideoFrameCallback?.(frame.current);
      frame.current = null;
      hls.current?.destroy(); hls.current = null; el.removeAttribute('src'); el.load();
    };
  }, [playSrc, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(() => {
    const el = video.current!;
    if (el.paused || el.ended) {
      firstPlay.current.started ??= performance.now();
      el.play().catch(() => undefined);
      setFlash('play');
    } else {
      if (interrupted.current) interrupted.current.auto = false;
      wantsPlayback.current = false;
      el.pause();
      setFlash('pause');
    }
    setTimeout(() => setFlash(null), 500);
  }, []);
  const seek = useCallback((t: number) => { const el = video.current!; el.currentTime = Math.max(0, Math.min((el.duration || duration) - 0.05, t)); }, [duration]);
  const setVol = (v: number, m = v === 0) => { const el = video.current!; el.volume = v; el.muted = m; setVolume(v); setMuted(m); store.set('fm_volume', String(v)); store.set('fm_muted', m ? '1' : '0'); };
  const setRate = (s: number) => { video.current!.playbackRate = s; setSpeed(s); store.set('fm_speed', String(s)); };
  const chooseLevel = (i: number) => {
    if (hls.current) { if (i >= 0) hls.current.autoLevelCapping = -1; hls.current.currentLevel = i; hls.current.loadLevel = i; }
    if (i >= 0) setSaver(false);
    setLevel(i); setMenu(null);
  };
  const toggleSoundOnly = () => {
    const el = video.current!;
    resumeAt.current = { t: el.currentTime, play: !el.paused };
    setSoundOnly((v) => !v); setMenu(null);
  };
  // Phones: a tap shows or hides the controls (it does not pause); a double tap on the left or right third skips 10 s.
  const lastTap = useRef<{ t: number; x: number } | null>(null);
  const [skip, setSkip] = useState<null | 'back' | 'fwd'>(null);
  const onTap = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const now = Date.now();
    if (lastTap.current && now - lastTap.current.t < 300 && (x < 0.35 || x > 0.65)) {
      const el = video.current!;
      el.currentTime = Math.max(0, Math.min((el.duration || duration) - 0.1, el.currentTime + (x < 0.5 ? -10 : 10)));
      setSkip(x < 0.5 ? 'back' : 'fwd'); setTimeout(() => setSkip(null), 550);
      lastTap.current = null; poke(); return;
    }
    lastTap.current = { t: now, x };
    if (idle || !playing) poke(); else { setIdle(true); setMenu(null); }
  };
  const fullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void box.current?.requestFullscreen?.(); };
  const pip = async () => { const el = video.current!; try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture(); } catch { /* not allowed */ } };

  const poke = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { if (!video.current?.paused) { setIdle(true); setMenu(null); } }, 2500);
  }, []);

  const adRef = useRef<AdSlot | null>(null); adRef.current = ad;
  // Keyboard shortcuts while the page (not a text field) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = video.current; if (!el || adRef.current) return;
      const k = (e.key ?? '').toLowerCase();
      const handled = () => { e.preventDefault(); poke(); };
      if (k === ' ' && t.closest('button')) return;
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
      else if (k === 'c' && captions.length) { handled(); chooseCc(cc ? null : 'last'); }
      else if (/^[0-9]$/.test(k)) { handled(); seek(((el.duration || duration) * Number(k)) / 10); }
      else if (e.key === '>' ) { handled(); setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]); }
      else if (e.key === '<') { handled(); setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seek, poke, onTheater, duration, speed, cc, captions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const f = () => setFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);

  const onTime = () => {
    const el = video.current!;
    setTime(el.currentTime);
    const mid = adSlots.find((x) => x.at > 0 && !adsPlayed.current.has(x.at) && el.currentTime >= x.at && el.currentTime < x.at + 5);
    if (mid && !ad && !el.paused) { adsPlayed.current.add(mid.at); el.pause(); setAd(mid); return; }
    if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
    const delta = el.currentTime - lastT.current;
    if (!el.paused && delta > 0 && delta < 2) {
      // Playback really started: ask for the play ticket the view needs (checked against the server's clock).
      if (videoId && !playTicket.current) playTicket.current = fetch(`/api/videos/${videoId}/play`, { method: 'POST', credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.ticket ?? null).catch(() => null);
      watched.current += delta; if (reported.current) unsent.current += delta;
      if (!ad) qoe.current?.watched(delta, Math.min(el.videoWidth, el.videoHeight) || 0);
    }
    lastT.current = el.currentTime;
    if (!el.paused && Date.now() - lastSaved.current > 30_000) save(); // every 30 s while playing (and on pause, leave and end)
    const need = Math.min(30, (el.duration || duration) * 0.5);
    if (videoId && !reported.current && need > 0 && watched.current >= need) {
      reported.current = true;
      const seconds = Math.round(watched.current);
      void (playTicket.current ?? Promise.resolve(null)).then((ticket) => fetch(`/api/videos/${videoId}/views`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: seconds, ...(ticket ? { ticket } : {}) }), credentials: 'same-origin' })).catch(() => undefined);
    }
  };

  const pct = (n: number) => `${duration ? Math.min(100, (n / duration) * 100) : 0}%`;
  const VolIcon = muted || volume === 0 ? Icon.VolumeOff : volume < 0.5 ? Icon.VolumeLow : Icon.VolumeHigh;
  const autoLabel = soundOnly ? 'Sound only' : level === -1 ? `Auto${saver ? ' · data saver' : ''}${playingLevel ? ` (${playingLevel}p)` : ''}` : levels.find((l) => l.index === level)?.label ?? 'Auto';
  const btn = 'grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white hover:bg-white/10';
  const recoveryCard = !ad && !error && (networkError || (waiting && playing && (offline || slow)));
  const showUi = !playing || !idle || menu !== null || recoveryCard;

  return (
    <div ref={box} onMouseMove={poke} onMouseLeave={() => playing && setIdle(true)}
      className={`group relative aspect-video w-full select-none overflow-hidden bg-black ${full ? '' : 'sm:rounded-[24px]'} ${showUi ? '' : 'cursor-none'}`}>
      <video ref={video} playsInline poster={poster ?? undefined} className="h-full w-full" onPointerUp={onTap} onClick={(e) => { if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return; toggle(); }} onDoubleClick={(e) => { if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return; fullscreen(); }}
        onPlay={() => {
          wantsPlayback.current = true;
          firstPlay.current.started ??= performance.now();
          setPlaying(true);
        }} onPause={() => {
          bufferingSince.current = null;
          if (navigator.onLine && !video.current?.error) wantsPlayback.current = false;
          if (frame.current !== null) video.current?.cancelVideoFrameCallback?.(frame.current);
          frame.current = null;
          if (!firstPlay.current.measured) firstPlay.current.started = null;
          setPlaying(false); save();
        }} onWaiting={(e) => {
          setWaiting(true);
          if (firstPlay.current.measured && !e.currentTarget.paused && !e.currentTarget.seeking && !ad && document.visibilityState === 'visible') {
            bufferingSince.current ??= performance.now();
          }
        }} onSeeking={() => { bufferingSince.current = null; }} onPlaying={() => {
          const now = performance.now();
          if (recoverySince.current !== null) {
            reportHealth('recovery', now - recoverySince.current);
            recoverySince.current = null;
            bufferingSince.current = null;
          } else if (bufferingSince.current !== null) {
            reportHealth('buffer', now - bufferingSince.current);
            bufferingSince.current = null;
          }
          interrupted.current = null;
          setNetworkError(false);
          setWaiting(false);
          const { started, measured } = firstPlay.current;
          if (started === null || measured || frame.current !== null) return;
          performance.measure('free-me:play-to-playing', { start: started });
          const el = video.current;
          if (el?.requestVideoFrameCallback && !soundOnly) {
            frame.current = el.requestVideoFrameCallback((now) => {
              frame.current = null;
              performance.measure('free-me:play-to-first-frame', { start: started, end: now });
              reportHealth('startup', now - started);
              firstPlay.current.measured = true;
            });
          } else firstPlay.current.measured = true;
        }} onCanPlay={() => setWaiting(false)}
        onError={(e) => { if (!hls.current && e.currentTarget.error?.code === 2) failNetwork(); }}
        onTimeUpdate={onTime} onDurationChange={(e) => setDuration(e.currentTarget.duration)} onEnded={() => { setPlaying(false); save(true); onEnded?.(); }}
        onVolumeChange={(e) => { setMuted(e.currentTarget.muted); setVolume(e.currentTarget.volume); }}>
        {captions.map((c) => <track key={c.language} kind="subtitles" src={c.url} srcLang={c.language} label={captionLabel(c)} />)}
      </video>
      {/* Captions: drawn here (not by the browser) so they sit above the floating controls and match the design. */}
      {cueText && (
        <div className={`pointer-events-none absolute inset-x-0 flex justify-center px-3 transition-[bottom] duration-200 ${showUi ? 'bottom-[60px] sm:bottom-[84px]' : 'bottom-3 sm:bottom-8'}`}>
          <span className={`max-w-[88%] whitespace-pre-line rounded-lg px-2.5 py-1 text-center font-semibold leading-snug sm:max-w-[72%] sm:px-3.5 sm:py-1.5 ${CC_SIZE[ccStyle.size]} ${CC_BG[ccStyle.bg]} ${CC_COLOR[ccStyle.color]}`}>{cueText}</span>
        </div>
      )}
      {soundOnly && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40 blur-sm" />}
          <span className="relative rounded-full bg-black/60 px-4 py-2 text-[14px] font-semibold text-white">Sound only · saving data</span>
        </div>
      )}
      {ad && videoId && <AdBreak slot={ad} videoId={videoId} muted={muted} onDone={adDone} />}
      {waiting && !error && !ad && !recoveryCard && <Icon.Spinner className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/90" />}
      {flash && <div className="pointer-events-none absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 animate-ping place-items-center rounded-full bg-[rgb(43_181_171/0.6)] text-white [animation-iteration-count:1]">{flash === 'play' ? <Icon.Play size={30} /> : <Icon.Pause size={30} />}</div>}
      {!playing && !waiting && !error && !recoveryCard && showUi && (
        <button type="button" onClick={toggle} aria-label="Play" className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[rgb(16_32_31/0.6)] text-white backdrop-blur sm:hidden"><Icon.Play size={30} /></button>
      )}
      {playing && showUi && !menu && !error && !waiting && !recoveryCard && (
        <button type="button" onClick={toggle} aria-label="Pause" className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[rgb(16_32_31/0.6)] text-white backdrop-blur sm:hidden"><Icon.Pause size={28} /></button>
      )}
      {skip && <div className={`pointer-events-none absolute top-0 grid h-full w-1/3 place-items-center bg-white/10 text-[13px] font-semibold text-white ${skip === 'back' ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'}`}>{skip === 'back' ? '« 10 s' : '10 s »'}</div>}
      {recoveryCard && (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center sm:inset-x-6 sm:top-6">
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl border border-[#72e6d4]/30 bg-[#0b2423]/95 px-3 py-2 text-white shadow-xl backdrop-blur sm:gap-3 sm:px-4">
            <Icon.Play size={16} className="shrink-0 text-[#72e6d4]" />
            <div role="status" className="min-w-0">
              <p className="text-xs font-bold sm:text-sm">{offline ? 'Waiting for connection' : networkError ? 'Playback interrupted' : 'Buffering video'}</p>
              <p className="text-[11px] text-[#bfe0dc] sm:text-xs">Your place · {fmt(time)}</p>
            </div>
            {!offline && (networkError || soundOnly || audio?.for !== src) && <button type="button" onClick={() => retry(true)} className="shrink-0 rounded-full bg-[#72e6d4] px-3 py-1.5 text-xs font-bold text-[#04201e]">Resume here</button>}
            {!offline && !networkError && !soundOnly && audio?.for === src && <button type="button" onClick={toggleSoundOnly} className="shrink-0 rounded-full border border-[#72e6d4]/40 px-2.5 py-1.5 text-xs font-bold">Sound only</button>}
          </div>
        </div>
      )}
      {error && <div className="absolute inset-0 grid place-items-center bg-black/80 px-6 text-center text-[15px] text-white">{error}</div>}

      {/* Controls: a floating capsule above the bottom edge, not a bar across it. */}
      <div className={`absolute inset-x-1.5 bottom-1.5 transition-all duration-200 sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:w-[min(92%,860px)] sm:-translate-x-1/2 ${showUi ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}>
        {menu && (
          <div className="absolute bottom-[68px] right-0 w-[min(100%,300px)] overflow-hidden rounded-2xl border border-white/10 bg-[rgb(16_32_31/0.92)] p-2 text-[14px] text-white shadow-2xl backdrop-blur-md" role="menu">
            {menu === 'main' && (
              <>
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/50">Playback</p>
                <button type="button" className="flex w-full items-center justify-between rounded-xl px-3 py-3 hover:bg-white/10" onClick={() => setMenu('speed')}><span>Speed</span><span className="flex items-center gap-1 text-white/70">{speed === 1 ? 'Normal' : `${speed}×`}<Icon.ChevronRight size={16} /></span></button>
                {levels.length > 0 && <button type="button" className="flex w-full items-center justify-between rounded-xl px-3 py-3 hover:bg-white/10" onClick={() => setMenu('quality')}><span>Quality</span><span className="flex items-center gap-1 text-white/70">{autoLabel}<Icon.ChevronRight size={16} /></span></button>}
                {audio?.for === src && <button type="button" role="menuitemcheckbox" aria-checked={soundOnly} className="flex w-full items-center justify-between rounded-xl px-3 py-3 hover:bg-white/10" onClick={toggleSoundOnly}><span>Sound only</span><span className="text-white/70">{soundOnly ? 'On · saves data' : 'Off'}</span></button>}
                {captions.length > 0 && <button type="button" className="flex w-full items-center justify-between rounded-xl px-3 py-3 hover:bg-white/10" onClick={() => setMenu('captions')}><span>Subtitles</span><span className="flex items-center gap-1 text-white/70">{cc ? captionLabel(captions.find((c) => c.language === cc)!) : 'Off'}<Icon.ChevronRight size={16} /></span></button>}
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
            {menu === 'captions' && (
              <>
                <button type="button" className="flex w-full items-center gap-2 rounded-xl px-2 py-2 font-semibold hover:bg-white/10" onClick={() => setMenu('main')}><Icon.ChevronLeft size={18} />Subtitles</button>
                <button type="button" role="menuitemradio" aria-checked={!cc} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/10" onClick={() => { chooseCc(null); setMenu(null); }}><span className="w-4">{!cc && <Icon.Check size={16} />}</span>Off</button>
                {captions.map((c) => <button key={c.language} type="button" role="menuitemradio" aria-checked={cc === c.language} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/10" onClick={() => { chooseCc(c.language); setMenu(null); }}><span className="w-4">{cc === c.language && <Icon.Check size={16} />}</span>{captionLabel(c)}</button>)}
                <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/50">Caption style</p>
                <div className="space-y-2 px-2 pb-1">
                  <div role="radiogroup" aria-label="Text size" className="grid grid-cols-4 gap-1.5">
                    {(['s', 'm', 'l', 'xl'] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={ccStyle.size === v} onClick={() => setCcStyle({ size: v })} className={`rounded-xl py-2 font-semibold ${ccStyle.size === v ? 'bg-[#2bb5ab] text-[#04201e]' : 'bg-white/10 hover:bg-white/20'}`} style={{ fontSize: { s: 11, m: 13, l: 15, xl: 17 }[v] }}>{v === 'xl' ? 'XL' : v.toUpperCase()}</button>)}
                  </div>
                  <div role="radiogroup" aria-label="Background" className="grid grid-cols-3 gap-1.5 text-[12px]">
                    {([['box', 'Box'], ['solid', 'Solid'], ['none', 'Outline']] as const).map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={ccStyle.bg === v} onClick={() => setCcStyle({ bg: v })} className={`rounded-xl py-2 font-semibold ${ccStyle.bg === v ? 'bg-[#2bb5ab] text-[#04201e]' : 'bg-white/10 hover:bg-white/20'}`}>{l}</button>)}
                  </div>
                  <div role="radiogroup" aria-label="Text colour" className="grid grid-cols-3 gap-1.5 text-[12px]">
                    {([['white', 'White'], ['yellow', 'Yellow'], ['cyan', 'Cyan']] as const).map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={ccStyle.color === v} onClick={() => setCcStyle({ color: v })} className={`rounded-xl py-2 font-semibold ${ccStyle.color === v ? 'bg-[#2bb5ab] text-[#04201e]' : 'bg-white/10 hover:bg-white/20'}`}>{l}</button>)}
                  </div>
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
        <div className="flex h-10 items-center gap-1 rounded-2xl border border-white/10 bg-[rgb(16_32_31/0.72)] pl-1.5 pr-1 sm:h-14 sm:gap-1.5 sm:rounded-[20px] sm:pl-2 sm:pr-1.5 text-white shadow-[0_8px_30px_rgb(0_0_0/0.35)] backdrop-blur-md">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause (k)' : 'Play (k)'} className="hidden h-10 w-10 shrink-0 place-items-center rounded-full bg-[#2bb5ab] text-[#04201e] transition-transform hover:scale-105 sm:grid">{playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}</button>
          <span className="w-10 shrink-0 text-right text-[11px] font-semibold tabular-nums sm:w-11 sm:text-[12px]">{fmt(time)}</span>
          {/* Seek track */}
          <div className="group/bar relative mx-1 flex h-8 sm:mx-1.5 min-w-0 flex-1 cursor-pointer items-center" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)} aria-valuetext={`${fmt(time)} of ${fmt(duration)}`} tabIndex={0}
            onPointerMove={(e) => {
              if (e.pointerType !== 'mouse' && !dragging.current) return;
              const r = e.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
              setHover({ x, t: (x / r.width) * duration, w: r.width });
            }}
            onPointerDown={(e) => {
              dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId);
              const r = e.currentTarget.getBoundingClientRect(); const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
              setHover({ x, t: (x / r.width) * duration, w: r.width }); poke();
            }}
            onPointerUp={(e) => {
              if (!dragging.current) return;
              dragging.current = false;
              const r = e.currentTarget.getBoundingClientRect(); seek((Math.max(0, Math.min(r.width, e.clientX - r.left)) / r.width) * duration);
              if (e.pointerType !== 'mouse') setHover(null);
            }}
            onPointerCancel={() => { dragging.current = false; setHover(null); }}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !dragging.current) setHover(null); }}>
            <div className="relative h-1.5 w-full rounded-full bg-white/20 transition-[height] group-hover/bar:h-2">
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: pct(buffered) }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-[#f5b95c]" style={{ width: pct(time) }} />
              <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgb(245_185_92/0.35)] transition-transform group-hover/bar:scale-110" style={{ left: pct(time) }} />
            </div>
            {hover && <SeekPreview hover={hover} cue={cueAt(cues, hover.t)} label={fmt(hover.t)} />}
          </div>
          <span className="w-10 shrink-0 text-[11px] font-semibold tabular-nums text-white/60 sm:w-11 sm:text-[12px]">{fmt(duration)}</span>
          <div className="group/vol relative hidden items-center sm:flex">
            <button type="button" className={btn} onClick={() => setVol(volume || 1, !muted)} aria-label={muted ? 'Unmute (m)' : 'Mute (m)'}><VolIcon size={20} /></button>
            <div className="pointer-events-none absolute bottom-12 left-1/2 flex h-32 w-10 -translate-x-1/2 items-center justify-center rounded-2xl bg-[rgb(16_32_31/0.92)] opacity-0 transition-opacity group-hover/vol:pointer-events-auto group-hover/vol:opacity-100 group-focus-within/vol:pointer-events-auto group-focus-within/vol:opacity-100">
              <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => setVol(Number(e.target.value))} aria-label="Volume" className="w-24 -rotate-90 accent-[#f5b95c]" />
            </div>
          </div>
          <button type="button" className={`${btn} sm:hidden`} onClick={() => setVol(volume || 1, !muted)} aria-label={muted ? 'Unmute' : 'Mute'}><VolIcon size={20} /></button>
          {captions.length > 0 && <button type="button" onClick={() => chooseCc(cc ? null : 'last')} aria-label="Subtitles (c)" aria-pressed={!!cc} className={`grid h-8 shrink-0 place-items-center rounded-lg px-1.5 text-[11px] font-extrabold tracking-wide ${cc ? 'bg-white text-[#04201e]' : 'bg-white/10 text-white hover:bg-white/20'}`}>CC</button>}
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

interface Cue { start: number; end: number; url: string; x: number; y: number; w: number; h: number }

/** Loads the seek-bar preview track once: each cue is a time range and its tile on the sprite sheet. */
function useStoryboard(url?: string | null): Cue[] {
  const [cues, setCues] = useState<Cue[]>([]);
  useEffect(() => {
    setCues([]);
    if (!url) return;
    const ctrl = new AbortController();
    fetch(url, { credentials: 'same-origin', signal: ctrl.signal }).then((r) => (r.ok ? r.text() : '')).then((text) => {
      const sec = (t: string) => { const [h, m, s] = t.split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
      const out: Cue[] = [];
      for (const block of text.split(/\n\n+/)) {
        const m = /(\d+:\d{2}:\d{2}\.\d{3}) --> (\d+:\d{2}:\d{2}\.\d{3})\n(\S+)#xywh=(\d+),(\d+),(\d+),(\d+)/.exec(block);
        if (m) out.push({ start: sec(m[1]), end: sec(m[2]), url: m[3], x: +m[4], y: +m[5], w: +m[6], h: +m[7] });
      }
      setCues(out);
      if (out[0]) { const img = new Image(); img.src = out[0].url; } // warm the sheet so the first hover is instant
    }).catch(() => undefined);
    return () => ctrl.abort();
  }, [url]);
  return cues;
}

const cueAt = (cues: Cue[], t: number) => cues.find((c) => t >= c.start && t < c.end) ?? (cues.length && t >= cues[cues.length - 1].start ? cues[cues.length - 1] : null);

/** The frame (when there are previews) and the time above the pointer, kept inside the bar. */
function SeekPreview({ hover, cue, label }: { hover: { x: number; w: number }; cue: Cue | null; label: string }) {
  const half = cue ? cue.w / 2 + 2 : 22;
  const left = Math.max(half, Math.min(hover.w - half, hover.x));
  if (!cue) return <span className="pointer-events-none absolute -top-9 -translate-x-1/2 rounded-lg bg-[rgb(16_32_31/0.92)] px-2 py-1 text-[12px] font-semibold tabular-nums text-white" style={{ left }}>{label}</span>;
  return (
    <span className="pointer-events-none absolute bottom-9 -translate-x-1/2 overflow-hidden rounded-xl bg-[rgb(16_32_31/0.92)] shadow-[0_8px_24px_rgb(0_0_0/0.45)] ring-1 ring-[#2bb5ab]/60" style={{ left }}>
      <span className="block bg-no-repeat" style={{ width: cue.w, height: cue.h, backgroundImage: `url("${cue.url}")`, backgroundPosition: `-${cue.x}px -${cue.y}px` }} />
      <span className="block py-1 text-center text-[12px] font-semibold tabular-nums text-white">{label}</span>
    </span>
  );
}

/** How subtitles look, chosen by the viewer and remembered on this device. */
interface CaptionStyle { size: 's' | 'm' | 'l' | 'xl'; bg: 'box' | 'solid' | 'none'; color: 'white' | 'yellow' | 'cyan' }
const CC_DEFAULT: CaptionStyle = { size: 'm', bg: 'box', color: 'white' };
const CC_SIZE: Record<CaptionStyle['size'], string> = { s: 'text-[11px] sm:text-[15px]', m: 'text-[13px] sm:text-[19px]', l: 'text-[16px] sm:text-[24px]', xl: 'text-[19px] sm:text-[30px]' };
const CC_BG: Record<CaptionStyle['bg'], string> = { box: 'bg-[rgb(5_10_10/0.8)]', solid: 'bg-black', none: 'bg-transparent [text-shadow:0_0_3px_#000,0_0_3px_#000,0_1px_2px_#000]' };
const CC_COLOR: Record<CaptionStyle['color'], string> = { white: 'text-white', yellow: 'text-[#ffe14d]', cyan: 'text-[#7ff3ff]' };
function useCaptionStyle(): [CaptionStyle, (patch: Partial<CaptionStyle>) => void] {
  const [style, setStyle] = useState<CaptionStyle>(CC_DEFAULT);
  useEffect(() => { try { const saved = JSON.parse(store.get('fm_cc_style') ?? 'null'); if (saved) setStyle({ ...CC_DEFAULT, ...saved }); } catch { /* ignore a broken value */ } }, []);
  const update = useCallback((patch: Partial<CaptionStyle>) => setStyle((cur) => { const next = { ...cur, ...patch }; store.set('fm_cc_style', JSON.stringify(next)); return next; }), []);
  return [style, update];
}

const captionLabel = (c: CaptionTrack) => `${languageName(c.language)}${c.auto ? ' (automatic)' : ''}`;

/**
 * Which subtitle language is on (on by default when a video has captions; the viewer's choice, including off, is
 * remembered) and the text of the cue showing now. Tracks run "hidden" so the player draws the text itself.
 */
function useCaptions(video: React.RefObject<HTMLVideoElement | null>, captions: CaptionTrack[]) {
  const [cc, setCc] = useState<string | null>(null);
  const [cueText, setCueText] = useState('');
  const langs = captions.map((c) => c.language).join(',');
  useEffect(() => {
    // Captions show by default when a video has them; a viewer who turned them off keeps them off.
    const saved = store.get('fm_cc');
    if (saved === 'off' || !captions.length) { setCc(null); return; }
    const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : '';
    setCc(captions.find((c) => c.language === saved)?.language ?? captions.find((c) => c.language === nav)?.language ?? captions.find((c) => !c.auto)?.language ?? captions[0].language);
  }, [langs]); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseCc = useCallback((lang: string | null | 'last') => {
    if (lang === 'last') {
      const saved = store.get('fm_cc');
      const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : '';
      lang = captions.find((c) => c.language === saved)?.language ?? captions.find((c) => c.language === nav)?.language ?? captions[0]?.language ?? null;
    }
    setCc(lang);
    store.set('fm_cc', lang ?? 'off');
  }, [langs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = video.current;
    setCueText('');
    if (!el) return;
    let active: TextTrack | null = null;
    const onCue = () => {
      const list = active?.activeCues;
      const text = list ? Array.from(list).map((c) => (c as VTTCue).text.replace(/<[^>]+>/g, '')).join('\n') : '';
      setCueText(text);
    };
    const apply = () => {
      for (const t of Array.from(el.textTracks)) {
        const on = !!cc && t.language === cc;
        t.mode = on ? 'hidden' : 'disabled';
        if (on && active !== t) { active?.removeEventListener('cuechange', onCue); active = t; t.addEventListener('cuechange', onCue); }
      }
      onCue();
    };
    apply();
    el.textTracks.addEventListener('addtrack', apply);
    return () => { el.textTracks.removeEventListener('addtrack', apply); active?.removeEventListener('cuechange', onCue); };
  }, [cc, langs, video]);
  return { cc, chooseCc, cueText };
}

