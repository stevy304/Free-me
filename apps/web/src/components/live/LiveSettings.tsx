'use client';

import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';
import { getSocket } from '@/lib/realtime';
import { HostPoll } from './LivePoll';

export interface LiveStreamSettings {
  id: string; title: string; description: string | null; visibility: 'PUBLIC' | 'UNLISTED'; scheduledFor: string | null;
  chat: { mode: 'everyone' | 'followers' | 'off'; slowModeSeconds: number }; captionsEnabled: boolean;
  saveReplay?: boolean; replayVisibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; latencyMode?: 'normal' | 'low';
}

const SLOW = [0, 5, 10, 30, 60, 120];
/** "2026-11-20T18:30:00.000Z" → the value a datetime-local input shows, in the viewer's time zone. */
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

/**
 * The host's settings for a stream: what viewers see (title, description, who can find it, when it starts), how chat
 * works (everyone, followers only or off; slow mode), live captions, and what happens to the recording. Title and
 * chat rules can change during the stream; viewers see the change at once.
 */
export function LiveSettings({ stream, live, onSaved }: { stream: LiveStreamSettings; live: boolean; onSaved: () => void }) {
  const [f, setF] = useState(() => ({
    description: stream.description ?? '', visibility: stream.visibility, scheduledFor: toLocalInput(stream.scheduledFor),
    chatMode: stream.chat.mode, slowModeSeconds: stream.chat.slowModeSeconds, captionsEnabled: stream.captionsEnabled,
    saveReplay: stream.saveReplay ?? true, replayVisibility: stream.replayVisibility ?? 'PRIVATE', latencyMode: stream.latencyMode ?? 'normal',
  }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setNote(null); };

  const save = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const { scheduledFor, visibility, ...editable } = f;
      await api('/hub/live', { method: 'PATCH', body: { ...editable, ...(!live ? { visibility, scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null } : {}) } });
      setNote(live ? 'Saved. Viewers see the change now.' : 'Saved.'); onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const label = 'text-[13px] font-semibold';
  const select = `mt-1 ${inputClass}`;

  return (
    <section aria-labelledby="live-settings" className="rounded-3xl border border-line bg-elevated p-4 sm:p-5">
      <h2 id="live-settings" className="flex items-center gap-2 font-display text-[18px] font-bold"><Icon.Settings size={20} />Stream settings</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2"><span className={label}>Description</span>
          <textarea className={`mt-1 min-h-[84px] ${inputClass} py-2`} value={f.description} maxLength={2000} onChange={(e) => set('description', e.target.value)} placeholder="What this stream is about, links, who is on" />
        </label>
        <label className="block"><span className={label}>Who can find it</span>
          <select className={select} value={f.visibility} onChange={(e) => set('visibility', e.target.value as typeof f.visibility)} disabled={live}>
            <option value="PUBLIC">Public: on Live, followers are told</option>
            <option value="UNLISTED">Unlisted: only people with the link</option>
          </select>
        </label>
        <label className="block"><span className={label}>Planned start (optional)</span>
          <input type="datetime-local" className={`mt-1 ${inputClass}`} value={f.scheduledFor} onChange={(e) => set('scheduledFor', e.target.value)} disabled={live} />
        </label>
        <label className="block sm:col-span-2"><span className={label}>Delay for viewers</span>
          <select className={select} value={f.latencyMode} onChange={(e) => set('latencyMode', e.target.value as typeof f.latencyMode)} disabled={live}>
            <option value="normal">Normal: about 10–15 seconds, steadiest on weak connections</option>
            <option value="low">Low latency: about 4–6 seconds, for talking with chat</option>
          </select>
          {live && <span className="mt-1 block text-[12px] text-muted">Change it before you go live.</span>}
        </label>
        <label className="block"><span className={label}>Who can chat</span>
          <select className={select} value={f.chatMode} onChange={(e) => set('chatMode', e.target.value as typeof f.chatMode)}>
            <option value="everyone">Everyone signed in</option>
            <option value="followers">Followers only</option>
            <option value="off">Nobody (chat off)</option>
          </select>
        </label>
        <label className="block"><span className={label}>Slow mode</span>
          <select className={select} value={f.slowModeSeconds} onChange={(e) => set('slowModeSeconds', Number(e.target.value))} disabled={f.chatMode === 'off'}>
            {SLOW.map((s) => <option key={s} value={s}>{s ? `One message every ${s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`}` : 'Off'}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-3 rounded-2xl bg-surface p-3 sm:col-span-2">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={f.captionsEnabled} onChange={(e) => set('captionsEnabled', e.target.checked)} />
          <span><span className={label}>Live captions</span><span className="block text-[13px] text-muted">Viewers can turn on captions of what you say. Start them below once you are live.</span></span>
        </label>
        <label className="flex items-start gap-3 rounded-2xl bg-surface p-3">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={f.saveReplay} onChange={(e) => set('saveReplay', e.target.checked)} />
          <span><span className={label}>Keep the recording</span><span className="block text-[13px] text-muted">Saved as a video afterwards, with automatic captions.</span></span>
        </label>
        <label className="block"><span className={label}>The recording starts as</span>
          <select className={select} value={f.replayVisibility} onChange={(e) => set('replayVisibility', e.target.value as typeof f.replayVisibility)} disabled={!f.saveReplay}>
            <option value="PRIVATE">Private (publish it later)</option>
            <option value="UNLISTED">Unlisted</option>
            <option value="PUBLIC">Public replay</option>
          </select>
        </label>
      </div>
      {error && <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => void save()} className="flex h-10 items-center gap-2 rounded-xl bg-brand px-5 text-[14px] font-bold text-on-brand disabled:opacity-50">{busy && <Icon.Spinner size={16} className="animate-spin" />}Save settings</button>
        {note && <span role="status" className="text-[13px] font-semibold text-brand">{note}</span>}
      </div>
      {f.captionsEnabled && <HostCaptions streamId={stream.id} live={live} />}
      <HostPoll streamId={stream.id} live={live} />
    </section>
  );
}

type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };

/**
 * Live captions from the host's browser: the Web Speech API turns the microphone's speech into English text, which is
 * sent to viewers as caption lines. Chrome and Edge support it (they use their speech service for this). The
 * recording also gets automatic English captions afterwards, from the media server.
 */
function HostCaptions({ streamId, live }: { streamId: string; live: boolean }) {
  const [on, setOn] = useState(false);
  const [lang, setLang] = useState('en-US');
  const [last, setLast] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const Speech = typeof window !== 'undefined' ? ((window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition) : undefined;

  useEffect(() => {
    wanted.current = on && live;
    if (!wanted.current || !Speech) { rec.current?.abort(); rec.current = null; return; }
    const r = new Speech();
    r.lang = lang; r.continuous = true; r.interimResults = true;
    let sentAt = 0;
    r.onresult = (e) => {
      let text = ''; let final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) { text += e.results[i][0].transcript; final ||= e.results[i].isFinal; }
      text = text.trim();
      if (!text) return;
      setLast(text);
      // Interim words at most 3 times a second; finished sentences always.
      if (!final && Date.now() - sentAt < 330) return;
      sentAt = Date.now();
      void getSocket().then((s) => s.emit('live:caption', { streamId, text, final }));
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setProblem('The browser did not allow the microphone for captions.'); setOn(false); } };
    // Recognition stops by itself after silence: start again while captions are on.
    r.onend = () => { if (wanted.current && rec.current === r) { try { r.start(); } catch { /* already started */ } } };
    rec.current = r;
    try { r.start(); } catch { /* starting twice */ }
    return () => { wanted.current = false; r.onend = null; r.abort(); };
  }, [on, live, lang, streamId, Speech]);

  return (
    <div className="mt-4 rounded-2xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 font-semibold"><span className="rounded bg-strong px-1.5 text-[11px] font-extrabold text-on-strong">CC</span>Caption my voice</span>
        <select aria-label="Caption language" className="h-9 rounded-xl border border-line bg-bg px-2 text-[14px] outline-none focus:border-brand" value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="en-US">English (US)</option>
          <option value="en-GB">English (UK)</option>
        </select>
        <button type="button" disabled={!Speech || !live} onClick={() => { setProblem(null); setOn((x) => !x); }} aria-pressed={on}
          className={`ml-auto h-9 rounded-xl px-4 text-[13px] font-bold disabled:opacity-50 ${on ? 'bg-[#e5484d] text-white' : 'bg-brand text-on-brand'}`}>{on ? 'Stop captions' : 'Start captions'}</button>
      </div>
      <p className="mt-2 text-[12px] text-muted">
        {!Speech ? 'Live captions need Chrome or Edge on this computer.' : !live ? 'Available once you are live.' : on ? <>Sending: <span className="text-ink">{last || 'listening…'}</span></> : 'Uses this computer’s microphone and your browser’s speech service.'}
      </p>
      {problem && <p role="alert" className="mt-1 text-[12px] text-danger">{problem}</p>}
    </div>
  );
}
