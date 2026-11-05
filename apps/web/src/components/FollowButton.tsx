'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { useShell } from './shell/ShellContext';
import { followersLabel } from '@/lib/format';

/** Tune in to a Space: its new videos appear in Following. */
export function FollowButton({ handle, initial, initialCount, onCount, pill = false }: { handle: string; initial: boolean; initialCount: number; onCount?: (n: number) => void; pill?: boolean }) {
  const { viewer, locale } = useShell();
  const router = useRouter();
  const [following, setFollowing] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (!viewer) { router.push(`/login?returnTo=${encodeURIComponent(`/@${handle}`)}`); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ following: boolean; followerCount: number }>(`/channels/${encodeURIComponent(handle)}/follow`, { method: following ? 'DELETE' : 'POST', body: {} });
      setFollowing(r.following); onCount?.(r.followerCount); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update.'); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={toggle} disabled={busy} aria-pressed={following} title={following ? `Stop tuning in (${followersLabel(initialCount, locale)})` : undefined}
        className={`flex items-center gap-2 font-semibold ${pill ? 'h-9 rounded-full px-4 text-[13px]' : 'h-10 rounded-xl px-4 text-[14px]'} disabled:opacity-60 ${following ? 'bg-surface hover:bg-surface-hover' : 'bg-brand text-on-brand hover:bg-brand-strong'}`}>
        {pill ? null : following ? <Icon.Check size={18} strokeWidth={2.2} /> : <Icon.Plus size={18} strokeWidth={2.2} />}{following ? 'Tuned in' : 'Tune in'}
      </button>
      {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
    </div>
  );
}
