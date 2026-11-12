'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { translator, type Lang, type T } from '@/i18n';
import type { Viewer } from '@/lib/types';

interface Shell {
  viewer: Viewer | null;
  /** The visitor's language for numbers and dates (same on server and browser). */
  locale: string;
  /** The interface language (English, Kinyarwanda or French). */
  lang: Lang;
  t: T;
}
const Ctx = createContext<Shell | null>(null);

export function ShellProvider({ viewer, locale, lang, children }: { viewer: Viewer | null; locale: string; lang: Lang; children: ReactNode }) {
  const value = useMemo(() => ({ viewer, locale, lang, t: translator(lang) }), [viewer, locale, lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): Shell {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShell outside ShellProvider');
  return v;
}

/** Translations in client components: `const t = useT(); t('nav.current')`. */
export function useT(): T { return useShell().t; }
