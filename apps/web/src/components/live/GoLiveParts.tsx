'use client';

import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';

/**
 * Microphone level: a meter that moves with the host's voice (Web Audio analyser on the stream's audio track), so they
 * can see they are heard before going live. Reports whether any sound arrived, for the pre-flight check.
 */
export function MicMeter({ stream, onSound }: { stream: MediaStream | null; onSound?: (heard: boolean) => void }) {
  const [level, setLevel] = useState(0);
  const heard = useRef(false);
  const report = useRef(onSound);
  report.current = onSound;
  useEffect(() => {
    heard.current = false; report.current?.(false); setLevel(0);
    const track = stream?.getAudioTracks()[0];
    if (!stream || !track) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      setLevel((l) => Math.max(peak, l * 0.85)); // falls back smoothly, like a hardware meter
      if (peak > 0.04 && !heard.current) { heard.current = true; report.current?.(true); }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); source.disconnect(); void ctx.close(); };
  }, [stream]);
  const bars = 16;
  return (
    <div className="flex h-4 items-end gap-[3px]" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      {Array.from({ length: bars }, (_, i) => {
        const on = level * bars * 1.6 > i;
        const color = i >= bars - 3 ? 'bg-[#e5484d]' : i >= bars - 6 ? 'bg-[#f5c46b]' : 'bg-[#2bb5ab]';
        return <span key={i} className={`w-1.5 rounded-sm transition-[height] duration-75 ${on ? color : 'bg-line'}`} style={{ height: `${35 + (i / bars) * 65}%` }} />;
      })}
    </div>
  );
}

/** Cameras and microphones on this device (names appear once the browser has been allowed to use them). */
export function useDevices(ready: boolean) {
  const [devices, setDevices] = useState<{ cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cameras: [], mics: [] });
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const read = () => navigator.mediaDevices.enumerateDevices().then((all) => setDevices({
      cameras: all.filter((d) => d.kind === 'videoinput'), mics: all.filter((d) => d.kind === 'audioinput'),
    })).catch(() => undefined);
    void read();
    navigator.mediaDevices.addEventListener?.('devicechange', read);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', read);
  }, [ready]);
  return devices;
}

/** Connection quality from the encoder's latest response time while live. */
export function Health({ rttMs, reconnecting }: { rttMs: number | null; reconnecting: boolean }) {
  const [label, tone] = reconnecting ? ['Reconnecting', 'text-[#f5c46b]'] : rttMs === null ? ['Waiting for signal', 'text-muted']
    : rttMs < 250 ? ['Excellent', 'text-[#2bb5ab]'] : rttMs < 700 ? ['Good', 'text-[#2bb5ab]'] : rttMs < 1500 ? ['Weak', 'text-[#f5c46b]'] : ['Poor', 'text-[#e5484d]'];
  const strength = reconnecting || rttMs === null ? 0 : rttMs < 250 ? 4 : rttMs < 700 ? 3 : rttMs < 1500 ? 2 : 1;
  return (
    <span className="flex items-center gap-2 text-[13px]" title={rttMs !== null ? `Latest response ${rttMs} ms` : undefined}>
      <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>{[1, 2, 3, 4].map((b) => <span key={b} className={`w-1 rounded-sm ${b <= strength ? 'bg-current' : 'bg-line'} ${tone}`} style={{ height: `${b * 25}%` }} />)}</span>
      <span className="text-muted">Connection</span><b className={tone}>{label}</b>
    </span>
  );
}

/** "End the stream?" with how many people are watching, so a stream is never ended by a stray tap. */
export function EndDialog({ viewers, onCancel, onEnd }: { viewers: number; onCancel: () => void; onEnd: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="presentation" onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="end-title" aria-describedby="end-text" onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-3xl bg-elevated p-6 shadow-2xl">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-[#e5484d]/10 text-[#e5484d]"><Icon.Live size={26} /></span>
        <h2 id="end-title" className="mt-4 font-display text-[20px] font-bold">End the stream?</h2>
        <p id="end-text" className="mt-1 text-[15px] text-muted">{viewers > 0 ? `${viewers.toLocaleString()} ${viewers === 1 ? 'person is' : 'people are'} watching. ` : ''}Viewers see that it has ended; the recording is kept as your settings say.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={onCancel} className="h-10 rounded-xl px-4 text-[14px] font-semibold hover:bg-surface">Keep streaming</button>
          <button type="button" onClick={onEnd} className="h-10 rounded-xl bg-[#e5484d] px-5 text-[14px] font-bold text-white hover:bg-[#d13d42]">End stream</button>
        </div>
      </div>
    </div>
  );
}
