'use client';

import { useEffect, useState } from 'react';

/** The browser's "install this app" prompt (Chrome, Edge, Android), kept until the person asks to install. */
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

/** Registers the service worker once (installable app, offline page, push notifications). Production only. */
export function setupPwa() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPrompt; changed(); });
  window.addEventListener('appinstalled', () => { deferred = null; changed(); });
  if (process.env.NODE_ENV !== 'production') return; // a worker caching dev builds only gets in the way
  const go = () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined); };
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}

export const isInstalled = () => typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
/** iPhone and iPad: Safari has no install prompt; people use Share → Add to Home Screen. */
export const isIos = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

/** What the "Install app" item can do here: show the prompt, show iPhone steps, or nothing (installed / not offered). */
export function useInstall(): { mode: 'prompt' | 'ios' | null; install: () => Promise<boolean> } {
  const [, bump] = useState(0);
  useEffect(() => { const l = () => bump((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const mode = isInstalled() ? null : deferred ? 'prompt' : isIos() ? 'ios' : null;
  return {
    mode,
    install: async () => {
      if (!deferred) return false;
      const d = deferred;
      await d.prompt();
      const { outcome } = await d.userChoice;
      deferred = null; changed();
      return outcome === 'accepted';
    },
  };
}
