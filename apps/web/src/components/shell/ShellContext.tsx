'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
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

/**
 * The sidebar choice lives in a cookie (fm_sidebar) that the server reads too, so the page is rendered with the
 * sidebar the visitor chose and hydration matches (a browser-only setting made the server and browser disagree).
 */
export function ShellProvider({ viewer, locale, initialCollapsed = false, children }: { viewer: Viewer | null; locale: string; initialCollapsed?: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleSidebar = () => {
    if (window.matchMedia(WIDE).matches) {
      setCollapsed((c) => {
        document.cookie = `fm_sidebar=${c ? 'full' : 'mini'}; Path=/; Max-Age=31536000; SameSite=Lax`;
        return !c;
      });
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
