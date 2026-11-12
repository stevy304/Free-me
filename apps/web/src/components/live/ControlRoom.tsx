'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as Icon from '@/components/icons';
import styles from './ControlRoom.module.css';
import desk from './StudioWorkspace.module.css';
import { Dialog } from '@/components/Dialog';
import { api } from '@/lib/client-api';
import { getSocket } from '@/lib/realtime';
import { guestPeer, type GuestSignal } from './guest-peer';
import { drawFrame, drawTransition, H, newTiming, syncTiming, W, type Inputs, type Timing, type Transition } from './studio/compose';
import { ANIMS, cloneGraphics, cloneScene, LAYOUTS, loadShow, LOOPS, readImage, saveShow, SOURCES, type Anim, type Corner, type Graphics, type Layout, type Loop, type LowerStyle, type SceneDef, type SourceId } from './studio/model';

type Guest = { id: string; stream: MediaStream | null; onAir: boolean };
type Cue = { id: number; name: string; sceneId: string; graphics: Graphics };
const button = 'rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-50';
const field = 'mt-1 w-full rounded-md border border-[#25424a] bg-[#0b2328] px-2 py-1.5 text-[13px] text-[#e9f4f6]';
const CORNERS: Array<{ id: Corner; label: string }> = [{ id: 'tl', label: 'Top left' }, { id: 'tr', label: 'Top right' }, { id: 'bl', label: 'Bottom left' }, { id: 'br', label: 'Bottom right' }];
const LOGO_PLACES: Array<{ id: Corner; label: string }> = [{ id: 'tl', label: 'Top left' }, { id: 'tc', label: 'Top centre' }, { id: 'tr', label: 'Top right' }, { id: 'bl', label: 'Bottom left' }, { id: 'bc', label: 'Bottom centre' }, { id: 'br', label: 'Bottom right' }];
const TRANSITIONS: Transition[] = ['cut', 'fade', 'slide', 'wipe'];

/** Whether a scene shows a source (so its sound is heard while that scene is on air). */
function uses(s: SceneDef, id: SourceId) {
  if (s.layout === 'card') return false;
  if (s.layout === 'grid') return id === 'camera' || id === 'guests';
  return s.main === id || (s.layout !== 'solo' && s.second === id);
}
/** RMS level (0–128 around the middle) → dBFS, floor −60. */
const toDb = (rms: number) => Math.max(-60, 20 * Math.log10(Math.max(rms, 1e-4) / 128));

/** A small drawing of a layout, for the layout buttons. */
function LayoutIcon({ layout }: { layout: Layout }) {
  const box = 'fill-current opacity-80';
  return (
    <svg viewBox="0 0 32 18" width={32} height={18} aria-hidden className="shrink-0 rounded-[3px] bg-black/40">
      {layout === 'solo' && <rect x="2" y="2" width="28" height="14" rx="1.5" className={box} />}
      {layout === 'pip' && <><rect x="2" y="2" width="28" height="14" rx="1.5" className={box} opacity=".45" /><rect x="19" y="9" width="10" height="6" rx="1" className={box} /></>}
      {layout === 'side' && <><rect x="2" y="3" width="13" height="12" rx="1.5" className={box} /><rect x="17" y="3" width="13" height="12" rx="1.5" className={box} /></>}
      {layout === 'grid' && <><rect x="3" y="2" width="12" height="6.5" rx="1" className={box} /><rect x="17" y="2" width="12" height="6.5" rx="1" className={box} /><rect x="3" y="9.5" width="12" height="6.5" rx="1" className={box} /><rect x="17" y="9.5" width="12" height="6.5" rx="1" className={box} /></>}
      {layout === 'card' && <><rect x="9" y="6" width="14" height="2.5" rx="1" className={box} /><rect x="12" y="10" width="8" height="1.6" rx=".8" className={box} /></>}
    </svg>
  );
}

/**
 * The control room: a preview (what goes next) and a program (what viewers see) composed on canvases, scenes with
 * layouts, graphics (logo, animated lower third, ticker, clock), transitions, an audio mixer, guests over WebRTC,
 * a rundown, and recording the program to this computer. `basic` is the free co-stream: one program, up to 2 guests.
 */
export function ControlRoom({ streamId, basic, host, capture, active, sources, chat, health, externalPreview, external = false, cameraOn = false, microphoneOn = false, deviceBusy = false, onCameraToggle, onMicrophoneToggle }: {
  streamId: string; basic: boolean; host: MediaStream | null;
  capture: RefObject<(() => Promise<{ stream: MediaStream; stop: () => void }>) | null>; active: boolean; sources?: ReactNode; chat?: ReactNode; health?: ReactNode; externalPreview?: ReactNode; external?: boolean; cameraOn?: boolean; microphoneOn?: boolean; deviceBusy?: boolean; onCameraToggle?: () => void; onMicrophoneToggle?: () => void;
}) {
  const [guests, setGuests] = useState<Guest[]>([]);
  const [invite, setInvite] = useState('');
  const [status, setStatus] = useState('');
  const [show] = useState(loadShow);
  const [scenes, setScenes] = useState<SceneDef[]>(show.scenes);
  const initialScene = show.scenes.find((s) => s.layout === 'solo' && s.main === 'camera') ?? show.scenes[0];
  const [previewId, setPreviewId] = useState(initialScene.id);
  const [program, setProgram] = useState<SceneDef>(() => cloneScene(initialScene));
  const [programGuests, setProgramGuests] = useState<string[]>([]);
  const [draft, setDraft] = useState<Graphics>(show.graphics);
  const [onAir, setOnAir] = useState<Graphics>(() => ({ ...cloneGraphics(show.graphics), lower: { ...show.graphics.lower, show: false } }));
  const [panel, setPanel] = useState('');
  const [showDraft, setShowDraft] = useState(false);
  const thumbnails = useRef(new Map<string, HTMLCanvasElement>());
  const localRecorder = useRef<MediaRecorder | null>(null);
  const [transition, setTransition] = useState<Transition>('fade');
  const [fadeMs, setFadeMs] = useState(1000);
  const [rundown, setRundown] = useState<Cue[]>([]);
  const [cueName, setCueName] = useState('');
  const nextCue = useRef(0);
  const trans = useRef<{ frame: HTMLCanvasElement; started: number; duration: number; kind: Transition } | null>(null);
  const previewTiming = useRef<Timing>(newTiming());
  const programTiming = useRef<Timing>(newTiming());
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const [media, setMedia] = useState<{ url: string; kind: 'image' | 'video'; name: string } | null>(null);
  const [music, setMusic] = useState<{ url: string; name: string; playing: boolean } | null>(null);
  const mediaEl = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  const musicEl = useRef<HTMLAudioElement | null>(null);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const previousGain = useRef<Record<string, number>>({});
  const [monitor, setMonitor] = useState(false);
  const enableAudio = useRef<(() => Promise<void>) | null>(null);
  const recordLocal = useRef<(() => MediaStream) | null>(null);
  const [recording, setRecording] = useState<{ rec: MediaRecorder; since: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const returns = useRef(new Map<string, MediaStreamAudioDestinationNode>());
  const ice = useRef<RTCIceServer[]>([]);
  const context = useRef<AudioContext | null>(null);
  const [gain, setGain] = useState<Record<string, number>>({ music: 0.35 });
  const preview = useRef<HTMLCanvasElement>(null);
  const output = useRef<HTMLCanvasElement>(null);
  const peers = useRef(new Map<string, ReturnType<typeof guestPeer>>());
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const scene = scenes.find((s) => s.id === previewId) ?? scenes[0];
  const settings = useRef({ scene, program, draft, onAir, guests, programGuests, gain, host, screen, basic, monitor, scenes });
  settings.current = { scene, program, draft, onAir, guests, programGuests, gain, host, screen, basic, monitor, scenes };

  // The show is saved on this computer (debounced): it is ready the next time the studio opens.
  useEffect(() => {
    if (basic) return;
    const t = setTimeout(() => { if (!saveShow({ scenes, graphics: draft })) setStatus('Images are too large to keep on this computer: use a smaller logo or background.'); }, 600);
    return () => clearTimeout(t);
  }, [scenes, draft, basic]);
  useEffect(() => { previewTiming.current.sceneSince = performance.now(); }, [previewId]);
  // Graphics animate in and out in the preview as they are switched on and off.
  useEffect(() => { syncTiming(previewTiming.current, draft); }, [draft]);
  useEffect(() => { syncTiming(previewTiming.current, draft, performance.now(), ['lower']); }, [draft.lower.name, draft.lower.title, draft.lower.style, draft.lower.anim]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { syncTiming(previewTiming.current, draft, performance.now(), ['logo']); }, [draft.logo.anim, draft.logo.corner]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { syncTiming(programTiming.current, onAir); }, [onAir]);
  useEffect(() => { if (!recording) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [recording]);
  useEffect(() => () => { if (media?.url) URL.revokeObjectURL(media.url); }, [media?.url]);
  useEffect(() => () => { if (music?.url) URL.revokeObjectURL(music.url); }, [music?.url]);
  useEffect(() => () => { screen?.getTracks().forEach((t) => t.stop()); }, [screen]);

  // Guests: invitations, WebRTC connections and the return feed each guest hears.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void getSocket().then((socket) => {
      if (cancelled) return;
      const room = peers.current;
      const add = ({ id }: { id: string }) => {
        const destination = context.current?.createMediaStreamDestination();
        if (destination) returns.current.set(id, destination);
        let received: MediaStream | null = null;
        const update = () => setGuests((all) => all.map((guest) => guest.id === id
          ? { ...guest, stream: peer.pc.connectionState === 'connected' ? received : null }
          : guest));
        const peer = guestPeer(socket, id, ice.current, (stream) => { received = stream; update(); }, () => destination?.stream.getAudioTracks()[0]);
        peer.pc.onconnectionstatechange = update;
        room.set(id, peer);
        setGuests((all) => [...all, { id, stream: null, onAir: false }]);
      };
      const drop = ({ id }: { id: string }) => {
        room.get(id)?.pc.close(); room.delete(id);
        setProgramGuests((all) => all.filter((guestId) => guestId !== id));
        returns.current.get(id)?.stream.getTracks().forEach((track) => track.stop());
        returns.current.delete(id);
        setGuests((all) => all.filter((g) => g.id !== id));
      };
      const chains = new Map<string, Promise<void>>();
      const signal = ({ from, payload }: { from: string; payload: GuestSignal }) => {
        const peer = room.get(from);
        if (!peer) return;
        chains.set(from, (chains.get(from) ?? Promise.resolve()).then(() => peer.receive(payload)).catch(() => setStatus('A guest connection could not be established.')));
      };
      const reset = () => { for (const id of room.keys()) drop({ id }); setInvite(''); };
      socket.on('live:guest-arrived', add); socket.on('live:guest-left', drop);
      socket.on('live:guest-signal', signal); socket.on('disconnect', reset);
      cleanup = () => {
        socket.emit('live:guest-leave');
        socket.off('live:guest-arrived', add); socket.off('live:guest-left', drop);
        socket.off('live:guest-signal', signal); socket.off('disconnect', reset);
        reset();
      };
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [streamId]);

  // Composition and sound, 30 times a second.
  useEffect(() => {
    const canvas = output.current;
    const ctx = canvas?.getContext('2d');
    const pctx = preview.current?.getContext('2d');
    if (!canvas || !ctx) return;
    const elements = videos.current;
    let audio: AudioContext | undefined;
    let monitorBus: GainNode | undefined;
    let limiter: DynamicsCompressorNode | undefined;
    const returnBuses = returns.current;
    let captured: MediaStream | undefined;
    type Input = { key: unknown; sources: AudioNode[]; gain: GainNode; meter: AnalyserNode; sends: Map<string, GainNode> };
    const inputs = new Map<string, Input>();
    const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
    // The free co-stream shows no graphics: nothing is ever "on" in its timing.
    const noGraphics = newTiming();
    let destination: MediaStreamAudioDestinationNode | undefined;
    let lastMeter = 0;
    let lastThumbnail = 0;

    const stop = () => { captured?.getTracks().forEach((track) => track.stop()); captured = undefined; };
    const readyAudio = async () => {
      if (!audio) {
        audio = new AudioContext();
        context.current = audio;
        destination = audio.createMediaStreamDestination();
        limiter = audio.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.ratio.value = 12;
        limiter.connect(destination);
        monitorBus = audio.createGain();
        monitorBus.gain.value = 0;
        monitorBus.connect(audio.destination);
      }
      await audio.resume();
    };
    enableAudio.current = readyAudio;
    capture.current = async () => {
      stop();
      if (!canvas.captureStream) throw new Error('This browser does not support live composition.');
      await readyAudio();
      captured = canvas.captureStream(30);
      captured.addTrack(destination!.stream.getAudioTracks()[0].clone());
      return { stream: captured, stop };
    };
    // A separate copy of the program for recording on this computer (independent of the broadcast).
    recordLocal.current = () => {
      const s = canvas.captureStream(30);
      if (destination) s.addTrack(destination.stream.getAudioTracks()[0].clone());
      return s;
    };
    const frame = () => {
      const s = settings.current;
      const streams = new Map<string, MediaStream>();
      if (s.host) streams.set('host', s.host);
      if (s.screen) streams.set('screen', s.screen);
      for (const g of s.guests) if (g.stream) streams.set(g.id, g.stream);
      for (const [id, video] of elements) if (!streams.has(id)) { video.srcObject = null; elements.delete(id); }
      for (const [id, stream] of streams) {
        let video = elements.get(id);
        if (!video) { video = document.createElement('video'); video.muted = true; video.playsInline = true; elements.set(id, video); }
        if (video.srcObject !== stream) { video.srcObject = stream; void video.play().catch(() => undefined); }
      }
      const selected = s.guests.filter((g) => g.onAir).map((g) => g.id);
      const programOn = s.basic ? selected : s.programGuests.filter((id) => streams.has(id));
      const showing: SceneDef = s.basic ? { ...s.program, layout: s.program.layout === 'card' ? 'card' : programOn.length ? 'grid' : s.program.layout, hostMic: s.program.hostMic } : s.program;

      // Sound: every source has a meter and a fader; what is heard follows the program scene.
      const meterAt = performance.now();
      const sample = !!audio && meterAt - lastMeter > 120;
      const nextLevels: Record<string, number> = {};
      const mediaVideo = mediaEl.current instanceof HTMLVideoElement ? mediaEl.current : null;
      const audible: Array<[string, unknown, () => AudioNode[]]> = [];
      if (audio) {
        for (const [id, stream] of streams) if (stream.getAudioTracks().length) audible.push([id, stream, () => stream.getAudioTracks().map((track) => audio!.createMediaStreamSource(new MediaStream([track])))]);
        for (const [id, el] of [['media', mediaVideo], ['music', musicEl.current]] as const) if (el) audible.push([id, el, () => {
          let src = elementSources.get(el);
          if (!src) { src = audio!.createMediaElementSource(el); elementSources.set(el, src); }
          return [src];
        }]);
      }
      for (const [id, input] of inputs) if (!audible.some(([key, k]) => key === id && k === input.key)) {
        for (const source of input.sources) source.disconnect();
        input.meter.disconnect(); input.gain.disconnect();
        for (const send of input.sends.values()) send.disconnect();
        inputs.delete(id);
      }
      if (monitorBus) monitorBus.gain.value = s.monitor ? 1 : 0;
      if (audio && destination) for (const [id, key, make] of audible) {
        let input = inputs.get(id);
        if (!input) {
          const nodes = make();
          const meter = audio.createAnalyser(), node = audio.createGain();
          meter.fftSize = 256;
          for (const source of nodes) source.connect(meter);
          meter.connect(node).connect(limiter!);
          if (id !== 'host' && id !== 'screen' && monitorBus) meter.connect(monitorBus);
          input = { key, sources: nodes, gain: node, meter, sends: new Map() }; inputs.set(id, input);
        }
        const isGuest = id !== 'host' && id !== 'screen' && id !== 'media' && id !== 'music';
        const heard = id === 'host' ? showing.hostMic
          : id === 'screen' ? uses(showing, 'screen')
          : id === 'media' ? uses(showing, 'media')
          : id === 'music' ? true
          : uses(showing, 'guests') && programOn.includes(id);
        input.gain.gain.value = heard ? (s.gain[id] ?? (id === 'music' ? 0.35 : 1)) : 0;
        // Each guest hears the host and the other on-air guests, never their own microphone.
        for (const [target, send] of input.sends) if (!returnBuses.has(target)) { input.meter.disconnect(send); send.disconnect(); input.sends.delete(target); }
        for (const [target, bus] of returnBuses) {
          if (target === id) continue;
          let send = input.sends.get(target);
          if (!send) { send = audio.createGain(); input.meter.connect(send).connect(bus); input.sends.set(target, send); }
          send.gain.value = id === 'host' || (isGuest && programOn.includes(id) && programOn.includes(target)) ? (s.gain[id] ?? 1) : 0;
        }
        if (sample) {
          const samples = new Uint8Array(input.meter.fftSize);
          input.meter.getByteTimeDomainData(samples);
          nextLevels[id] = toDb(Math.sqrt(samples.reduce((sum, value) => sum + (value - 128) ** 2, 0) / samples.length));
        }
      }
      if (sample) { lastMeter = meterAt; setLevels(nextLevels); }

      const inputsFor = (ids: string[]): Inputs => ({
        camera: elements.get('host') ?? null, screen: elements.get('screen') ?? null,
        media: mediaEl.current, guests: ids.flatMap((id) => elements.get(id) ?? []),
      });
      const t = performance.now();
      const programGraphics = s.basic ? { ...s.onAir, logo: { ...s.onAir.logo, show: false }, lower: { ...s.onAir.lower, show: false }, ticker: { ...s.onAir.ticker, show: false }, clock: { show: false } } : s.onAir;
      drawFrame(ctx, showing, programGraphics, inputsFor(programOn), s.basic ? noGraphics : programTiming.current, t);
      const tr = trans.current;
      if (tr) {
        const p = (t - tr.started) / tr.duration;
        if (p < 1) drawTransition(ctx, tr.frame, tr.kind, p); else trans.current = null;
      }
      if (pctx) drawFrame(pctx, s.scene, s.draft, inputsFor(selected), previewTiming.current, t);
      if (t - lastThumbnail > 600) {
        lastThumbnail = t;
        for (const item of s.scenes) {
          const thumb = thumbnails.current.get(item.id)?.getContext('2d');
          if (thumb) { thumb.save(); thumb.scale(256 / W, 144 / H); drawFrame(thumb, item, programGraphics, inputsFor(selected), noGraphics, t); thumb.restore(); }
        }
      }
    };
    const timer = setInterval(frame, 1000 / 30);
    frame();
    return () => { clearInterval(timer); capture.current = null; enableAudio.current = null; recordLocal.current = null; context.current = null; stop(); if (audio) void audio.close(); for (const v of elements.values()) v.srcObject = null; elements.clear(); };
  }, [basic, capture]);

  useEffect(() => { if (host) void enableAudio.current?.().catch(() => setStatus('Use Enable meters to activate audio monitoring.')); }, [host]);
  useEffect(() => () => { if (localRecorder.current?.state === 'recording') localRecorder.current.stop(); mediaEl.current instanceof HTMLVideoElement && mediaEl.current.pause(); musicEl.current?.pause(); }, []);

  const open = async () => {
    try {
      await enableAudio.current?.();
      ice.current = (await api<{ iceServers: RTCIceServer[] }>('/live/ice')).iceServers;
      const socket = await getSocket();
      const result = await socket.timeout(5000).emitWithAck('live:guest-open', { streamId, basic });
      if (!result.ok) throw new Error('Could not open the green room.');
      setInvite(`${window.location.origin}/live/join?invite=${result.token}`); setStatus(`Guest invitation ready · ${result.limit} seats`);
    } catch (e) { setStatus((e as Error).message); }
  };

  const lowerChanged = (a: Graphics, b: Graphics) => a.lower.show !== b.lower.show || a.lower.name !== b.lower.name || a.lower.title !== b.lower.title || a.lower.style !== b.lower.style;
  /** Preview → program, with the chosen transition. Graphics go with it. */
  const take = () => {
    const canvas = output.current;
    if (transition !== 'cut' && canvas) {
      const frame = document.createElement('canvas');
      frame.width = canvas.width; frame.height = canvas.height;
      frame.getContext('2d')?.drawImage(canvas, 0, 0);
      trans.current = { frame, started: performance.now(), duration: fadeMs, kind: transition };
    } else trans.current = null;
    if (program.id !== scene.id) programTiming.current.sceneSince = previewTiming.current.sceneSince;
    syncTiming(programTiming.current, draft, performance.now(), lowerChanged(draft, onAir) ? ['lower'] : []);
    setProgram(cloneScene(scene));
    setProgramGuests(guests.filter((g) => g.onAir).map((g) => g.id));
    setOnAir(cloneGraphics(draft));
    void enableAudio.current?.();
  };
  /** Graphics only (lower third, ticker, logo…) straight to air, without changing the scene. */
  const sendGraphics = () => {
    syncTiming(programTiming.current, draft, performance.now(), lowerChanged(draft, onAir) ? ['lower'] : []);
    setOnAir(cloneGraphics(draft));
  };
  const takeRef = useRef(take); takeRef.current = take;

  // Keyboard: Space or Enter takes to air; 1–9 pick a scene for the preview.
  useEffect(() => {
    if (basic) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, [contenteditable=true]')) return;
      if (e.key === ' ' || e.key === 'Enter') { if (t.closest('button, a')) return; e.preventDefault(); takeRef.current(); }
      else if (/^[1-9]$/.test(e.key)) { const pick = settings.current.scenes[Number(e.key) - 1]; if (pick) setPreviewId(pick.id); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [basic]);

  const updateScene = (patch: Partial<SceneDef>) => setScenes((all) => all.map((s) => (s.id === scene.id ? { ...s, ...patch } : s)));
  const addScene = () => {
    const id = `scene-${Date.now().toString(36)}`;
    setScenes((all) => [...all, { ...cloneScene(scene), id, name: `Scene ${all.length + 1}` }]);
    setPreviewId(id); setPanel('Scene');
  };
  const removeScene = () => {
    if (scenes.length <= 1) return;
    const rest = scenes.filter((s) => s.id !== scene.id);
    setScenes(rest); setPreviewId(rest[0].id);
  };
  const moveScene = (dir: -1 | 1) => setScenes((all) => {
    const i = all.findIndex((s) => s.id === scene.id), j = i + dir;
    if (j < 0 || j >= all.length) return all;
    const next = [...all]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const setLower = (patch: Partial<Graphics['lower']>) => setDraft((d) => {
    const lower = { ...d.lower, ...patch };
    // Typing a name into a hidden, empty lower third shows it in the preview.
    if (patch.name && !d.lower.name && !d.lower.show) lower.show = true;
    return { ...d, lower };
  });

  const shareScreen = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing needs a supported browser over HTTPS or localhost.');
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      s.getVideoTracks()[0]?.addEventListener('ended', () => setScreen((current) => current === s ? null : current));
      setScreen(s);
      const item = scenes.find((item) => item.main === 'screen');
      if (item) { setPreviewId(item.id); if (!active) setProgram(cloneScene(item)); else setShowDraft(true); }
      setStatus(active ? 'Screen ready in preview. Choose Take to air when you are ready to share it.' : 'Screen connected. Choose the Screen + Host scene to include it.');
    } catch (error) { setStatus(error instanceof DOMException ? 'Screen sharing was cancelled or not allowed.' : (error as Error).message); }
  };
  const pickMedia = (file: File | undefined) => {
    if (!file) return;
    const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null;
    if (!kind) { setStatus('Choose an image or a video file.'); return; }
    if (media) URL.revokeObjectURL(media.url);
    if (mediaEl.current instanceof HTMLVideoElement) mediaEl.current.pause();
    const url = URL.createObjectURL(file);
    if (kind === 'video') { const v = document.createElement('video'); v.src = url; v.loop = true; v.playsInline = true; void v.play().catch(() => undefined); mediaEl.current = v; }
    else { const i = new Image(); i.src = url; mediaEl.current = i; }
    setMedia({ url, kind, name: file.name });
  };
  const pickMusic = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/')) { setStatus('Choose a sound file (MP3, M4A, WAV…).'); return; }
    if (music) URL.revokeObjectURL(music.url);
    musicEl.current?.pause();
    const url = URL.createObjectURL(file);
    const a = new Audio(url); a.loop = true; musicEl.current = a;
    void (enableAudio.current?.() ?? Promise.resolve()).then(() => a.play()).then(() => setMusic({ url, name: file.name, playing: true })).catch(() => setMusic({ url, name: file.name, playing: false }));
  };
  const toggleMusic = () => {
    const a = musicEl.current; if (!a || !music) return;
    if (a.paused) void a.play().then(() => setMusic({ ...music, playing: true })).catch(() => undefined);
    else { a.pause(); setMusic({ ...music, playing: false }); }
  };
  const toggleRecording = async () => {
    if (recording) { recording.rec.stop(); setRecording(null); return; }
    try {
      if (typeof MediaRecorder === 'undefined') throw new Error('Local recording is not supported by this browser.');
      await enableAudio.current?.();
      const stream = recordLocal.current?.();
      if (!stream) throw new Error('The program is not ready for recording.');
      const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      let rec: MediaRecorder;
      try { rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 6_000_000 }); }
      catch (error) { stream.getTracks().forEach((t) => t.stop()); throw error; }
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop()); localRecorder.current = null; setRecording(null);
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `free-me-live-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      };
      rec.onerror = () => setStatus('Local recording failed. Check available memory and try again.');
      try { rec.start(1000); } catch (error) { stream.getTracks().forEach((t) => t.stop()); throw error; }
      localRecorder.current = rec; setRecording({ rec, since: Date.now() }); setNow(Date.now());
    } catch (error) { setStatus((error as Error).message); }
  };

  const fader = (id: string, label: string, icon: ReactNode) => {
    const db = levels[id] ?? -60;
    const muted = gain[id] === 0;
    return (
      <div key={id} className={styles.channel}>
        <div className={styles.channelHead}><span className="flex items-center gap-1.5">{icon}{label}</span><span className="tabular-nums text-[#9fb9be]">{db <= -59 ? '−∞' : `${db.toFixed(1)} dB`}</span></div>
        <meter aria-label={`${label} level`} className={styles.meter} min={-60} max={0} low={-18} high={-6} optimum={-30} value={db} />
        <div className="flex items-center gap-2">
          <input aria-label={id === 'host' ? 'Host volume' : `${label} volume`} type="range" className="min-w-0 flex-1 accent-[#21d9cb]" min={0} max={1.5} step={0.05} value={gain[id] ?? (id === 'music' ? 0.35 : 1)} onChange={(e) => setGain({ ...gain, [id]: Number(e.target.value) })} />
          <button type="button" className={styles.mute} aria-pressed={muted} aria-label={muted ? `Unmute ${label}` : `Mute ${label}`} onClick={() => {
            const current = gain[id] ?? 1;
            if (current > 0) previousGain.current[id] = current;
            setGain({ ...gain, [id]: muted ? previousGain.current[id] ?? 1 : 0 });
          }}>{muted ? <Icon.VolumeOff size={14} /> : <Icon.VolumeHigh size={14} />}</button>
        </div>
      </div>
    );
  };

  const greenRoom = (
    <div className="space-y-2 rounded-xl bg-surface p-3">
      <h2 className="font-bold">{basic ? 'Co-stream guests · up to 2' : 'Guest green room'}</h2>
      {!invite ? <button type="button" className={button} onClick={() => void open()}>Create guest invite</button> :
        <div className="flex flex-wrap gap-2"><input readOnly aria-label="Guest invitation link" value={invite} className="min-w-0 flex-1 rounded-lg bg-elevated p-2 text-sm" /><button type="button" className={button} onClick={() => void navigator.clipboard.writeText(invite).then(() => setStatus('Invite copied.')).catch(() => setStatus('Select the invitation link to copy it.'))}>Copy invite</button></div>}
      {basic && <button type="button" className={button} aria-pressed={gain.host === 0} onClick={() => setGain({ ...gain, host: gain.host === 0 ? 1 : 0 })}>{gain.host === 0 ? 'Unmute microphone' : 'Mute microphone'}</button>}
      {invite && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={monitor} onChange={(event) => setMonitor(event.target.checked)} />Listen to guests (use headphones)</label>}
      {basic && status && <p role="status" className="text-sm text-muted">{status}</p>}
      {guests.map((g, i) => <div key={g.id} className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex-1">Guest {i + 1} · {(basic ? g.onAir : uses(program, 'guests') && programGuests.includes(g.id)) ? 'In program' : g.onAir ? 'In preview' : g.stream ? 'Ready' : 'Connecting'}</span>
        <button type="button" className={button} disabled={!g.stream} onClick={() => setGuests((all) => all.map((guest) => guest.id === g.id ? { ...guest, onAir: !guest.onAir } : guest))}>{g.onAir ? 'Return to green room' : basic ? 'Add to program' : 'Add to preview'}</button>
        <button type="button" className={button} onClick={() => void getSocket().then((s) => s.emit('live:guest-remove', g.id))}>Remove</button>
      </div>)}
    </div>
  );

  const sceneEditor = (
    <div className="space-y-3">
      <label className="block text-[12px] font-semibold">Choose scene<select className={field} value={previewId} onChange={(e) => { setPreviewId(e.target.value); setShowDraft(true); }}>{scenes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block text-[12px] font-semibold">Scene name<input className={field} value={scene.name} maxLength={40} onChange={(e) => updateScene({ name: e.target.value })} /></label>
      <div>
        <p className="text-[12px] font-semibold">Layout</p>
        <div className="mt-1 grid grid-cols-5 gap-1" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => <button key={l.id} type="button" role="radio" aria-checked={scene.layout === l.id} title={l.label} aria-label={l.label} onClick={() => updateScene({ layout: l.id })} className={`${styles.layoutBtn} ${scene.layout === l.id ? styles.layoutOn : ''}`}><LayoutIcon layout={l.id} /></button>)}
        </div>
      </div>
      {scene.layout !== 'card' && scene.layout !== 'grid' && <label className="block text-[12px] font-semibold">{scene.layout === 'solo' ? 'Source' : 'Main source'}
        <select className={field} value={scene.main} onChange={(e) => updateScene({ main: e.target.value as SourceId })}>{SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>}
      {(scene.layout === 'pip' || scene.layout === 'side') && <label className="block text-[12px] font-semibold">{scene.layout === 'pip' ? 'Corner picture' : 'Second source'}
        <select className={field} value={scene.second} onChange={(e) => updateScene({ second: e.target.value as SourceId })}>{SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>}
      {scene.layout === 'pip' && <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px] font-semibold">Corner<select className={field} value={scene.pipCorner} onChange={(e) => updateScene({ pipCorner: e.target.value as Corner })}>{CORNERS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label className="block text-[12px] font-semibold">Size<input type="range" className="mt-2 w-full accent-[#21d9cb]" min={0.18} max={0.4} step={0.01} value={scene.pipSize} onChange={(e) => updateScene({ pipSize: Number(e.target.value) })} /></label>
      </div>}
      {scene.layout === 'card' && <>
        <label className="block text-[12px] font-semibold">Card title<input className={field} value={scene.card.title} maxLength={60} onChange={(e) => updateScene({ card: { ...scene.card, title: e.target.value } })} /></label>
        <label className="block text-[12px] font-semibold">Card subtitle<input className={field} value={scene.card.subtitle} maxLength={90} onChange={(e) => updateScene({ card: { ...scene.card, subtitle: e.target.value } })} /></label>
        <label className="block text-[12px] font-semibold">Countdown in minutes (0 = none)<input type="number" min={0} max={120} className={field} value={scene.card.countdownMin} onChange={(e) => updateScene({ card: { ...scene.card, countdownMin: Math.max(0, Math.min(120, Number(e.target.value) || 0)) } })} /></label>
      </>}
      <div className="grid grid-cols-[auto_1fr] items-end gap-2">
        <label className="block text-[12px] font-semibold">Background<input type="color" className="mt-1 block h-8 w-12 rounded border border-[#25424a] bg-transparent" value={scene.background.color} onChange={(e) => updateScene({ background: { ...scene.background, color: e.target.value } })} /></label>
        <label className="block text-[12px] font-semibold">Background image<input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block w-full text-[12px]" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readImage(f, 1280).then((image) => updateScene({ background: { ...scene.background, image } })).catch((err) => setStatus((err as Error).message)); }} /></label>
      </div>
      {scene.background.image && <button type="button" className={styles.small} onClick={() => updateScene({ background: { ...scene.background, image: null } })}>Remove background image</button>}
      <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={scene.hostMic} onChange={(e) => updateScene({ hostMic: e.target.checked })} />Host microphone on in this scene</label>
      <div className="flex flex-wrap gap-1.5 border-t border-[#19353c] pt-3">
        <button type="button" className={styles.small} onClick={addScene}>Duplicate</button>
        <button type="button" className={styles.small} onClick={() => moveScene(-1)} aria-label="Move scene up">↑</button>
        <button type="button" className={styles.small} onClick={() => moveScene(1)} aria-label="Move scene down">↓</button>
        <button type="button" className={styles.small} disabled={scenes.length <= 1} onClick={removeScene}>Delete scene</button>
      </div>
    </div>
  );

  const graphics = (
    <div className="space-y-4">
      <fieldset className={styles.group}>
        <legend>Lower third</legend>
        <label className="block text-[12px] font-semibold">Lower third name<input className={field} maxLength={80} value={draft.lower.name} placeholder="Aline Umutoni" onChange={(e) => setLower({ name: e.target.value })} /></label>
        <label className="block text-[12px] font-semibold">Lower third title<input className={field} maxLength={100} value={draft.lower.title} placeholder="Reporter, Kigali" onChange={(e) => setLower({ title: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] font-semibold">Style<select className={field} value={draft.lower.style} onChange={(e) => setLower({ style: e.target.value as LowerStyle })}><option value="brand">Brand</option><option value="news">News</option><option value="minimal">Minimal</option></select></label>
          <label className="block text-[12px] font-semibold">Hide after<select className={field} value={draft.lower.autoHideSec} onChange={(e) => setLower({ autoHideSec: Number(e.target.value) })}><option value={0}>Stays on</option><option value={6}>6 s</option><option value={10}>10 s</option><option value={20}>20 s</option></select></label>
        </div>
        <label className="block text-[12px] font-semibold">Lower third animation<select className={field} value={draft.lower.anim} onChange={(e) => setLower({ anim: e.target.value as Anim })}>{ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.lower.show} onChange={(e) => setLower({ show: e.target.checked })} />Show lower third</label>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Ticker</legend>
        <label className="block text-[12px] font-semibold">Ticker text<input className={field} maxLength={300} value={draft.ticker.text} placeholder="Headlines scroll along the bottom" onChange={(e) => setDraft({ ...draft, ticker: { ...draft.ticker, text: e.target.value, show: draft.ticker.show || (!draft.ticker.text && !!e.target.value) } })} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] font-semibold">Label<input className={field} maxLength={24} value={draft.ticker.label} onChange={(e) => setDraft({ ...draft, ticker: { ...draft.ticker, label: e.target.value.toUpperCase() } })} /></label>
          <label className="block text-[12px] font-semibold">Speed<input type="range" className="mt-2 w-full accent-[#21d9cb]" min={0.4} max={2.5} step={0.1} value={draft.ticker.speed} onChange={(e) => setDraft({ ...draft, ticker: { ...draft.ticker, speed: Number(e.target.value) } })} /></label>
        </div>
        <label className="block text-[12px] font-semibold">Ticker animation<select className={field} value={draft.ticker.anim} onChange={(e) => setDraft({ ...draft, ticker: { ...draft.ticker, anim: e.target.value as Anim } })}>{ANIMS.filter((a) => a.id !== 'type' && a.id !== 'pop').map((a) => <option key={a.id} value={a.id}>{a.id === 'slide' ? 'Slide up' : a.label}</option>)}</select></label>
        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.ticker.show} onChange={(e) => setDraft({ ...draft, ticker: { ...draft.ticker, show: e.target.checked } })} />Show ticker</label>
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Logo</legend>
        <label className="block text-[12px] font-semibold">Broadcast logo<input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block w-full text-[12px]" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readImage(f, 512).then((src) => setDraft((d) => ({ ...d, logo: { ...d.logo, src, show: true } }))).catch((err) => setStatus((err as Error).message)); }} /></label>
        {draft.logo.src && <>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[12px] font-semibold">Logo position<select className={field} value={draft.logo.corner} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo, corner: e.target.value as Corner } })}>{LOGO_PLACES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
            <label className="block text-[12px] font-semibold">Size<input type="range" className="mt-2 w-full accent-[#21d9cb]" min={0.06} max={0.3} step={0.01} value={draft.logo.size} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo, size: Number(e.target.value) } })} /></label>
          </div>
          <label className="block text-[12px] font-semibold">Opacity<input type="range" className="mt-2 w-full accent-[#21d9cb]" min={0.2} max={1} step={0.05} value={draft.logo.opacity} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo, opacity: Number(e.target.value) } })} /></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[12px] font-semibold">Logo animation<select className={field} value={draft.logo.anim} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo, anim: e.target.value as Anim } })}>{ANIMS.filter((a) => a.id !== 'type').map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
            <label className="block text-[12px] font-semibold">Logo motion<select className={field} value={draft.logo.loop} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo, loop: e.target.value as Loop } })}>{LOOPS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={draft.logo.show} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo, show: e.target.checked } })} />Show logo</label>
            <button type="button" className={styles.small} onClick={() => setDraft({ ...draft, logo: { ...draft.logo, src: null } })}>Remove logo</button>
          </div>
        </>}
      </fieldset>
      <fieldset className={styles.group}>
        <legend>Brand and clock</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[12px] font-semibold">Main colour<input type="color" className="mt-1 block h-8 w-12 rounded border border-[#25424a] bg-transparent" value={draft.brand.primary} onChange={(e) => setDraft({ ...draft, brand: { ...draft.brand, primary: e.target.value } })} /></label>
          <label className="text-[12px] font-semibold">Accent<input type="color" className="mt-1 block h-8 w-12 rounded border border-[#25424a] bg-transparent" value={draft.brand.accent} onChange={(e) => setDraft({ ...draft, brand: { ...draft.brand, accent: e.target.value } })} /></label>
          <label className="flex items-center gap-2 pb-1 text-[12px]"><input type="checkbox" checked={draft.clock.show} onChange={(e) => setDraft({ ...draft, clock: { ...draft.clock, show: e.target.checked } })} />Clock on screen</label>
        </div>
      </fieldset>
      <button type="button" className={styles.small} onClick={sendGraphics}>Send graphics to air now</button>
    </div>
  );

  const sourcesPanel = (
    <div className="space-y-3">
      {sources}
      <fieldset className={styles.group}>
        <legend>More sources</legend>
        <div className="flex flex-wrap gap-2">
          {screen ? <button type="button" className={styles.small} onClick={() => { screen.getTracks().forEach((t) => t.stop()); setScreen(null); }}>Stop screen share</button>
            : <button type="button" className={styles.small} onClick={() => void shareScreen()}>Share a screen or window</button>}
        </div>
        <label className="block text-[12px] font-semibold">Image or video<input type="file" accept="image/*,video/*" className="mt-1 block w-full text-[12px]" onChange={(e) => { pickMedia(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {media && <p className="text-[12px] text-[#9fb9be]">{media.kind === 'video' ? 'Video' : 'Image'}: {media.name}. Choose “Image or video” as a scene source.</p>}
        <label className="block text-[12px] font-semibold">Music bed (loops)<input type="file" accept="audio/*" className="mt-1 block w-full text-[12px]" onChange={(e) => { pickMusic(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {music && <div className="flex items-center gap-2 text-[12px]"><span className="min-w-0 flex-1 truncate">{music.name}</span><button type="button" className={styles.small} onClick={toggleMusic}>{music.playing ? 'Pause music' : 'Play music'}</button></div>}
      </fieldset>
    </div>
  );

  const cues = (
    <section className="space-y-2">
      <h2 className="font-bold">Show rundown</h2>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => {
        event.preventDefault();
        const name = cueName.trim();
        if (!name || rundown.length >= 30) return;
        const id = ++nextCue.current;
        setRundown((all) => [...all, { id, name, sceneId: scene.id, graphics: cloneGraphics(draft) }]);
        setCueName('');
      }}>
        <input aria-label="Cue name" placeholder="e.g. Opening headlines" className={`${field} !mt-0 min-w-0 flex-1`} maxLength={80} value={cueName} onChange={(event) => setCueName(event.target.value)} />
        <button className={styles.small} disabled={!cueName.trim() || rundown.length >= 30}>Save preview as cue</button>
      </form>
      {rundown.length > 0 && <ol className="space-y-1">
        {rundown.map((cue, index) => <li className="flex flex-wrap items-center gap-2 text-[12px]" key={cue.id}>
          <span className="flex-1">{index + 1}. {cue.name} · {scenes.find((s) => s.id === cue.sceneId)?.name ?? 'deleted scene'}</span>
          <button type="button" className={styles.small} onClick={() => { if (scenes.some((s) => s.id === cue.sceneId)) setPreviewId(cue.sceneId); setDraft(cloneGraphics(cue.graphics)); }}>Load into preview</button>
          <button type="button" className={styles.small} aria-label={`Remove cue ${cue.name}`} onClick={() => setRundown((all) => all.filter(({ id }) => id !== cue.id))}>Remove</button>
        </li>)}
      </ol>}
    </section>
  );

  const panels = basic ? ['Crew', 'Scene', 'Sources', 'Guests'] : ['Crew', 'Scene', 'Sources', 'Graphics', 'Guests', 'Rundown'];
  const recClock = recording ? Math.max(0, Math.floor((now - recording.since) / 1000)) : 0;
  const chooseScene = (item: SceneDef) => {
    setPreviewId(item.id);
    if (!active) { if (program.id !== item.id) programTiming.current.sceneSince = performance.now(); setProgram(cloneScene(item)); setProgramGuests(guests.filter((g) => g.onAir).map((g) => g.id)); }
    else setShowDraft(true);
  };
  return (
    <div className={desk.workspace} aria-label="Broadcast workspace">
      <section className={`${desk.card} ${desk.monitor}`} aria-label="Production monitors">
        <header className={desk.cardHead}><h2>{external ? 'ENCODER PREVIEW' : active ? 'PROGRAM · ON AIR' : 'PROGRAM PREVIEW'}</h2><small>{external ? 'Owner monitor' : active ? program.name : 'Only you can see this'}</small></header>
        <div className={desk.picture}>
          <div className={desk.draft} hidden={!showDraft || external}><span>Next: {scene.name}</span><canvas aria-label="Scene preview" ref={preview} width={W} height={H} /></div>
          <canvas aria-label="Broadcast output" ref={output} width={W} height={H} style={{ visibility: external ? 'hidden' : 'visible' }} />
          {external && <div className={desk.external}>{externalPreview}</div>}
          {!external && !host && !screen && !media && program.layout !== 'card' && <div className={desk.placeholder}><Icon.Camera size={42} /><h3>Set up your camera</h3><p>Connect a webcam, USB capture card, or virtual camera using the Camera button below.</p></div>}
        </div>
        <div className={desk.toolbar}>
          {external ? <span className="text-xs text-[#a0bac3]">Control camera, sound and graphics in your external encoder.</span> : <>
            <button type="button" disabled={deviceBusy} onClick={onCameraToggle} aria-pressed={cameraOn} aria-label="Camera"><Icon.Camera size={17} />Camera <span>{cameraOn ? 'On' : 'Off'}</span></button>
            <button type="button" disabled={deviceBusy} onClick={onMicrophoneToggle} aria-pressed={microphoneOn} aria-label="Microphone"><Icon.Mic size={17} />Microphone <span>{microphoneOn ? 'On' : 'Off'}</span></button>
            <button type="button" aria-pressed={!!screen} onClick={() => screen ? (screen.getTracks().forEach((t) => t.stop()), setScreen(null)) : void shareScreen()}><Icon.ScreenShare size={17} />{screen ? 'Stop sharing' : 'Screen share'}</button>
            <button type="button" onClick={() => setPanel('Sources')}><Icon.Settings size={16} />Devices</button>
          </>}
          <small>{external ? 'Muted monitor' : '720p · 30 fps output'}</small>
        </div>
      </section>
      <div className={desk.middle}>
        <section className={`${desk.card} ${desk.health}`} aria-label="Input status">{health}</section>
        <section className={`${desk.card} ${desk.guests}`} aria-label="Guest green room">
          <header className={desk.cardHead}><h2><Icon.Person size={18} />Guests</h2><small>{guests.length}/{basic ? 2 : 6}</small></header>
          <div className={desk.guestBody}>
            {external ? <p className="text-xs text-[#a0bac3]">Add guests in your encoder. Browser guests do not enter an external feed.</p> : <>
              {!guests.length && <>{[1, 2].map((i) => <div className={desk.seat} key={i}><Icon.Person size={23} /><div>Guest seat {i}<small className="block">Empty</small></div></div>)}</>}
              <div className="studio-guest-controls">{greenRoom}</div>
            </>}
          </div>
        </section>
      </div>
      <div className={desk.chat}>{chat}</div>
      <section className={`${desk.card} ${desk.scenes}`} aria-label="Scenes">
        <header className={desk.cardHead}><h2><Icon.Monitor size={18} />Scenes</h2><div className="flex items-center gap-3"><button type="button" disabled={external} onClick={() => { take(); setShowDraft(false); }} title="Space">Take to air</button><button type="button" disabled={external} onClick={() => setPanel('Scene')}>Edit scenes</button>{!basic && <button type="button" disabled={external} onClick={() => setPanel('Graphics')}>Graphics</button>}</div></header>
        <div className={desk.sceneList}>
          {[...['host', 'guests', 'opening'].flatMap((id) => scenes.filter((s) => s.id === id)), ...scenes.filter((s) => !['host', 'guests', 'opening'].includes(s.id))].slice(0, 3).map((item) => <button type="button" className={desk.sceneButton} key={item.id} aria-label={`Select ${item.id === 'host' ? 'Camera' : item.id === 'guests' ? 'Interview' : item.id === 'opening' ? 'Starting soon' : item.name} scene`} disabled={external} aria-pressed={scene.id === item.id} onClick={() => chooseScene(item)} onDoubleClick={() => { setPreviewId(item.id); setPanel('Scene'); }}>
            <canvas ref={(node) => { if (node) thumbnails.current.set(item.id, node); else thumbnails.current.delete(item.id); }} width={256} height={144} aria-hidden />
            <span>{item.id === 'host' ? 'Camera' : item.id === 'guests' ? 'Interview' : item.id === 'opening' ? 'Starting soon' : item.name}</span>
          </button>)}
        </div>
      </section>
      <section className={`${desk.card} ${desk.mixer}`} aria-label="Audio mixer">
        <header className={desk.cardHead}><h2><Icon.Mic size={17} />Audio mixer</h2><button type="button" disabled={external} onClick={() => void enableAudio.current?.().catch((e) => setStatus((e as Error).message))}>Enable meters</button></header>
        <fieldset disabled={external} className={desk.mixChannels}>
          {fader('host', 'Mic', <Icon.Mic size={14} />)}
          {screen?.getAudioTracks().length ? fader('screen', 'Desktop', <Icon.ScreenShare size={14} />) : null}
          {guests.map((g, i) => fader(g.id, `Guest ${i + 1}`, <Icon.Person size={14} />))}
          {media?.kind === 'video' && fader('media', 'Video', <Icon.Play size={14} />)}
          {music && fader('music', 'Music', <Icon.VolumeHigh size={14} />)}
          {!screen && !music && !guests.length && <p className="text-[10px] text-[#a0bac3]">Share system audio to add a Desktop channel.</p>}
        </fieldset>
      </section>
      <section className={`${desk.card} ${desk.sources}`} aria-label="Sources">
        <header className={desk.cardHead}><h2><Icon.Monitor size={18} />Sources</h2><button type="button" disabled={external} onClick={() => setPanel('Sources')}>+ Add source</button></header>
        <div className={desk.sourceList}>
          <div className={desk.sourceRow}><Icon.Camera size={17} /><span>Camera</span><small>{external ? 'Encoder' : cameraOn ? 'Active' : 'Off'}</small><button type="button" disabled={external} aria-label="Camera settings" onClick={() => setPanel('Sources')}>•••</button></div>
          <div className={desk.sourceRow}><Icon.Mic size={17} /><span>Microphone</span><small>{external ? 'Encoder' : microphoneOn ? 'Active' : 'Off'}</small><button type="button" disabled={external} aria-label="Microphone settings" onClick={() => setPanel('Sources')}>•••</button></div>
          <div className={desk.sourceRow}><Icon.ScreenShare size={17} /><span>Screen share</span><small>{screen ? 'Active' : 'Off'}</small><button type="button" disabled={external} aria-label="Screen share settings" onClick={() => setPanel('Sources')}>•••</button></div>
          {!basic && <button type="button" disabled={external} onClick={() => void toggleRecording()} className="mt-2 text-[11px] text-[#81efdc]">{recording ? `Stop recording · ${Math.floor(recClock / 60)}:${String(recClock % 60).padStart(2, '0')}` : 'Record locally'}</button>}
        </div>
      </section>
      <Dialog open={!!panel} onClose={() => setPanel('')} title="Studio tools" wide>
        <aside aria-label="Production panels">
          <nav className={desk.toolTabs} aria-label="Production panels">{panels.map((item) => <button type="button" key={item} aria-pressed={panel === item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
          {panel === 'Crew' && <div><p>You are the host. Guests enter the green room before you add them to the program.</p><p className="mt-3 text-xs text-muted">Space takes the preview to air. Keys 1–9 select scenes. Use headphones to prevent feedback.</p></div>}
          {panel === 'Scene' && <>{sceneEditor}<div className={`${styles.transitions} mt-4`} role="radiogroup" aria-label="Transition">{TRANSITIONS.map((t) => <button key={t} type="button" role="radio" aria-checked={transition === t} onClick={() => setTransition(t)}>{t}</button>)}<label>Duration<select value={fadeMs} onChange={(e) => setFadeMs(Number(e.target.value))}><option value={300}>0.3 s</option><option value={500}>0.5 s</option><option value={1000}>1 s</option></select></label></div></>}
          {panel === 'Sources' && sourcesPanel}
          {panel === 'Graphics' && graphics}
          {panel === 'Guests' && <p className="text-sm">Use the guest green room on the main desk to create invitations and admit your guests.</p>}
          {panel === 'Rundown' && cues}
        </aside>
      </Dialog>
      {status && <div role="status" className={desk.toast}><span>{status}</span><button type="button" aria-label="Dismiss studio message" onClick={() => setStatus('')}><Icon.Close size={16} /></button></div>}
    </div>
  );
}
