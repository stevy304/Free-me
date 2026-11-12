'use client';

import { useEffect, type ReactNode } from 'react';
import { currentTheme, setTheme } from './theme';
import { setupPwa } from '@/lib/pwa';
import type { Viewer } from '@/lib/types';
import { ShellProvider } from './ShellContext';
import type { Lang } from '@/i18n';
import { MiniDock } from '@/components/player/MiniDock';
import { Header } from './Header';
import { MobileDock } from './MobileDock';
import { UploadsProvider } from '../hub/UploadsContext';
import { UploadDialog } from '../hub/UploadDialog';

export function AppShell({ viewer, locale, lang, children }: { viewer: Viewer | null; locale: string; lang: Lang; children: ReactNode }) {
  // Keeps the theme right if React ever re-renders <html>, and follows the device when it switches light/dark.
  useEffect(() => {
    setTheme(currentTheme());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => { if (currentTheme() === 'system') setTheme('system'); };
    mq.addEventListener('change', follow);
    return () => mq.removeEventListener('change', follow);
  }, []);
  useEffect(() => { setupPwa(); }, []);
  // An image that cannot load (a removed or moved file) is hidden instead of showing a broken icon: the tinted box
  // behind every thumbnail and avatar shows through. One listener for the whole app.
  useEffect(() => {
    const onError = (e: Event) => { const t = e.target; if (t instanceof HTMLImageElement) t.style.visibility = 'hidden'; };
    window.addEventListener('error', onError, true);
    return () => window.removeEventListener('error', onError, true);
  }, []);
  return (
    <ShellProvider viewer={viewer} locale={locale} lang={lang}>
      <UploadsProvider>
        <Header />
        <main className="min-h-[calc(100dvh-4rem-1px)] pb-28 md:pb-10">{children}</main>
        <MiniDock />
        <MobileDock />
        {viewer?.channel && <UploadDialog />}
      </UploadsProvider>
    </ShellProvider>
  );
}
