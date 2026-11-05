'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Viewer } from '@/lib/types';

interface Shell {
  viewer: Viewer | null;
  /** The visitor's language for numbers and dates (same on server and browser). */
  locale: string;
}
const Ctx = createContext<Shell | null>(null);

export function ShellProvider({ viewer, locale, children }: { viewer: Viewer | null; locale: string; children: ReactNode }) {
  return <Ctx.Provider value={{ viewer, locale }}>{children}</Ctx.Provider>;
}

export function useShell(): Shell {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShell outside ShellProvider');
  return v;
}
