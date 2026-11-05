import * as Icon from '@/components/icons';
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
        <p className="mt-2 text-[15px] text-muted">Sign in to follow channels, save videos and keep your settings on every device.</p>
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
          ? <Link href={`/@${viewer.channel.handle}`} className={row}><Icon.Channel size={22} strokeWidth={1.6} /><span className="flex-1">Your channel</span><Icon.ChevronRight size={18} /></Link>
          : <Link href="/channel/create" className={row}><Icon.PersonAdd size={22} strokeWidth={1.6} /><span className="flex-1">Create a channel</span><Icon.ChevronRight size={18} /></Link>}
        {viewer.channel && <Link href="/hub" className={row}><Icon.Hub size={22} /><span className="flex-1">Creator Hub</span><Icon.ChevronRight size={18} /></Link>}
        <Link href="/history" className={row}><Icon.History size={22} /><span className="flex-1">History</span><Icon.ChevronRight size={18} /></Link>
        <Link href="/collections" className={row}><Icon.Collections size={22} /><span className="flex-1">Collections</span><Icon.ChevronRight size={18} /></Link>
        <Link href="/collection/saved" className={row}><Icon.Bookmark size={22} /><span className="flex-1">Saved</span><Icon.ChevronRight size={18} /></Link>
        <Link href="/you/reports" className={row}><Icon.Flag size={22} /><span className="flex-1">Your reports</span><Icon.ChevronRight size={18} /></Link>
        <Link href="/settings" className={row}><Icon.Settings size={22} strokeWidth={1.6} /><span className="flex-1">Settings</span><Icon.ChevronRight size={18} /></Link>
        {viewer.user.roles.some((r) => r === 'ADMIN' || r === 'MODERATOR') && <Link href="/moderation" className={row}><Icon.Flag size={22} /><span className="flex-1">Moderation</span><Icon.ChevronRight size={18} /></Link>}
        {viewer.user.roles.includes('ADMIN') && <Link href="/admin" className={row}><Icon.Shield size={22} strokeWidth={1.6} /><span className="flex-1">Administration</span><Icon.ChevronRight size={18} /></Link>}
        <SignOutButton className={`${row} w-full text-left`} />
      </nav>
      <nav aria-label="Legal" className="mt-6 flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-3 pt-4 text-[13px] text-muted">
        <Link href="/legal/terms">Terms</Link><Link href="/legal/privacy">Privacy</Link><Link href="/legal/guidelines">Community Guidelines</Link><Link href="/legal/copyright">Copyright</Link>
      </nav>
    </div>
  );
}
