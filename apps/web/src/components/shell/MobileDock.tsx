'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Icon from '@/components/icons';
import { Avatar } from '../Avatar';
import { me } from '@/lib/me';
import { useShell } from './ShellContext';
import { tabActive } from './Header';

/** Phones: a floating dock (not a full-width bar) with the main places and Create in the middle. */
export function MobileDock() {
  const { viewer, t } = useShell();
  const path = usePathname();
  // The login page and the watch page (where the video takes the screen, as in video apps) have no dock.
  if (path === '/login' || path === '/watch') return null;
  const create = viewer?.channel ? '/hub?upload=1' : viewer ? '/channel/create' : '/login?returnTo=/channel/create';
  const item = (href: string, label: string, I: typeof Icon.Home) => {
    const on = tabActive(href, path);
    return (
      <Link href={href} aria-current={on ? 'page' : undefined} className={`flex flex-1 flex-col items-center gap-1 text-[10.5px] font-semibold ${on ? 'text-[#f4ede3]' : 'text-[#b0a397]'}`}>
        <I size={23} filled={on} className={on ? 'text-[#d65f36]' : undefined} />{label}
      </Link>
    );
  };
  const meOn = path === '/you';
  return (
    <nav aria-label={t('nav.main')} className="facet fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex h-16 items-center bg-[rgb(20_17_15/0.95)] px-1 shadow-[0_12px_32px_rgb(0_0_0/0.3)] backdrop-blur md:hidden">
      {item('/', t('nav.current'), Icon.Home)}
      {item('/moments', t('nav.moments'), Icon.Moments)}
      {/* Create: the clay diamond of the Free Me mark. */}
      <Link href={create} aria-label={t('header.create')} className="diamond mx-1 grid h-[52px] w-[52px] shrink-0 place-items-center bg-[#d65f36] text-[#fffaf3]"><Icon.Plus size={24} strokeWidth={2.4} /></Link>
      {item('/following', t('nav.following'), Icon.Following)}
      <Link href="/you" aria-current={meOn ? 'page' : undefined} className={`flex flex-1 flex-col items-center gap-1 text-[10.5px] font-semibold ${meOn ? 'text-[#f4ede3]' : 'text-[#b0a397]'}`}>
        {viewer ? <span className={`rounded-full ${meOn ? 'ring-2 ring-[#d65f36] ring-offset-1 ring-offset-[#14110f]' : ''}`}><Avatar {...me(viewer)} size={23} /></span> : <Icon.PersonCircle size={23} className={meOn ? 'text-[#d65f36]' : undefined} />}{t('nav.me')}
      </Link>
    </nav>
  );
}
