'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Viewer } from '@/lib/types';

interface Shell {
  viewer: Viewer | null;
  /** The visitor's language for numbers and dates (same on server and browser). */
  locale: string;
  /** Wide screens: the full sidebar is collapsed to the narrow rail. */
  collapsed: boolean;
  /** Smaller screens: the drawer is open. Closed on every page load, so it never flashes open. */
  drawerOpen: boolean;
  toggleSidebar: () => void;
  closeDrawer: () => void;
}
const Ctx = createContext<Shell | null>(null);
const WIDE = '(min-width: 1280px)';

export function ShellProvider({ viewer, locale, children }: { viewer: Viewer | null; locale: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { try { setCollapsed(localStorage.getItem('fm_sidebar') === 'mini'); } catch { /* storage blocked */ } }, []);
  const toggleSidebar = () => {
    if (window.matchMedia(WIDE).matches) {
      setCollapsed((c) => { try { localStorage.setItem('fm_sidebar', c ? 'full' : 'mini'); } catch { /* storage blocked */ } return !c; });
    } else setDrawerOpen((o) => !o);
  };
  const closeDrawer = () => setDrawerOpen(false);
  return <Ctx.Provider value={{ viewer, locale, collapsed, drawerOpen, toggleSidebar, closeDrawer }}>{children}</Ctx.Provider>;
}

export function useShell(): Shell {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShell outside ShellProvider');
  return v;
}
