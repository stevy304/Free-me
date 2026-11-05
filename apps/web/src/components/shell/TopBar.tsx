'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Logo } from '../Logo';
import { AccountMenu } from './AccountMenu';
import { CreateMenu } from './CreateMenu';
import { SearchBox } from './SearchBox';
import { useShell } from './ShellContext';

export function TopBar() {
  const { viewer, toggleSidebar } = useShell();
  const path = usePathname();
  const [mobileSearch, setMobileSearch] = useState(false);
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-2 bg-bg px-2 sm:gap-4 sm:px-4">
      <div className="flex shrink-0 items-center gap-1 sm:gap-3">
        <button type="button" onClick={toggleSidebar} aria-label="Menu" className="rounded-full p-2 hover:bg-surface"><Icon.Menu size={24} strokeWidth={1.6} /></button>
        <Logo />
      </div>
      <Suspense fallback={<div className="hidden flex-1 sm:block" />}><SearchBox mobileOpen={mobileSearch} onMobileClose={() => setMobileSearch(false)} /></Suspense>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <button type="button" onClick={() => setMobileSearch(true)} aria-label="Search" className="rounded-full p-2 hover:bg-surface sm:hidden"><Icon.Search size={22} strokeWidth={1.6} /></button>
        {viewer ? (
          <>
            {viewer.channel ? <CreateMenu /> : (
              <Link href="/channel/create" className="hidden h-9 items-center gap-1.5 rounded-full bg-surface pl-2.5 pr-3.5 text-[14px] font-medium hover:bg-surface-hover sm:flex">
                <Icon.Plus size={22} strokeWidth={1.6} />Create
              </Link>
            )}
            <AccountMenu viewer={viewer} />
          </>
        ) : path === '/login' ? null : (
          <Link href={`/login?returnTo=${encodeURIComponent(path || '/')}`} className="flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-[14px] font-medium text-brand hover:bg-brand-soft">
            <Icon.PersonCircle size={22} strokeWidth={1.6} />Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
