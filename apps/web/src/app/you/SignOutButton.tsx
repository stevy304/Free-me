'use client';

import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';

export function SignOutButton({ className }: { className: string }) {
  return (
    <button type="button" className={className} onClick={async () => { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined); window.location.href = '/'; }}>
      <Icon.SignOut size={22} strokeWidth={1.6} /><span className="flex-1">Sign out</span>
    </button>
  );
}
