'use client';

import { Suspense, useEffect, type ReactNode } from 'react';
import { currentTheme, setTheme } from './theme';
import type { Viewer } from '@/lib/types';
import { ShellProvider, useShell } from './ShellContext';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';

function Main({ children }: { children: ReactNode }) {
  const { collapsed } = useShell();
  return <main className={`min-h-[calc(100dvh-3.5rem)] pb-16 md:pb-6 md:pl-[72px] ${collapsed ? '' : 'xl:pl-60'}`}>{children}</main>;
}

export function AppShell({ viewer, locale, children }: { viewer: Viewer | null; locale: string; children: ReactNode }) {
  // Keeps the theme right if React ever re-renders <html>, and follows the device when it switches light/dark.
  useEffect(() => {
    setTheme(currentTheme());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => { if (currentTheme() === 'system') setTheme('system'); };
    mq.addEventListener('change', follow);
    return () => mq.removeEventListener('change', follow);
  }, []);
  return (
    <ShellProvider viewer={viewer} locale={locale}>
      <TopBar />
      <Suspense><Sidebar /></Suspense>
      <Main>{children}</Main>
      <MobileNav />
    </ShellProvider>
  );
}
