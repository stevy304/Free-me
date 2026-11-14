'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../Avatar';
import { api } from '@/lib/client-api';
import { currentTheme, setTheme, type ThemeChoice } from './theme';
import type { Viewer } from '@/lib/types';
import { useInstall } from '@/lib/pwa';
import { LANGS } from '@/i18n';
import { LanguageItems } from './LanguageMenu';
import { useShell } from './ShellContext';

export function AccountMenu({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'theme' | 'install' | 'lang'>('main');
  const { t, lang } = useShell();
  const installer = useInstall();
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
  const themes: Array<[ThemeChoice, string, string, typeof Icon.Sun]> = [['system', t('theme.device'), t('theme.deviceShort'), Icon.Monitor], ['dark', t('theme.dark'), t('theme.darkShort'), Icon.Moon], ['light', t('theme.light'), t('theme.lightShort'), Icon.Sun]];

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={t('account.menu')} className="rounded-xl p-0.5">
        <Avatar name={name} src={viewer.profile?.avatarUrl ?? viewer.channel?.avatarUrl} size={38} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 max-h-[calc(100dvh-5rem)] w-[300px] overflow-y-auto rounded-2xl border border-line bg-elevated px-1.5 py-2 shadow-[var(--shadow)]">
          {view === 'main' ? (
            <>
              <div className="flex gap-3 px-4 pb-3 pt-2">
                <Avatar name={name} src={viewer.profile?.avatarUrl ?? viewer.channel?.avatarUrl} size={44} />
                <div className="min-w-0">
                  <p className="truncate font-display text-[16px] font-bold">{name}</p>
                  <p className="truncate text-[13px] text-muted">{viewer.channel ? `@${viewer.channel.handle}` : viewer.user.email}</p>
                </div>
              </div>
              <div className="border-t border-line py-1.5">
                {viewer.channel
                  ? <Link role="menuitem" href={`/@${viewer.channel.handle}`} onClick={close} className={item}><Icon.Channel size={20} />{t('account.yourSpace')}</Link>
                  : <Link role="menuitem" href="/channel/create" onClick={close} className={item}><Icon.PersonAdd size={20} />{t('account.createSpace')}</Link>}
                {viewer.channel && <Link role="menuitem" href="/hub" onClick={close} className={item}><Icon.Hub size={20} />{t('create.creatorHub')}</Link>}
                <Link role="menuitem" href="/premium" onClick={close} className={item}><Icon.PremiumStar size={20} /><span className="flex-1">{t('account.premium')}</span>{viewer.premium?.active ? <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-bold text-brand">{t('account.member')}</span> : <span className="text-[12px] font-semibold text-[#c27a12]">{t('header.upgrade')}</span>}</Link>
                {viewer.premium?.active && <Link role="menuitem" href="/studio/live" onClick={close} className={item}><Icon.Live size={20} />Signal Room</Link>}
                <Link role="menuitem" href="/studio/ads" onClick={close} className={item}><Icon.Megaphone size={20} />Ad Studio</Link>
                <Link role="menuitem" href="/trail" onClick={close} className={item}><Icon.Trail size={20} />{t('account.trail')}</Link>
                <Link role="menuitem" href="/collections" onClick={close} className={item}><Icon.Collections size={20} />{t('account.collections')}</Link>
                <Link role="menuitem" href="/collection/saved" onClick={close} className={item}><Icon.Bookmark size={20} />{t('account.kept')}</Link>
              </div>
              <div className="border-t border-line py-1.5">
                <Link role="menuitem" href="/you/reports" onClick={close} className={item}><Icon.Flag size={20} />{t('account.reports')}</Link>
                {viewer.user.roles.some((r) => r === 'ADMIN' || r === 'MODERATOR') && <Link role="menuitem" href="/moderation" onClick={close} className={item}><Icon.Shield size={20} />{t('account.moderation')}</Link>}
                {viewer.user.roles.includes('ADMIN') && <Link role="menuitem" href="/admin" onClick={close} className={item}><Icon.Settings size={20} />{t('account.administration')}</Link>}
              </div>
              <div className="border-t border-line py-1.5">
                <button role="menuitem" type="button" onClick={() => setView('theme')} className={item}>
                  <Icon.Moon size={20} /><span className="flex-1">{t('account.appearance')}: {themes.find((x) => x[0] === theme)![2]}</span><Icon.ChevronRight size={18} />
                </button>
                <button role="menuitem" type="button" onClick={() => setView('lang')} className={item}>
                  <Icon.Globe size={20} /><span className="flex-1">{t('account.language')}: {LANGS.find((l) => l.code === lang)!.name}</span><Icon.ChevronRight size={18} />
                </button>
                {installer.mode && (
                  <button role="menuitem" type="button" onClick={() => { if (installer.mode === 'ios') setView('install'); else void installer.install().then(close); }} className={item}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/free-me.svg" alt="" width={20} height={20} /><span className="flex-1">{t('account.install')}</span>
                  </button>
                )}
                <Link role="menuitem" href="/settings" onClick={close} className={item}><Icon.Settings size={20} />{t('account.settings')}</Link>
                <button role="menuitem" type="button" onClick={signOut} className={item}><Icon.SignOut size={20} />{t('account.signOut')}</button>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-4 pb-1 pt-2.5 text-[12px] text-muted">
                <Link href="/legal/terms" onClick={close} className="hover:text-ink">{t('legal.terms')}</Link><Link href="/legal/privacy" onClick={close} className="hover:text-ink">{t('legal.privacy')}</Link><Link href="/legal/guidelines" onClick={close} className="hover:text-ink">{t('legal.guidelines')}</Link><Link href="/legal/copyright" onClick={close} className="hover:text-ink">{t('legal.copyright')}</Link>
              </div>
            </>
          ) : view === 'install' ? (
            <div className="px-4 pb-3 pt-1">
              <button type="button" onClick={() => setView('main')} className="-mx-4 mb-3 flex w-[calc(100%+2rem)] items-center gap-3 border-b border-line px-4 pb-3 text-[16px]"><Icon.ChevronLeft size={20} />{t('account.install')}</button>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icons/icon-192.png" alt="" width={56} height={56} className="rounded-2xl border border-line" />
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-[14px]">
                <li>Tap the <b>Share</b> button at the bottom of Safari (a square with an arrow).</li>
                <li>Choose <b>Add to Home Screen</b>.</li>
                <li>Tap <b>Add</b>. Free Me opens full screen from its icon.</li>
              </ol>
            </div>
          ) : view === 'lang' ? (
            <>
              <button type="button" onClick={() => setView('main')} className="flex w-full items-center gap-3 border-b border-line px-4 pb-3 pt-1 text-[16px]"><Icon.ChevronRight size={20} className="rotate-180" />{t('account.language')}</button>
              <p className="px-4 py-3 text-[12px] text-muted">{t('settings.languageHint')}</p>
              <LanguageItems itemClass={item} />
            </>
          ) : (
            <>
              <button type="button" onClick={() => setView('main')} className="flex w-full items-center gap-3 border-b border-line px-4 pb-3 pt-1 text-[16px]"><Icon.ChevronRight size={20} className="rotate-180" />{t('account.appearance')}</button>
              <p className="px-4 py-3 text-[12px] text-muted">{t('account.browserOnly')}</p>
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
