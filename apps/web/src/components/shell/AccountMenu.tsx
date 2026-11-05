'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../Avatar';
import { api } from '@/lib/client-api';
import { currentTheme, setTheme, type ThemeChoice } from './theme';
import type { Viewer } from '@/lib/types';

export function AccountMenu({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'theme'>('main');
  const [theme, setThemeState] = useState<ThemeChoice>('system');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setThemeState(currentTheme()); }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) { setOpen(false); setView('main'); } };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  const name = viewer.profile?.displayName ?? viewer.user.email;
  const signOut = async () => { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined); window.location.href = '/'; };
  const item = 'flex w-full items-center gap-4 px-4 py-2 text-left text-[14px] hover:bg-surface';
  const themes: Array<[ThemeChoice, string, typeof Icon.Sun]> = [['system', 'Use device theme', Icon.Monitor], ['dark', 'Dark theme', Icon.Moon], ['light', 'Light theme', Icon.Sun]];

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" className="rounded-full p-0.5">
        <Avatar name={name} src={viewer.profile?.avatarUrl} size={32} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-50 w-[300px] overflow-hidden rounded-xl border border-line bg-elevated py-2 shadow-[var(--shadow)]">
          {view === 'main' ? (
            <>
              <div className="flex gap-4 px-4 pb-3 pt-2">
                <Avatar name={name} src={viewer.profile?.avatarUrl} size={40} />
                <div className="min-w-0">
                  <p className="truncate text-[16px] font-medium">{name}</p>
                  <p className="truncate text-[14px] text-muted">{viewer.channel ? `@${viewer.channel.handle}` : viewer.user.email}</p>
                  {viewer.channel
                    ? <Link href={`/@${viewer.channel.handle}`} onClick={() => setOpen(false)} className="mt-1 inline-block text-[14px] font-medium text-brand">View your channel</Link>
                    : <Link href="/channel/create" onClick={() => setOpen(false)} className="mt-1 inline-block text-[14px] font-medium text-brand">Create a channel</Link>}
                </div>
              </div>
              <div className="border-t border-line py-2">
                {viewer.channel
                  ? <Link role="menuitem" href={`/@${viewer.channel.handle}`} onClick={() => setOpen(false)} className={item}><Icon.Channel size={22} strokeWidth={1.6} />Your channel</Link>
                  : <Link role="menuitem" href="/channel/create" onClick={() => setOpen(false)} className={item}><Icon.PersonAdd size={22} strokeWidth={1.6} />Create a channel</Link>}
                {viewer.user.roles.includes('ADMIN') && <Link role="menuitem" href="/admin" onClick={() => setOpen(false)} className={item}><Icon.Shield size={22} strokeWidth={1.6} />Administration</Link>}
                <button role="menuitem" type="button" onClick={signOut} className={item}><Icon.SignOut size={22} strokeWidth={1.6} />Sign out</button>
              </div>
              <div className="border-t border-line py-2">
                <button role="menuitem" type="button" onClick={() => setView('theme')} className={item}>
                  <Icon.Moon size={22} strokeWidth={1.6} /><span className="flex-1">Appearance: {themes.find((t) => t[0] === theme)![1].replace(' theme', '').replace('Use device', 'Device')}</span><Icon.ChevronRight size={20} />
                </button>
                <Link role="menuitem" href="/settings" onClick={() => setOpen(false)} className={item}><Icon.Settings size={22} strokeWidth={1.6} />Settings</Link>
              </div>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setView('main')} className="flex w-full items-center gap-3 border-b border-line px-4 pb-3 pt-1 text-[16px]"><Icon.ChevronRight size={20} className="rotate-180" />Appearance</button>
              <p className="px-4 py-3 text-[12px] text-muted">Setting applies to this browser only</p>
              {themes.map(([v, label]) => (
                <button key={v} type="button" role="menuitemradio" aria-checked={theme === v} onClick={() => { setTheme(v); setThemeState(v); }} className={item}>
                  <span className="w-6">{theme === v && <Icon.Check size={20} />}</span>{label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
