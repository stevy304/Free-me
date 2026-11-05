'use client';

import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client-api';
import { useShell } from './shell/ShellContext';
import { subscribersLabel } from '@/lib/format';

export function SubscribeButton({ handle, initial, initialCount, onCount }: { handle: string; initial: boolean; initialCount: number; onCount?: (n: number) => void }) {
  const { viewer, locale } = useShell();
  const router = useRouter();
  const [subscribed, setSubscribed] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (!viewer) { router.push(`/login?returnTo=${encodeURIComponent(`/@${handle}`)}`); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ subscribed: boolean; subscriberCount: number }>(`/channels/${encodeURIComponent(handle)}/subscription`, { method: subscribed ? 'DELETE' : 'POST', body: {} });
      setSubscribed(r.subscribed); onCount?.(r.subscriberCount); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update.'); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={toggle} disabled={busy} aria-pressed={subscribed} title={subscribed ? `Unsubscribe (${subscribersLabel(initialCount, locale)})` : undefined}
        className={`flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium disabled:opacity-60 ${subscribed ? 'bg-surface hover:bg-surface-hover' : 'bg-strong text-on-strong hover:opacity-90'}`}>
        {subscribed && <Bell size={18} strokeWidth={1.8} />}{subscribed ? 'Subscribed' : 'Subscribe'}
      </button>
      {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
    </div>
  );
}
