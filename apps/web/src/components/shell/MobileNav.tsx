'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Avatar } from '../Avatar';
import { useShell } from './ShellContext';

/** Bottom navigation on phones. */
export function MobileNav() {
  const { viewer } = useShell();
  const path = usePathname();
  const items = [
    { href: '/', label: 'Home', icon: <Icon.Home size={24} filled={path === '/'} />, active: path === '/' },
    { href: '/moments', label: 'Moments', icon: <Icon.Moments size={24} filled={path === '/moments'} />, active: path === '/moments' },
    { href: viewer?.channel ? '/hub' : viewer ? '/channel/create' : '/login?returnTo=/channel/create', label: 'Create', icon: <Icon.PlusCircle size={34} strokeWidth={1.3} />, active: false },
    { href: '/following', label: 'Following', icon: <Icon.Following size={24} filled={path === '/following'} />, active: path === '/following' },
    { href: '/you', label: 'You', icon: viewer ? <Avatar name={viewer.profile?.displayName ?? viewer.user.email} src={viewer.profile?.avatarUrl} size={24} /> : <Icon.PersonCircle size={24} />, active: path === '/you' },
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
