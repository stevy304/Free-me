'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Icon from '@/components/icons';
import { Avatar } from '../Avatar';
import { useShell } from './ShellContext';
import { tabActive } from './Header';

/** Phones: a floating dock (not a full-width bar) with the main places and Create in the middle. */
export function MobileDock() {
  const { viewer } = useShell();
  const path = usePathname();
  // The login page and the watch page (where the video takes the screen, as in video apps) have no dock.
  if (path === '/login' || path === '/watch') return null;
  const create = viewer?.channel ? '/hub?upload=1' : viewer ? '/channel/create' : '/login?returnTo=/channel/create';
  const item = (href: string, label: string, I: typeof Icon.Home) => {
    const on = tabActive(href, path);
    return (
      <Link href={href} aria-current={on ? 'page' : undefined} className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] font-semibold ${on ? 'text-[#2bb5ab]' : 'text-[#9fb0ad]'}`}>
        <I size={22} filled={on} />{label}
      </Link>
    );
  };
  return (
    <nav aria-label="Main" className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex h-16 items-center rounded-[22px] bg-[rgb(16_32_31/0.94)] px-1 shadow-[0_12px_32px_rgb(0_0_0/0.3)] backdrop-blur md:hidden">
      {item('/', 'Current', Icon.Home)}
      {item('/moments', 'Moments', Icon.Moments)}
      <Link href={create} aria-label="Create" className="mx-1 grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#2bb5ab] text-[#04201e]"><Icon.Plus size={24} strokeWidth={2.4} /></Link>
      {item('/following', 'Following', Icon.Following)}
      <Link href="/you" aria-current={path === '/you' ? 'page' : undefined} className={`flex flex-1 flex-col items-center gap-0.5 text-[10px] font-semibold ${path === '/you' ? 'text-[#2bb5ab]' : 'text-[#9fb0ad]'}`}>
        {viewer ? <Avatar name={viewer.profile?.displayName ?? viewer.user.email} src={viewer.profile?.avatarUrl} size={22} /> : <Icon.PersonCircle size={22} />}Me
      </Link>
    </nav>
  );
}
