'use client';

import { useEffect, useState } from 'react';
import { type PushState, pushState, sendTestPush, turnOffPush, turnOnPush } from '@/lib/push';
import { type DataSaver, getDataSaver, setDataSaver } from '@/lib/datasaver';

const PUSH_TEXT: Record<PushState, string> = {
  on: 'On: new videos and lives from Spaces you follow, and replies to you, appear on this device.',
  off: 'Off on this device.',
  blocked: 'Blocked in this browser’s site settings. Allow notifications for this site there, then come back.',
  unsupported: 'This browser cannot show notifications. On iPhone, add Free Me to the Home Screen first (Share → Add to Home Screen) and open it from there.',
};

/** Settings that belong to this phone or computer: notifications and data saver. */
export function DeviceSettings() {
  const [push, setPush] = useState<PushState | null>(null);
  const [saver, setSaver] = useState<DataSaver>('auto');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { void pushState().then(setPush); setSaver(getDataSaver()); }, []);
  const change = async (on: boolean) => {
    setBusy(true); setMsg(null);
    try { setPush(on ? await turnOnPush() : await turnOffPush()); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-[15px] font-medium">Notifications on this device</p>
          {push === 'on' && <button type="button" onClick={() => void sendTestPush().then((r) => setMsg(r.devices ? 'Test sent. It should appear in a few seconds.' : 'No device is set up yet.')).catch((e) => setMsg((e as Error).message))} className="h-9 rounded-xl px-3 text-[13px] font-semibold text-brand hover:bg-surface">Send a test</button>}
          {(push === 'on' || push === 'off') && (
            <button type="button" role="switch" aria-checked={push === 'on'} disabled={busy} onClick={() => void change(push !== 'on')}
              className={`relative h-7 w-12 rounded-full transition-colors disabled:opacity-50 ${push === 'on' ? 'bg-brand' : 'bg-line'}`} aria-label="Notifications on this device">
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${push === 'on' ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          )}
        </div>
        {push && <p className="mt-1 text-[13px] text-muted">{PUSH_TEXT[push]}</p>}
        {msg && <p role="status" className="mt-2 text-[13px] text-brand">{msg}</p>}
      </div>
      <div>
        <p className="text-[15px] font-medium">Data saver</p>
        <p className="mt-1 text-[13px] text-muted">Plays videos at 360p at most (you can still choose a higher quality in the player). Use “Sound only” in the player for music and podcasts.</p>
        <div className="mt-3 inline-flex rounded-xl bg-surface p-1" role="radiogroup" aria-label="Data saver">
          {([['auto', 'Automatic'], ['on', 'Always'], ['off', 'Off']] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={saver === v} onClick={() => { setDataSaver(v); setSaver(v); }}
              className={`h-9 rounded-lg px-4 text-[13px] font-semibold ${saver === v ? 'bg-elevated shadow-sm' : 'text-muted hover:text-ink'}`}>{l}</button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-muted">Automatic: on when your phone is set to save data or the connection is slow.</p>
      </div>
    </div>
  );
}
