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
  const item = 'flex w-full items-center gap-3.5 rounded-xl px-3 py-2 text-left text-[14px] hover:bg-surface';
  const close = () => setOpen(false);
  const themes: Array<[ThemeChoice, string, typeof Icon.Sun]> = [['system', 'Use device theme', Icon.Monitor], ['dark', 'Dark theme', Icon.Moon], ['light', 'Light theme', Icon.Sun]];

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" className="rounded-xl p-0.5">
        <Avatar name={name} src={viewer.profile?.avatarUrl} size={38} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 max-h-[calc(100dvh-5rem)] w-[300px] overflow-y-auto rounded-2xl border border-line bg-elevated px-1.5 py-2 shadow-[var(--shadow)]">
          {view === 'main' ? (
            <>
              <div className="flex gap-3 px-4 pb-3 pt-2">
                <Avatar name={name} src={viewer.profile?.avatarUrl} size={44} />
                <div className="min-w-0">
                  <p className="truncate font-display text-[16px] font-bold">{name}</p>
                  <p className="truncate text-[13px] text-muted">{viewer.channel ? `@${viewer.channel.handle}` : viewer.user.email}</p>
                </div>
              </div>
              <div className="border-t border-line py-1.5">
                {viewer.channel
                  ? <Link role="menuitem" href={`/@${viewer.channel.handle}`} onClick={close} className={item}><Icon.Channel size={20} />Your Space</Link>
                  : <Link role="menuitem" href="/channel/create" onClick={close} className={item}><Icon.PersonAdd size={20} />Create your Space</Link>}
                {viewer.channel && <Link role="menuitem" href="/hub" onClick={close} className={item}><Icon.Hub size={20} />Creator Hub</Link>}
                <Link role="menuitem" href="/trail" onClick={close} className={item}><Icon.Trail size={20} />Trail</Link>
                <Link role="menuitem" href="/collections" onClick={close} className={item}><Icon.Collections size={20} />Collections</Link>
                <Link role="menuitem" href="/collection/saved" onClick={close} className={item}><Icon.Bookmark size={20} />Kept</Link>
              </div>
              <div className="border-t border-line py-1.5">
                <Link role="menuitem" href="/you/reports" onClick={close} className={item}><Icon.Flag size={20} />Your reports</Link>
                {viewer.user.roles.some((r) => r === 'ADMIN' || r === 'MODERATOR') && <Link role="menuitem" href="/moderation" onClick={close} className={item}><Icon.Shield size={20} />Moderation</Link>}
                {viewer.user.roles.includes('ADMIN') && <Link role="menuitem" href="/admin" onClick={close} className={item}><Icon.Settings size={20} />Administration</Link>}
              </div>
              <div className="border-t border-line py-1.5">
                <button role="menuitem" type="button" onClick={() => setView('theme')} className={item}>
                  <Icon.Moon size={20} /><span className="flex-1">Appearance: {themes.find((t) => t[0] === theme)![1].replace(' theme', '').replace('Use device', 'Device')}</span><Icon.ChevronRight size={18} />
                </button>
                <Link role="menuitem" href="/settings" onClick={close} className={item}><Icon.Settings size={20} />Settings</Link>
                <button role="menuitem" type="button" onClick={signOut} className={item}><Icon.SignOut size={20} />Sign out</button>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-4 pb-1 pt-2.5 text-[12px] text-muted">
                <Link href="/legal/terms" onClick={close} className="hover:text-ink">Terms</Link><Link href="/legal/privacy" onClick={close} className="hover:text-ink">Privacy</Link><Link href="/legal/guidelines" onClick={close} className="hover:text-ink">Guidelines</Link><Link href="/legal/copyright" onClick={close} className="hover:text-ink">Copyright</Link>
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
