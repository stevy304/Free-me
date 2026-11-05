import { ChevronRight, Settings, Shield, SquarePlay, UserPlus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { getViewer } from '@/lib/server-api';
import { SignOutButton } from './SignOutButton';

export const metadata: Metadata = { title: 'You' };

export default async function You() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Enjoy your favourite videos</h1>
        <p className="mt-2 text-[15px] text-muted">Sign in to subscribe to channels and keep your settings on every device.</p>
        <Link href="/login?returnTo=/you" className="mt-6 inline-flex h-10 items-center rounded-full border border-line px-5 text-[14px] font-medium text-brand">Sign in</Link>
      </div>
    );
  }
  const name = viewer.profile?.displayName ?? viewer.user.email;
  const row = 'flex items-center gap-4 rounded-xl px-3 py-3 text-[15px] hover:bg-surface';
  return (
    <div className="mx-auto max-w-xl px-4 py-6">
      <div className="flex items-center gap-4">
        <Avatar name={name} src={viewer.profile?.avatarUrl} size={72} />
        <div className="min-w-0"><h1 className="truncate text-[24px] font-semibold">{name}</h1><p className="truncate text-[14px] text-muted">{viewer.channel ? `@${viewer.channel.handle}` : viewer.user.email}</p></div>
      </div>
      <nav className="mt-6">
        {viewer.channel
          ? <Link href={`/@${viewer.channel.handle}`} className={row}><SquarePlay size={22} strokeWidth={1.6} /><span className="flex-1">Your channel</span><ChevronRight size={18} /></Link>
          : <Link href="/channel/create" className={row}><UserPlus size={22} strokeWidth={1.6} /><span className="flex-1">Create a channel</span><ChevronRight size={18} /></Link>}
        <Link href="/settings" className={row}><Settings size={22} strokeWidth={1.6} /><span className="flex-1">Settings</span><ChevronRight size={18} /></Link>
        {viewer.user.roles.includes('ADMIN') && <Link href="/admin" className={row}><Shield size={22} strokeWidth={1.6} /><span className="flex-1">Administration</span><ChevronRight size={18} /></Link>}
        <SignOutButton className={`${row} w-full text-left`} />
      </nav>
    </div>
  );
}
