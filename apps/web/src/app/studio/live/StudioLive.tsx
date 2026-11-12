'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { inputClass } from '@/components/Pickers';
import styles from '@/components/live/ControlRoom.module.css';
import { ControlRoom } from '@/components/live/ControlRoom';
import { LiveChat } from '@/components/live/LiveChat';
import { LiveSettings, type LiveStreamSettings } from '@/components/live/LiveSettings';
import { api } from '@/lib/client-api';
import { getSocket, useRealtime } from '@/lib/realtime';
import { useShell } from '@/components/shell/ShellContext';

interface Studio {
  premium: boolean;
  stream: LiveStreamSettings & { status: 'IDLE' | 'LIVE' | 'ENDED'; startedAt: string | null; viewers: number; peakViewers: number };
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
  const [source, setSource] = useState<'camera' | 'screen'>('camera');
  const [media, setMedia] = useState<MediaStream | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'live' | 'ending'>('idle');
  const [reconnectUntil, setReconnectUntil] = useState<number | null>(null);
  const [encoderRtt, setEncoderRtt] = useState<number | null>(null);
  const [viewers, setViewers] = useState(0);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const capture = useRef<(() => Promise<{ stream: MediaStream; stop: () => void }>) | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  useEffect(() => () => { if (recorder.current?.state === 'recording') recorder.current.stop(); }, []);

  const load = useCallback(async () => {
    try { const r = await api<Studio>('/hub/live'); setSt(r); setTitle((t) => t || r.stream.title); setViewers(r.stream.viewers); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useRealtime<{ count: number }>('viewers', (d) => setViewers(d.count), st ? `live:${st.stream.id}` : null, !!st);
  useRealtime('started', () => void load(), st ? `live:${st.stream.id}` : null, !!st);
  useRealtime('ended', () => { setState('idle'); void load(); }, st ? `live:${st.stream.id}` : null, !!st);
  useEffect(() => () => { media?.getTracks().forEach((t) => t.stop()); }, [media]);

  const pick = async (kind: 'camera' | 'screen') => {
    setError(null); setSource(kind);
    media?.getTracks().forEach((t) => t.stop());
    try {
      if (kind === 'camera') setMedia(await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true } }));
      else {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        setMedia(new MediaStream([...screen.getTracks(), ...(mic?.getAudioTracks() ?? [])]));
      }
    } catch { setError(kind === 'camera' ? 'Allow the camera and microphone to go live from this browser.' : 'Screen sharing was not allowed.'); }
  };

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
          if (finishing) finish();
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
  const end = () => { setState('ending'); if (recorder.current?.state === 'recording') { const r = recorder.current; recorder.current = null; r.stop(); } else void api('/hub/live/end', { body: {} }).finally(() => { setState('idle'); void load(); }); };
  const copy = async (what: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ } };

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
  const signal = reconnectUntil !== null && (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-500/40 bg-amber-950 px-4 py-3 text-sm text-amber-100">
      <strong>Reconnecting · {Math.max(0, Math.ceil((reconnectUntil - now) / 1000))}s</strong>
      <span>Your watch page and chat are still open. Keep this tab open while we restore your signal.</span>
    </div>
  );
  const watchUrl = typeof window !== 'undefined' ? `${window.location.origin}/live/${st.stream.id}` : `/live/${st.stream.id}`;

  if (!basic) return (
    <main className={`dark ${styles.studio}`}>
      <header className={styles.top}>
        <div className={styles.identity}>
          <Link href="/" className={styles.brand}><Icon.Live size={17} /> Free Me</Link>
          <h1>Signal Room</h1>
        </div>
        <label className={styles.titleField}>
          <span>Title</span>
          <input className={styles.title} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} disabled={state !== 'idle' || live} />
        </label>
        <div className={styles.status}>
          {reconnectUntil !== null ? <span className={styles.interrupted}>Signal interrupted</span> : live ? <span className={styles.onAir}>● ON AIR {clock(st.stream.startedAt, now)}</span> : <span className={styles.standby}>{media ? 'Source ready' : 'Standby'}</span>}
          {state === 'live' && encoderRtt !== null && <span title="Latest encoder response" className={styles.latency}>Encoder {encoderRtt} ms</span>}
          {live || state === 'live' || state === 'ending' ?
            <button type="button" onClick={end} disabled={state === 'ending'}>{state === 'ending' ? 'Ending…' : 'End broadcast'}</button> :
            <button type="button" onClick={() => void goLive()} disabled={!media || state !== 'idle'}>{state === 'starting' ? 'Starting…' : 'Go live'}</button>}
        </div>
      </header>
      {error && <p role="alert" className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-200">{error}</p>}
      {signal}
      <ControlRoom streamId={st.stream.id} basic={false} host={media} capture={capture} active={state === 'live'}
        chat={<LiveChat streamId={st.stream.id} initial={[]} live={live} className="h-96" />}
        sources={<div className="space-y-3">
          <h3 className="font-bold">Choose your input</h3>
          <div className="flex flex-wrap gap-2">
                <button type="button" disabled={state === 'starting' || state === 'ending'} onClick={() => void pick('camera')} aria-pressed={source === 'camera' && !!media} className={`flex h-10 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold ${source === 'camera' && media ? 'bg-brand-soft text-brand' : 'bg-surface hover:bg-surface-hover'} disabled:opacity-50`}><Icon.Camera size={18} />Camera</button>
                <button type="button" disabled={state === 'starting' || state === 'ending'} onClick={() => void pick('screen')} aria-pressed={source === 'screen' && !!media} className={`flex h-10 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold ${source === 'screen' && media ? 'bg-brand-soft text-brand' : 'bg-surface hover:bg-surface-hover'} disabled:opacity-50`}><Icon.ScreenShare size={18} />Screen</button>

          </div>
          <LiveSettings key={st.stream.id} stream={st.stream} live={live || state === 'live'} onSaved={() => void load()} />
          <section className="rounded-3xl border border-line bg-elevated p-4 sm:p-5">
            <h2 className="flex items-center gap-2 font-display text-[18px] font-bold"><Icon.Monitor size={20} />OBS, TV encoder or camera</h2>
            {st.encoder ? (
              <>
                <p className="mt-1 text-[14px] text-muted">In OBS: Settings → Stream → Service “Custom”, then paste these. Use H.264 video, AAC audio and a keyframe every 2 seconds. You go live as soon as the encoder starts streaming.</p>
                <dl className="mt-3 space-y-2 text-[14px]">
                  <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2"><dt className="w-24 font-semibold">Server</dt><dd className="min-w-0 flex-1 break-all font-mono text-[13px]">{st.encoder.server}</dd><button type="button" onClick={() => void copy('server', st.encoder!.server)} className="flex items-center gap-1 rounded-lg px-2 py-1 font-semibold hover:bg-surface-hover"><Icon.Copy size={16} />{copied === 'server' ? 'Copied' : 'Copy'}</button></div>
                  <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2"><dt className="w-24 font-semibold">Stream key</dt><dd className="min-w-0 flex-1 break-all font-mono text-[13px]">{showKey ? st.encoder.streamKey : '•'.repeat(24)}</dd>
                    <button type="button" onClick={() => setShowKey((s) => !s)} className="rounded-lg px-2 py-1 font-semibold hover:bg-surface-hover">{showKey ? 'Hide' : 'Show'}</button>
                    <button type="button" onClick={() => void copy('key', st.encoder!.streamKey)} className="flex items-center gap-1 rounded-lg px-2 py-1 font-semibold hover:bg-surface-hover"><Icon.Copy size={16} />{copied === 'key' ? 'Copied' : 'Copy'}</button></div>
                </dl>
                <p className="mt-2 text-[12px] text-muted">Keep the key secret: anyone with it can broadcast on your Space. <button type="button" className="font-semibold text-danger hover:underline" onClick={() => void api<{ streamKey: string }>('/hub/live/key', { body: {} }).then((r) => setSt({ ...st, encoder: { ...st.encoder!, streamKey: r.streamKey } })).catch((e) => setError((e as Error).message))}>Make a new key</button></p>
              </>
            ) : <p className="mt-1 text-[14px] text-muted">Streaming from an encoder is not switched on for this server yet (the operator sets LIVE_RTMP_URL; see DEPLOYMENT.md → Live). You can go live from this browser.</p>}
          </section>

          {st.past.length > 0 && (
            <section className="rounded-3xl border border-line bg-elevated p-4 sm:p-5">
              <h2 className="font-display text-[18px] font-bold">Past streams</h2>
              <ul className="mt-2 divide-y divide-line text-[14px]">
                {st.past.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="flex-1 font-semibold">{p.title}</span>
                    <span className="text-muted">{p.startedAt ? new Date(p.startedAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : ''} · peak {p.peakViewers}</span>
                    {p.replayVideoId ? <Link href="/hub" className="font-semibold text-brand">Recording in Creator Hub</Link> : <span className="text-faint">No recording</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] text-muted">Recordings are saved as videos (with English captions) as set in Stream settings. Manage them in Creator Hub.</p>
            </section>
          )}

        </div>} />
      <footer className={styles.footer}>
        <span><Icon.Live size={16} /> Primary feed <strong>{reconnectUntil !== null ? 'Reconnecting' : state === 'live' ? 'Broadcasting' : live ? 'External broadcast' : media ? 'Source ready' : 'No source'}</strong></span>
        <span><Icon.Eye size={16} /> {viewers.toLocaleString(locale)} watching</span>
        <span>Recording <strong>{state === 'live' ? clock(st.stream.startedAt, now) : 'Standby'}</strong></span>
        <a href={watchUrl} target="_blank" rel="noreferrer">Open watch page ↗</a>
      </footer>
    </main>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 pb-16 pt-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex flex-1 items-center gap-2 font-display text-[28px] font-extrabold"><Icon.Live size={28} className={live ? 'text-[#e5484d]' : ''} />Go live</h1>
        {live && <span className="flex items-center gap-2 rounded-full bg-[#e5484d] px-3 py-1.5 text-[13px] font-extrabold uppercase tracking-wide text-white"><span className="h-2 w-2 animate-pulse rounded-full bg-white" />Live · {clock(st.stream.startedAt, now)}</span>}
        {live && <span className="flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-[13px] font-semibold"><Icon.Eye size={16} />{viewers.toLocaleString(locale)} watching</span>}
      </div>
      {error && <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      {st.premium && <Link href="/studio/live" className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-brand"><Icon.Monitor size={16} />Open Signal Room</Link>}

      <div className="mt-5 grid gap-5">
        {signal}
        <div className="space-y-5">
          <section className="overflow-hidden rounded-3xl border border-line bg-elevated">
            <div className="space-y-3 p-4 sm:p-5">
              <label className="block"><span className="text-[13px] font-semibold">Title</span><input className={`mt-1 ${inputClass}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} disabled={state === 'live'} /></label>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={state === 'starting' || state === 'ending'} onClick={() => void pick('camera')} aria-pressed={source === 'camera' && !!media} className={`flex h-10 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold ${source === 'camera' && media ? 'bg-brand-soft text-brand' : 'bg-surface hover:bg-surface-hover'} disabled:opacity-50`}><Icon.Camera size={18} />Camera</button>
                <button type="button" disabled={state === 'starting' || state === 'ending'} onClick={() => void pick('screen')} aria-pressed={source === 'screen' && !!media} className={`flex h-10 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold ${source === 'screen' && media ? 'bg-brand-soft text-brand' : 'bg-surface hover:bg-surface-hover'} disabled:opacity-50`}><Icon.ScreenShare size={18} />Screen</button>
                <span className="ml-auto flex gap-2">
                  {state === 'live' || (live && st.stream.startedAt) ? (
                    <button type="button" onClick={end} disabled={state === 'ending'} className="h-10 rounded-xl bg-[#e5484d] px-5 text-[14px] font-bold text-white disabled:opacity-60">{state === 'ending' ? 'Ending…' : 'End stream'}</button>
                  ) : (
                    <button type="button" onClick={() => void goLive()} disabled={!media || state !== 'idle'} className="flex h-10 items-center gap-2 rounded-xl bg-[#e5484d] px-5 text-[14px] font-bold text-white disabled:opacity-50">{state === 'starting' && <Icon.Spinner size={16} className="animate-spin" />}Go live</button>
                  )}
                </span>
              </div>
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">Viewers watch at <a href={watchUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand">{watchUrl.replace(/^https?:\/\//, '')}</a><button type="button" onClick={() => void copy('link', watchUrl)} className="rounded-lg px-2 py-0.5 font-semibold hover:bg-surface">{copied === 'link' ? 'Copied' : 'Copy'}</button></p>
            </div>
          </section>

          <LiveSettings key={st.stream.id} stream={st.stream} live={live || state === 'live'} onSaved={() => void load()} />
          <ControlRoom streamId={st.stream.id} basic host={media} capture={capture} active={state === 'live'} />

        </div>
      </div>
    </div>
  );
}
