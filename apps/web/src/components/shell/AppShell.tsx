'use client';

import { useEffect, type ReactNode } from 'react';
import { currentTheme, setTheme } from './theme';
import type { Viewer } from '@/lib/types';
import { ShellProvider } from './ShellContext';
import { Header } from './Header';
import { MobileDock } from './MobileDock';
import { UploadsProvider } from '../hub/UploadsContext';
import { UploadDialog } from '../hub/UploadDialog';

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
      <UploadsProvider>
        <Header />
        <main className="min-h-[calc(100dvh-4rem)] pb-28 md:pb-10">{children}</main>
        <MobileDock />
        {viewer?.channel && <UploadDialog />}
      </UploadsProvider>
    </ShellProvider>
  );
}
