'use client';

import { Clapperboard, Home, PlusCircle, UserRound, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Avatar } from '../Avatar';
import { useShell } from './ShellContext';

/** Bottom navigation on phones. */
export function MobileNav() {
  const { viewer } = useShell();
  const path = usePathname();
  const items = [
    { href: '/', label: 'Home', icon: <Home size={24} strokeWidth={path === '/' ? 2.2 : 1.6} />, active: path === '/' },
    { href: '/shorts', label: 'Shorts', icon: <Clapperboard size={24} strokeWidth={path === '/shorts' ? 2.2 : 1.6} />, active: path === '/shorts' },
    { href: viewer?.channel ? '/studio' : viewer ? '/channel/create' : '/login?returnTo=/channel/create', label: 'Create', icon: <PlusCircle size={34} strokeWidth={1.2} />, active: false },
    { href: '/feed/subscriptions', label: 'Subscriptions', icon: <Users size={24} strokeWidth={path === '/feed/subscriptions' ? 2.2 : 1.6} />, active: path === '/feed/subscriptions' },
    { href: '/you', label: 'You', icon: viewer ? <Avatar name={viewer.profile?.displayName ?? viewer.user.email} src={viewer.profile?.avatarUrl} size={24} /> : <UserRound size={24} strokeWidth={1.6} />, active: path === '/you' },
  ];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex h-12 items-stretch border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((i) => (
        <Link key={i.label} href={i.href} aria-current={i.active ? 'page' : undefined} className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px]">
          {i.icon}{i.label !== 'Create' && <span>{i.label}</span>}
        </Link>
      ))}
    </nav>
  );
}
