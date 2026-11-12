'use client';

import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import styles from './EncoderConnection.module.css';

export interface Encoder { server: string; streamKey: string }
const guides = {
  streamlabs: { name: 'Streamlabs', steps: ['Open Settings → Stream.', 'Choose “Stream to custom ingest” (Custom RTMP).', 'Paste the server URL and stream key below, then save.', 'Start streaming in Streamlabs. Free Me publishes the broadcast automatically.'] },
  obs: { name: 'OBS Studio', steps: ['Open Settings → Stream.', 'Set Service to “Custom”.', 'Paste the server URL and stream key below, then apply.', 'Click Start Streaming in OBS. Free Me publishes the broadcast automatically.'] },
  encoder: { name: 'Other encoder', steps: ['Choose an RTMP/RTMPS streaming destination.', 'Enter the server URL and stream key in separate fields.', 'Use H.264 video, AAC audio and a 2-second keyframe interval.', 'Start your encoder and check the Free Me watch page.'] },
};

export function EncoderConnection({ encoder, live, external, busy, onKey, onPrepare }: {
  encoder: Encoder | null; live: boolean; external: boolean; busy: boolean;
  onKey: (key: string) => void; onPrepare: () => Promise<void>;
}) {
  const [guide, setGuide] = useState<keyof typeof guides>('streamlabs');
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setShow(false); setConfirm(false); }, [encoder?.streamKey]);
  const secure = encoder?.server.startsWith('rtmps://');
  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError(null); setCopied(label); clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    } catch { setError('Clipboard access is unavailable. Select and copy the field manually.'); }
  }
  async function run(action: () => Promise<void>) {
    setWorking(true); setError(null); setSaved(false);
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  return (
    <section aria-labelledby="encoder-connection" className={styles.card}>
      <div className={styles.heading}>
        <span className={styles.icon}><Icon.Monitor size={21} /></span>
        <div><p className={styles.eyebrow}>EXTERNAL ENCODER</p><h2 id="encoder-connection">Connect your streaming software</h2></div>
      </div>
      <div role="status" className={styles.connection} data-live={external}>
        <span className={styles.dot} />
        <div><strong>{external ? 'Encoder connected · On air' : live ? 'Browser broadcast is on air' : encoder ? 'Waiting for your encoder' : 'Encoder connection unavailable'}</strong>
          <p>{external ? 'Open your watch page to verify video and sound. End broadcast also replaces your key to prevent automatic reconnects.' : live ? 'End the current broadcast before connecting another source.' : encoder ? 'Save your title and settings before starting. The broadcast starts publicly when your encoder connects, unless set to unlisted.' : 'Encoder streaming has not been enabled here yet. You can use the browser studio.'}</p></div>
      </div>
      {encoder && <>
        <div className={styles.tabs} role="group" aria-label="Streaming software">
          {Object.entries(guides).map(([id, item]) => <button type="button" key={id} aria-pressed={guide === id} onClick={() => setGuide(id as keyof typeof guides)}>{item.name}</button>)}
        </div>
        <ol className={styles.steps}>{guides[guide].steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <div className={styles.credentials}>
          <label htmlFor="encoder-server">Server URL <span>{secure ? 'RTMPS · Encrypted' : 'RTMP · Unencrypted'}</span></label>
          <div className={styles.field}><input id="encoder-server" aria-label="Server URL" readOnly value={encoder.server} spellCheck={false} onFocus={(e) => e.target.select()} /><button type="button" aria-label="Copy server URL" onClick={() => void copy('server', encoder.server)}><Icon.Copy size={15} />{copied === 'server' ? 'Copied' : 'Copy'}</button></div>
          <label htmlFor="encoder-key">Stream key <span>Private</span></label>
          <div className={styles.field}><input id="encoder-key" aria-label="Stream key" readOnly type={show ? 'text' : 'password'} value={encoder.streamKey} autoComplete="off" spellCheck={false} onFocus={(e) => e.target.select()} /><button type="button" aria-label={show ? 'Hide stream key' : 'Show stream key'} aria-pressed={show} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button><button type="button" aria-label="Copy stream key" onClick={() => void copy('key', encoder.streamKey)}><Icon.Copy size={15} />{copied === 'key' ? 'Copied' : 'Copy'}</button></div>
        </div>
        {!secure && <p className={styles.warning}>This server uses unencrypted RTMP. Ask your administrator to enable RTMPS before broadcasting over public networks.</p>}
        <p className={styles.hint}>Keep your key private. Anyone with it can broadcast on your Space. Paste Free Me credentials here—not a YouTube stream key.</p>
        <details className={styles.presets}><summary>Recommended encoder settings</summary>
          <dl><div><dt>Video / audio</dt><dd>H.264 / AAC, stereo</dd></div><div><dt>Starting preset</dt><dd>720p · 30 fps · 2,500–4,000 kbps</dd></div><div><dt>Keyframes / rate control</dt><dd>2 seconds / CBR</dd></div><div><dt>Audio bitrate</dt><dd>128 kbps · 48 kHz</dd></div></dl>
          <p>Leave upload-speed headroom. Reduce bitrate if your connection drops frames. External encoders send their own finished video; browser graphics do not appear in that feed.</p>
        </details>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={live || busy || working} onClick={() => void run(async () => { await onPrepare(); setSaved(true); })}>{working ? 'Saving…' : 'Save broadcast title'}</button>
          <button type="button" disabled={live || busy || working} onClick={() => setConfirm(!confirm)}>Replace stream key</button>
        </div>
        {confirm && <div className={styles.confirm}><p>Your old key will stop working. Update your encoder with the replacement before streaming again.</p><button type="button" disabled={live || busy || working} onClick={() => void run(async () => { const r = await api<{ streamKey: string }>('/hub/live/key', { body: {} }); onKey(r.streamKey); setConfirm(false); })}>Replace key now</button><button type="button" onClick={() => setConfirm(false)}>Cancel</button></div>}
        {saved && <p role="status" className={styles.success}>Title saved. Start streaming in {guides[guide].name} when ready.</p>}
        <p className={styles.hint}>A direct Streamlabs account connection is not available. Use the custom server option above.</p>
      </>}
      {copied && <span role="status" className="sr-only">{copied === 'key' ? 'Stream key' : 'Server URL'} copied</span>}
      {error && <p role="alert" className={styles.warning}>{error}</p>}
    </section>
  );
}
