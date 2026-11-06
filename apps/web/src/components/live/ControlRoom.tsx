'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '@/lib/client-api';
import { getSocket } from '@/lib/realtime';
import { guestPeer, type GuestSignal } from './guest-peer';

type Scene = 'Host' | 'Panel' | 'Break';
type Overlay = { lower: string; ticker: string; position: 'left' | 'right'; logo: HTMLImageElement | null };
type Guest = { id: string; stream: MediaStream | null; onAir: boolean };
const empty: Overlay = { lower: '', ticker: '', position: 'left', logo: null };
const scenes: Scene[] = ['Host', 'Panel', 'Break'];
const button = 'rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-50';

function draw(ctx: CanvasRenderingContext2D, scene: Scene, overlay: Overlay, host: HTMLVideoElement | null, guests: HTMLVideoElement[]) {
  ctx.fillStyle = '#071918'; ctx.fillRect(0, 0, 1280, 720);
  const feeds = scene === 'Break' ? [] : [host, ...(scene === 'Panel' ? guests : [])].filter((v): v is HTMLVideoElement => !!v);
  const columns = feeds.length > 1 ? Math.ceil(Math.sqrt(feeds.length)) : 1;
  const rows = Math.max(1, Math.ceil(feeds.length / columns));
  for (const [i, feed] of feeds.entries()) {
    if (!feed.videoWidth) continue;
    const w = 1280 / columns, h = 720 / rows;
    const scale = Math.min(w / feed.videoWidth, h / feed.videoHeight);
    const sw = feed.videoWidth * scale, sh = feed.videoHeight * scale;
    ctx.drawImage(feed, (i % columns) * w + (w - sw) / 2, Math.floor(i / columns) * h + (h - sh) / 2, sw, sh);
  }
  ctx.fillStyle = 'white'; ctx.font = 'bold 38px system-ui';
  if (!feeds.length) ctx.fillText(scene === 'Break' ? 'We’ll be right back' : 'Select a camera or screen', 64, 345);
  if (overlay.logo) {
    const ratio = Math.min(180 / overlay.logo.width, 100 / overlay.logo.height);
    const width = overlay.logo.width * ratio;
    ctx.drawImage(overlay.logo, overlay.position === 'left' ? 32 : 1248 - width, 28, width, overlay.logo.height * ratio);
  }
  if (overlay.lower) {
    ctx.fillStyle = '#08645f'; ctx.fillRect(32, 580, 900, 62);
    ctx.fillStyle = 'white'; ctx.fillText(overlay.lower, 55, 622, 850);
  }
  if (overlay.ticker) {
    ctx.fillStyle = '#071312'; ctx.fillRect(0, 658, 1280, 62);
    ctx.fillStyle = 'white'; ctx.font = 'bold 27px system-ui';
    const travel = 1280 + ctx.measureText(overlay.ticker).width;
    ctx.fillText(overlay.ticker, 1280 - (performance.now() / 15) % travel, 698);
  }
}

export function ControlRoom({ streamId, basic, host, capture, active }: {
  streamId: string; basic: boolean; host: MediaStream | null;
  capture: RefObject<(() => Promise<{ stream: MediaStream; stop: () => void }>) | null>; active: boolean;
}) {
  const [guests, setGuests] = useState<Guest[]>([]);
  const [invite, setInvite] = useState('');
  const [status, setStatus] = useState('');
  const [scene, setScene] = useState<Scene>('Host');
  const [program, setProgram] = useState<Scene>('Host');
  const [programGuests, setProgramGuests] = useState<string[]>([]);
  const [rundown, setRundown] = useState<Array<{ id: number; name: string; scene: Scene; overlay: Overlay }>>([]);
  const [cueName, setCueName] = useState('');
  const nextCue = useRef(0);
  const [transition, setTransition] = useState<'cut' | 'fade'>('cut');
  const fade = useRef<{ frame: HTMLCanvasElement; started: number } | null>(null);
  const [draft, setDraft] = useState<Overlay>(empty);
  const [overlay, setOverlay] = useState<Overlay>(empty);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [monitor, setMonitor] = useState(false);
  const enableAudio = useRef<(() => Promise<void>) | null>(null);
  const returns = useRef(new Map<string, MediaStreamAudioDestinationNode>());
  const ice = useRef<RTCIceServer[]>([]);
  const context = useRef<AudioContext | null>(null);
  const [gain, setGain] = useState<Record<string, number>>({});
  const preview = useRef<HTMLCanvasElement>(null);
  const output = useRef<HTMLCanvasElement>(null);
  const peers = useRef(new Map<string, ReturnType<typeof guestPeer>>());
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const settings = useRef({ scene, program, draft, overlay, guests, programGuests, gain, host, basic, monitor });
  settings.current = { scene, program, draft, overlay, guests, programGuests, gain, host, basic, monitor };

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
    const inputs = new Map<string, { stream: MediaStream; sources: MediaStreamAudioSourceNode[]; gain: GainNode; meter: AnalyserNode; sends: Map<string, GainNode> }>();
    let destination: MediaStreamAudioDestinationNode | undefined;
    let lastMeter = 0;

    const stop = () => {
      captured?.getTracks().forEach((track) => track.stop());
      captured = undefined;
    };
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
    const frame = () => {
      const s = settings.current;
      const sources = new Map<string, MediaStream>();
      if (s.host) sources.set('host', s.host);
      for (const g of s.guests) if (g.stream) sources.set(g.id, g.stream);
      for (const [id, video] of elements) if (!sources.has(id)) { video.srcObject = null; elements.delete(id); }
      for (const [id, stream] of sources) {
        let video = elements.get(id);
        if (!video) {
          video = document.createElement('video'); video.muted = true; video.playsInline = true;
          elements.set(id, video);
        }
        if (video.srcObject !== stream) { video.srcObject = stream; void video.play().catch(() => undefined); }
      }
      const selected = s.guests.filter((g) => g.onAir).map((g) => g.id);
      const onAir = s.basic ? selected : s.programGuests.filter((id) => sources.has(id));
      const showing = s.basic ? (onAir.length ? 'Panel' : 'Host') : s.program;
      const meterAt = performance.now();
      const sample = !!audio && meterAt - lastMeter > 150;
      const nextLevels: Record<string, number> = {};
      for (const [id, input] of inputs) {
        if (sources.get(id) !== input.stream) { for (const source of input.sources) source.disconnect(); input.meter.disconnect(); input.gain.disconnect(); for (const send of input.sends.values()) send.disconnect(); inputs.delete(id); }
      }
      if (monitorBus) monitorBus.gain.value = s.monitor ? 1 : 0;
      if (audio && destination) for (const [id, stream] of sources) {
        if (!stream.getAudioTracks().length) continue;
        let input = inputs.get(id);
        if (!input) {
          const sources = stream.getAudioTracks().map((track) => audio!.createMediaStreamSource(new MediaStream([track])));
          const meter = audio.createAnalyser(), node = audio.createGain();
          meter.fftSize = 256;
          for (const source of sources) source.connect(meter);
          meter.connect(node).connect(limiter!);
          if (id !== 'host' && monitorBus) meter.connect(monitorBus);
          input = { stream, sources, gain: node, meter, sends: new Map() }; inputs.set(id, input);
        }
        const heard = showing !== 'Break' && (id === 'host' || (showing === 'Panel' && onAir.includes(id)));
        input.gain.gain.value = heard ? (s.gain[id] ?? 1) : 0;
        // Each guest hears the host and other on-air guests, excluding their own microphone.
        for (const [target, send] of input.sends) if (!returnBuses.has(target)) {
          input.meter.disconnect(send); send.disconnect(); input.sends.delete(target);
        }
        for (const [target, bus] of returnBuses) {
          if (target === id) continue;
          let send = input.sends.get(target);
          if (!send) { send = audio.createGain(); input.meter.connect(send).connect(bus); input.sends.set(target, send); }
          send.gain.value = id === 'host' || (onAir.includes(id) && onAir.includes(target)) ? (s.gain[id] ?? 1) : 0;
        }
        if (sample) {
          const samples = new Uint8Array(input.meter.fftSize);
          input.meter.getByteTimeDomainData(samples);
          nextLevels[id] = Math.min(100, Math.sqrt(samples.reduce((sum, value) => sum + (value - 128) ** 2, 0) / samples.length) * 2);
        }
      }
      if (sample) { lastMeter = meterAt; setLevels(nextLevels); }
      const hostVideo = elements.get('host') ?? null;
      const guestVideos = (ids: string[]) => ids.flatMap((id) => elements.get(id) ?? []);
      draw(ctx, showing, s.overlay, hostVideo, guestVideos(onAir));
      const previous = fade.current;
      if (previous) {
        const opacity = 1 - (performance.now() - previous.started) / 500;
        if (opacity > 0) {
          ctx.globalAlpha = opacity;
          ctx.drawImage(previous.frame, 0, 0);
          ctx.globalAlpha = 1;
        } else fade.current = null;
      }
      if (pctx) draw(pctx, s.scene, s.draft, hostVideo, guestVideos(selected));
    };
    const timer = setInterval(frame, 1000 / 30);
    frame();
    return () => { clearInterval(timer); capture.current = null; enableAudio.current = null; context.current = null; stop(); if (audio) void audio.close(); for (const v of elements.values()) v.srcObject = null; elements.clear(); };
  }, [basic, capture]);

  const open = async () => {
    try {
      await enableAudio.current?.();
      ice.current = (await api<{ iceServers: RTCIceServer[] }>('/live/ice')).iceServers;
      const socket = await getSocket();
      const result = await socket.timeout(5000).emitWithAck('live:guest-open', { streamId, basic });
      if (!result.ok) throw new Error('Could not open the green room.');
      const url = `${window.location.origin}/live/join?invite=${result.token}`;
      setInvite(url); setStatus(`Guest invitation ready · ${result.limit} seats`);
    } catch (e) { setStatus((e as Error).message); }
  };

  const take = () => {
    const canvas = output.current;
    if (transition === 'fade' && canvas) {
      const frame = document.createElement('canvas');
      frame.width = canvas.width; frame.height = canvas.height;
      frame.getContext('2d')?.drawImage(canvas, 0, 0);
      fade.current = { frame, started: performance.now() };
    } else fade.current = null;
    setProgram(scene);
    setProgramGuests(guests.filter((g) => g.onAir).map((g) => g.id));
    setOverlay(draft);
  };

  return (
    <section className="space-y-4 rounded-3xl border border-line bg-elevated p-4">
      <div className={basic ? '' : 'grid gap-3 lg:grid-cols-2'}>
        {!basic && <div><h2 className="mb-2 text-xs font-bold uppercase text-brand">Preview</h2><canvas ref={preview} width={1280} height={720} className="aspect-video w-full rounded-xl bg-black" /></div>}
        <div><h2 className="mb-2 text-xs font-bold uppercase text-danger">{active ? 'Program · On air' : 'Program'}</h2><canvas ref={output} width={1280} height={720} className="aspect-video w-full rounded-xl bg-black" /></div>
      </div>
      {!basic && <>
        <div className="flex flex-wrap gap-2" aria-label="Scenes">
          {scenes.map((item) => <button key={item} type="button" aria-pressed={scene === item} className={`${button} ${scene === item ? 'bg-brand-soft text-brand' : ''}`} onClick={() => setScene(item)}>{item}</button>)}
          <button type="button" className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-on-brand" onClick={take}>Take to air</button>
          <select aria-label="Scene transition" value={transition} onChange={(e) => setTransition(e.target.value === 'fade' ? 'fade' : 'cut')} className={button}><option value="cut">Cut</option><option value="fade">Fade · 0.5 s</option></select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Lower third<input className="mt-1 w-full rounded-lg border border-line bg-surface p-2" maxLength={100} value={draft.lower} onChange={(e) => setDraft({ ...draft, lower: e.target.value })} /></label>
          <label className="text-sm">Moving bottom ticker<input className="mt-1 w-full rounded-lg border border-line bg-surface p-2" maxLength={240} value={draft.ticker} onChange={(e) => setDraft({ ...draft, ticker: e.target.value })} /></label>
          <label className="text-sm">Broadcast logo<input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block w-full" onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file || file.size > 2_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setStatus('Choose a PNG, JPEG or WebP logo under 2 MB.'); return; }
            const logo = new Image(), url = URL.createObjectURL(file);
            logo.onload = () => { URL.revokeObjectURL(url); setDraft((previous) => ({ ...previous, logo })); };
            logo.onerror = () => { URL.revokeObjectURL(url); setStatus('Could not read that logo.'); };
            logo.src = url;
          }} /></label>
          <label className="text-sm">Logo position<select className="mt-1 block w-full rounded-lg border border-line bg-surface p-2" value={draft.position} onChange={(e) => setDraft({ ...draft, position: e.target.value === 'right' ? 'right' : 'left' })}><option value="left">Top left</option><option value="right">Top right</option></select></label>
          {draft.logo && <button className={button} type="button" onClick={() => setDraft({ ...draft, logo: null })}>Remove logo from preview</button>}
        </div>
        <section className="space-y-2 rounded-xl bg-surface p-3">
          <h2 className="font-bold">Show rundown</h2>
          <form className="flex flex-wrap gap-2" onSubmit={(event) => {
            event.preventDefault();
            const name = cueName.trim();
            if (!name || rundown.length >= 30) return;
            const id = ++nextCue.current;
            setRundown((cues) => [...cues, { id, name, scene, overlay: draft }]);
            setCueName('');
          }}>
            <input aria-label="Cue name" placeholder="e.g. Opening headlines" className="min-w-0 flex-1 rounded-lg bg-elevated p-2 text-sm" maxLength={80} value={cueName} onChange={(event) => setCueName(event.target.value)} />
            <button className={button} disabled={!cueName.trim() || rundown.length >= 30}>Save preview as cue</button>
          </form>
          {rundown.length > 0 && <ol className="space-y-1">
            {rundown.map((cue, index) => <li className="flex flex-wrap items-center gap-2 text-sm" key={cue.id}>
              <span className="flex-1">{index + 1}. {cue.name} · {cue.scene}</span>
              <button type="button" className={button} onClick={() => { setScene(cue.scene); setDraft(cue.overlay); }}>Load into preview</button>
              <button type="button" className={button} aria-label={`Remove cue ${cue.name}`} onClick={() => setRundown((cues) => cues.filter(({ id }) => id !== cue.id))}>Remove</button>
            </li>)}
          </ol>}
        </section>
        <div className="grid gap-2 sm:grid-cols-3" aria-label="Audio mixer">
          {['host', ...guests.map((g) => g.id)].map((id, index) => <label key={id} className="rounded-xl bg-surface p-3 text-sm">
            {index ? `Guest ${index}` : 'Host audio'}
            <meter aria-label="Audio level" className="block w-full" min={0} max={100} value={levels[id] ?? 0} />
            <input aria-label={index ? `Guest ${index} volume` : 'Host volume'} type="range" className="w-full" min={0} max={1} step={0.05} value={gain[id] ?? 1} onChange={(e) => setGain({ ...gain, [id]: Number(e.target.value) })} />
          </label>)}
        </div>
      </>}
      <div className="space-y-2 rounded-xl bg-surface p-3">
        <h2 className="font-bold">{basic ? 'Co-stream guests · up to 2' : 'Guest green room'}</h2>
        {!invite ? <button type="button" className={button} onClick={() => void open()}>Create guest invite</button> :
          <div className="flex flex-wrap gap-2"><input readOnly aria-label="Guest invitation link" value={invite} className="min-w-0 flex-1 rounded-lg bg-elevated p-2 text-sm" /><button type="button" className={button} onClick={() => void navigator.clipboard.writeText(invite).then(() => setStatus('Invite copied.')).catch(() => setStatus('Select the invitation link to copy it.'))}>Copy invite</button></div>}
        {basic && <button type="button" className={button} aria-pressed={gain.host === 0} onClick={() => setGain({ ...gain, host: gain.host === 0 ? 1 : 0 })}>{gain.host === 0 ? 'Unmute microphone' : 'Mute microphone'}</button>}
        {invite && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={monitor} onChange={(event) => setMonitor(event.target.checked)} />Listen to guests (use headphones)</label>}
        {status && <p role="status" className="text-sm text-muted">{status}</p>}
        {guests.map((g, i) => <div key={g.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="flex-1">Guest {i + 1} · {(basic ? g.onAir : program === 'Panel' && programGuests.includes(g.id)) ? 'In program' : g.onAir ? 'In preview' : g.stream ? 'Ready' : 'Connecting'}</span>
          <button type="button" className={button} disabled={!g.stream} onClick={() => setGuests((all) => all.map((guest) => guest.id === g.id ? { ...guest, onAir: !guest.onAir } : guest))}>{g.onAir ? 'Return to green room' : basic ? 'Add to program' : 'Add to preview'}</button>
          <button type="button" className={button} onClick={() => void getSocket().then((s) => s.emit('live:guest-remove', g.id))}>Remove</button>
        </div>)}
      </div>
    </section>
  );
}
