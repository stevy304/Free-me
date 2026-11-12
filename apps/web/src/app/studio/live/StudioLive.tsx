'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { Dialog } from '@/components/Dialog';
import { useLiveDevices } from '@/components/live/useLiveDevices';
import desk from '@/components/live/StudioWorkspace.module.css';
import { ControlRoom } from '@/components/live/ControlRoom';
import { LiveChat, LiveVideo } from '@/components/live/LiveChat';
import { StreamHealth, type StreamHealthData } from '@/components/live/StreamHealth';
import { EncoderConnection } from '@/components/live/EncoderConnection';
import { LiveSettings, type LiveStreamSettings } from '@/components/live/LiveSettings';
import { api } from '@/lib/client-api';
import { getSocket, useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';

interface Studio {
  premium: boolean;
  stream: LiveStreamSettings & { status: 'IDLE' | 'PREVIEW' | 'LIVE' | 'ENDED'; startedAt: string | null; viewers: number; peakViewers: number; source: string | null; playbackUrl: string | null };
  privatePreviewUrl: string | null;
  ingest: StreamHealthData;
  encoder: { server: string; streamKey: string } | null;
  past: Array<{ id: string; title: string; startedAt: string | null; endedAt: string | null; peakViewers: number; replayVideoId: string | null }>;
}
const MAX_BUFFER_BYTES = 12 * 1024 * 1024;
const TYPES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
const clock = (from: string | null, now: number) => { if (!from) return '0:00'; const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`; };

/** Live Studio (Premium): go live from this browser (camera or screen), or from OBS, a TV encoder or a camera with the stream key. */
export function StudioLive({ basic = false }: { basic?: boolean }) {
  const { locale } = useShell();
  const [st, setSt] = useState<Studio | null>(null);
  const [title, setTitle] = useState('');
  const [state, setState] = useState<'idle' | 'starting' | 'live' | 'ending'>('idle');
  const [reconnectUntil, setReconnectUntil] = useState<number | null>(null);
  const [encoderRtt, setEncoderRtt] = useState<number | null>(null);
  const [viewers, setViewers] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const devices = useLiveDevices(setError);
  const { media } = devices;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'details' | 'encoder' | 'history'>('details');
  const [now, setNow] = useState(Date.now());
  const capture = useRef<(() => Promise<{ stream: MediaStream; stop: () => void }>) | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  useEffect(() => () => { if (recorder.current?.state === 'recording') recorder.current.stop(); }, []);

  const load = useCallback(async () => {
    try { const r = await api<Studio>('/hub/live'); setSt(r); setTitle((t) => t || r.stream.title); setViewers(r.stream.viewers); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous; }; }, []);
  // Polling also catches encoder starts/ends when a socket event is missed.
  useEffect(() => { const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [basic, load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useRealtime<{ count: number }>('viewers', (d) => setViewers(d.count), st ? `live:${st.stream.id}` : null, !!st);
  useRealtime('started', () => void load(), st ? `live:${st.stream.id}` : null, !!st);
  useRealtime('ended', () => { if (recorder.current?.state === 'recording') recorder.current.stop(); setState('idle'); void load(); }, st ? `live:${st.stream.id}` : null, !!st);
  useEffect(() => {
    if (st?.stream.source === 'rtmp' && (st.stream.status === 'PREVIEW' || st.stream.status === 'LIVE')) devices.disconnect();
    // Device ownership is independent of studio polling; disconnect once when an external encoder takes over.
  }, [st?.stream.source, st?.stream.status]);

  const goLive = async () => {
    if (!st || !media || !capture.current) return;
    const streamId = st.stream.id;
    setError(null); setEncoderRtt(null); setState('starting');
    let output: Awaited<ReturnType<NonNullable<typeof capture.current>>> | undefined;
    try {
      output = await capture.current();
      const stopOutput = output.stop;
      if (title.trim() && title.trim() !== st.stream.title) await api('/hub/live', { method: 'PATCH', body: { title: title.trim() } });
      const sock = await getSocket();
      const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(output.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
      const r = await sock.timeout(15_000).emitWithAck('live:start', streamId);
      if (!r.ok) throw new Error(r.error ?? 'The stream could not start.');
      const pending: Blob[] = [];
      let queued = 0;
      let sequence = 0;
      let pumping = false;
      let needsResume = false;
      let deadline: number | null = null;
      let finishing = false;
      let finishDeadline = 0;
      let finished = false;
      let failed = false;
      let retry: ReturnType<typeof setTimeout> | undefined;

      function failStream(message: string) {
        failed = true;
        setError(message);
        if (rec.state === 'recording') rec.stop();
        else if (finishing) finish();
      }

      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(retry);
        sock.off('disconnect', disconnected);
        sock.off('connect', pump);
        setReconnectUntil(null);
        stopOutput();
        if (recorder.current === rec) recorder.current = null;
        const stop = sock.connected && !needsResume
          ? sock.timeout(30_000).emitWithAck('live:stop', streamId)
          : api('/hub/live/end', { body: {} });
        void stop.catch(() => undefined).finally(() => { setState('idle'); void load(); });
      }

      function disconnected() {
        if (finishing) { finish(); return; }
        needsResume = true;
        deadline ??= Date.now() + r.reconnectMs;
        setNow(Date.now());
        setReconnectUntil(deadline);
        setEncoderRtt(null);
        void pump();
      }

      async function pump() {
        if (pumping || failed || finished) return;
        clearTimeout(retry);
        if (deadline !== null && Date.now() >= deadline) {
          failStream('The signal did not return in time. Go live again when your connection is stable.');
          return;
        }
        pumping = true;
        let delay = 250;
        try {
          if (!sock.connected) return;
          if (needsResume) {
            const socketId = sock.id;
            const resumed = await sock.timeout(2500).emitWithAck('live:resume', [streamId, r.resumeKey]);
            if (!resumed?.ok || sock.id !== socketId || !sock.connected || finished) return;
            needsResume = false;
          }
          while (pending.length && sock.connected && !needsResume && !failed) {
            const blob = pending[0];
            const data = await blob.arrayBuffer();
            if (!sock.connected || needsResume || failed || finished) break;
            const sentAt = performance.now();
            const result = await sock.timeout(2500).emitWithAck('live:chunk', [streamId, sequence, data]);
            if (finished) break;
            if (!result?.ok) {
              if (result?.retry) break;
              if (!needsResume) failStream('The encoder stopped accepting video. Check the connection and go live again.');
              break;
            }
            pending.shift();
            queued -= blob.size;
            sequence += 1;
            if (!needsResume) {
              deadline = null;
              setReconnectUntil(null);
              setEncoderRtt(Math.round(performance.now() - sentAt));
            }
          }
        } catch {
          // Keep the unacknowledged chunk. Its sequence makes resending safe.
          if (!finishing && !finished) {
            needsResume = true;
            deadline ??= Date.now() + r.reconnectMs;
            setNow(Date.now());
            setReconnectUntil(deadline);
          }
          delay = 500;
        } finally {
          pumping = false;
          if (finishing && (failed || !pending.length || Date.now() >= finishDeadline)) finish();
          else if (!failed && !finished && (pending.length || deadline !== null)) retry = setTimeout(pump, delay);
        }
      }

      rec.ondataavailable = ({ data }) => {
        if (!data.size || failed) return;
        queued += data.size;
        if (queued > MAX_BUFFER_BYTES) {
          failStream('The connection could not keep up and the signal buffer filled. Go live again on a stronger connection.');
          return;
        }
        pending.push(data);
        void pump();
      };
      rec.onstop = () => {
        finishing = true;
        finishDeadline = Date.now() + 15_000;
        if (failed || !sock.connected || deadline !== null) finish();
        else void pump();
      };
      try { rec.start(1000); }
      catch (error) {
        await sock.timeout(30_000).emitWithAck('live:stop', streamId).catch(() => undefined);
        throw error;
      }
      sock.on('disconnect', disconnected);
      sock.on('connect', pump);
      if (!sock.connected) disconnected();
      recorder.current = rec;
      setState('live');
      void load();
    } catch (e) { output?.stop(); setError((e as Error).message); setState('idle'); }
  };
  const publishEncoder = async () => {
    setState('starting'); setError(null);
    try { const next = await api<Studio>('/hub/live/publish', { body: {} }); setSt(next); }
    catch (e) { setError((e as Error).message); }
    finally { setState('idle'); }
  };
  const end = () => { setState('ending'); setError(null); if (recorder.current?.state === 'recording') recorder.current.stop(); else void api('/hub/live/end', { body: {} }).catch((e) => setError((e as Error).message)).finally(() => { setState('idle'); void load(); }); };
  const copy = async (what: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { setError('Clipboard access is unavailable. Select and copy the link manually.'); } };

  if (!st) return error ? <p role="alert" className="mx-auto mt-10 max-w-xl rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" />;
  if (!basic && !st.premium) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <section className="flex flex-col items-center gap-4 rounded-[28px] bg-[#071312] px-6 py-10 text-center text-white">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-[#e5484d]"><Icon.Live size={34} /></span>
          <h1 className="font-display text-[30px] font-extrabold">Signal Room is part of Premium</h1>
          <p className="max-w-md text-[15px] text-[#c9d6d4]">Go live from your browser, or from OBS, a TV encoder or a camera. Your followers are told, viewers chat, and the recording is kept as a video.</p>
          <Link href="/go-live" className="font-semibold text-white underline">Go live from your browser for free</Link>
          <Link href="/premium" className="flex h-11 items-center gap-2 rounded-2xl bg-gradient-to-r from-[#f5b95c] to-[#e39a2a] px-5 text-[14px] font-bold text-[#2a1a02]"><Icon.PremiumStar size={18} filled />Upgrade</Link>
        </section>
      </div>
    );
  }
  const live = st.stream.status === 'LIVE';
  const watchUrl = typeof window !== 'undefined' ? `${window.location.origin}/live/${st.stream.id}` : `/live/${st.stream.id}`;

  const preview = st.stream.status === 'PREVIEW';
  const external = (live || preview) && st.stream.source === 'rtmp';
  const openSettings = (tab: typeof settingsTab = 'details') => { setSettingsTab(tab); setSettingsOpen(true); };
  const devicePanel = <div className={desk.deviceFields}>
    <h3 className="text-base font-bold">Camera and microphone</h3>
    <p>Connect a webcam, USB capture card, or a phone configured as a virtual webcam. Grant camera and microphone permission when your browser asks.</p>
    <label>Camera device<select aria-label="Camera device" value={devices.cameraId} disabled={devices.busy} onChange={(e) => void devices.connect(true, e.target.value, devices.microphoneId, !media || !!media.getAudioTracks().length)}>
      <option value="">System default camera</option>{devices.devices.filter((d) => d.kind === 'videoinput').map((d, i) => <option key={`${d.deviceId}-${i}`} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
    </select></label>
    <label>Microphone device<select aria-label="Microphone device" value={devices.microphoneId} disabled={devices.busy} onChange={(e) => void devices.connect(!!media?.getVideoTracks().length, devices.cameraId, e.target.value)}>
      <option value="">System default microphone</option>{devices.devices.filter((d) => d.kind === 'audioinput').map((d, i) => <option key={`${d.deviceId}-${i}`} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
    </select></label>
    <div className={desk.deviceActions}>
      <button type="button" disabled={devices.busy} onClick={() => void devices.connect()}>{devices.busy ? 'Connecting…' : 'Connect camera and microphone'}</button>
      <button type="button" disabled={devices.busy} onClick={() => void devices.connect(true, devices.cameraId, devices.microphoneId, false)}>Camera only</button>
      <button type="button" disabled={devices.busy} onClick={() => void devices.connect(false)}>Microphone only</button>
      <button type="button" onClick={() => void devices.refresh()}>Refresh devices</button>
      <button type="button" disabled={!media || state !== 'idle'} onClick={devices.disconnect}>Disconnect devices</button>
    </div>
    <p>HDMI cameras need a USB capture card. Network/RTSP cameras can connect through OBS or Streamlabs using the encoder setup. Bluetooth microphones appear here when supported by your operating system.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
  const browserHealth = <>
    <h2><Icon.Live size={18} />Stream health</h2>
    <dl>
      <div><dt>Camera input</dt><dd>{devices.info?.width && devices.info.height ? `${devices.info.width} × ${devices.info.height}` : 'Not connected'}</dd></div>
      <div><dt>Frame rate</dt><dd>{devices.info?.frameRate ? `${Math.round(devices.info.frameRate)} fps` : 'Not measured'}</dd></div>
      <div><dt>Microphone</dt><dd>{devices.microphoneOn ? 'Active' : 'Off'}</dd></div>
      <div><dt>Encoder response</dt><dd>{encoderRtt !== null ? `${encoderRtt} ms` : 'Not broadcasting'}</dd></div>
    </dl>
    <p>{reconnectUntil ? 'Signal interrupted. Keep this tab open while the connection returns.' : state === 'live' ? 'Browser program is broadcasting. Check the watch page for viewer playback.' : 'Private rehearsal. No video is being sent to viewers.'}</p>
  </>;

  return (
    <main className={`dark ${desk.shell}`} data-testid="live-studio">
      <header className={desk.header}>
        <Link href="/" className={desk.brand} aria-label="Free Me home"><Icon.Play size={30} /><span>Free Me</span></Link>
        <h1>Go Live</h1>
        <label className={desk.title}><span className="sr-only">Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="Name your broadcast" disabled={state !== 'idle' || live} /><Icon.Pencil size={16} /></label>
        <span className={`${desk.badge} ${live ? desk.onAir : ''}`}>{reconnectUntil ? 'Reconnecting' : live ? `● ON AIR ${clock(st.stream.startedAt, now)}` : '● Private preview'}</span>
        <button type="button" className={desk.settings} onClick={() => openSettings()}><Icon.Settings size={19} /><span>Settings</span></button>
        {live || state === 'live' || state === 'ending' ? <button type="button" className={`${desk.go} ${desk.stop}`} disabled={state === 'ending'} onClick={end}>{state === 'ending' ? 'Ending…' : 'End broadcast'}</button> : <button type="button" className={desk.go} disabled={state !== 'idle' || (preview ? !st.ingest.ready : !media || devices.busy)} onClick={() => void (preview ? publishEncoder() : goLive())}><Icon.Live size={18} />{state === 'starting' ? 'Starting…' : 'Go live'}</button>}
        {preview && <button type="button" onClick={end} className="text-xs font-semibold">End preview</button>}
      </header>
      {error && !settingsOpen && <p role="alert" className={desk.notice}>{error}</p>}
      {reconnectUntil && <div role="status" className={desk.notice}>Reconnecting · {Math.max(0, Math.ceil((reconnectUntil - now) / 1000))}s — Keep this tab open.</div>}
      <div className={desk.body}>
        <nav className={desk.rail} aria-label="Studio navigation">
          <Link href="/" aria-label="Home" title="Home"><Icon.Home size={23} /></Link>
          <Link href="/hub" aria-label="Creator Hub" title="Creator Hub"><Icon.Videos size={23} /></Link>
          <span className={desk.selected} aria-label="Go Live" title="Go Live"><Icon.Live size={24} /></span>
          {st.premium && <button type="button" aria-label="Encoder setup" title="Streamlabs / OBS" onClick={() => openSettings('encoder')}><Icon.Monitor size={23} /></button>}
          <Link href="/live" aria-label="Browse live streams" title="Browse live"><Icon.Person size={23} /></Link>
          <button type="button" aria-label="Broadcast settings" title="Settings" onClick={() => openSettings()}><Icon.Settings size={23} /></button>
        </nav>
        <ControlRoom streamId={st.stream.id} basic={basic} host={media} capture={capture} active={state === 'live'} sources={devicePanel}
          cameraOn={devices.cameraOn} microphoneOn={devices.microphoneOn} deviceBusy={devices.busy} onCameraToggle={devices.toggleCamera} onMicrophoneToggle={devices.toggleMicrophone}
          external={external} externalPreview={st.privatePreviewUrl ? <LiveVideo src={st.privatePreviewUrl} muted className="h-full w-full" /> : null}
          health={external ? <StreamHealth health={st.ingest} /> : browserHealth}
          chat={<LiveChat key={st.stream.id} streamId={st.stream.id} initial={[]} live={live} rules={st.stream.chat} className="h-full" />} />
      </div>
      <footer className={desk.footer}>
        <span><Icon.Live size={15} />{reconnectUntil ? 'Signal interrupted' : live ? 'Broadcasting' : 'Private rehearsal · Not broadcasting'}</span>
        <span><Icon.Eye size={15} />{viewers.toLocaleString(locale)} watching</span>
        <button type="button" onClick={() => void copy('link', watchUrl)}>{copied === 'link' ? 'Watch link copied' : 'Copy watch link'}</button>
        <a href={watchUrl} target="_blank" rel="noreferrer">Open watch page ↗</a>
        <span><Icon.Monitor size={15} />Replay {st.stream.saveReplay ? 'enabled' : 'off'}</span>
      </footer>
      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Broadcast settings" wide>
        <nav className={desk.toolTabs} aria-label="Broadcast settings tabs">
          <button type="button" aria-pressed={settingsTab === 'details'} onClick={() => setSettingsTab('details')}>Details</button>
          {st.premium && <><button type="button" aria-pressed={settingsTab === 'encoder'} onClick={() => setSettingsTab('encoder')}>Streamlabs / OBS</button><button type="button" aria-pressed={settingsTab === 'history'} onClick={() => setSettingsTab('history')}>Past streams</button></>}
        </nav>
        {settingsTab === 'details' && <LiveSettings key={st.stream.id} stream={st.stream} live={live || state === 'live'} onSaved={() => void load()} />}
        {settingsTab === 'encoder' && st.premium && <EncoderConnection encoder={st.encoder} live={live || state !== 'idle'} external={live && external} preview={preview} busy={devices.busy}
          onKey={(streamKey) => setSt((current) => current?.encoder ? { ...current, encoder: { ...current.encoder, streamKey } } : current)}
          onPrepare={async () => { if (!title.trim()) throw new Error('Enter a broadcast title first.'); await api('/hub/live', { method: 'PATCH', body: { title: title.trim() } }); await load(); }} />}
        {settingsTab === 'history' && <div className="space-y-3 py-2">{st.past.length ? st.past.map((p) => <div key={p.id} className="rounded-xl border border-line p-3"><strong>{p.title}</strong><p className="mt-1 text-xs text-muted">{p.startedAt ? new Date(p.startedAt).toLocaleString(locale) : ''} · Peak {p.peakViewers}</p>{p.replayVideoId && <Link href="/hub" className="mt-2 inline-block text-sm text-brand">Recording in Creator Hub</Link>}</div>) : <p className="text-muted">Your past broadcasts will appear here.</p>}</div>}
      </Dialog>
    </main>
  );
}
