'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { useShell } from './shell/ShellContext';
import { followersLabel } from '@/lib/format';

/** Follow a channel: its new videos appear in Following. */
export function FollowButton({ handle, initial, initialCount, onCount }: { handle: string; initial: boolean; initialCount: number; onCount?: (n: number) => void }) {
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
      <button type="button" onClick={toggle} disabled={busy} aria-pressed={following} title={following ? `Unfollow (${followersLabel(initialCount, locale)})` : undefined}
        className={`flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold disabled:opacity-60 ${following ? 'bg-surface hover:bg-surface-hover' : 'bg-brand text-on-brand hover:bg-brand-strong'}`}>
        {following ? <Icon.Check size={18} strokeWidth={2.2} /> : <Icon.Plus size={18} strokeWidth={2.2} />}{following ? 'Following' : 'Follow'}
      </button>
      {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
    </div>
  );
}
