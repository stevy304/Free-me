'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { Logo } from '../Logo';
import { VerifiedBadge } from '../VerifiedBadge';
import { AccountMenu } from './AccountMenu';
import { CreateMenu } from './CreateMenu';
import { FindPanel } from './FindPanel';
import { NotificationBell } from './NotificationBell';
import { useShell } from './ShellContext';
import { LanguageMenu } from './LanguageMenu';

export const TABS = [
  { href: '/', label: 'nav.current' },
  { href: '/following', label: 'nav.following' },
  { href: '/moments', label: 'nav.moments' },
  { href: '/explore', label: 'nav.explore' },
] as const;

export const tabActive = (href: string, path: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

/**
 * The header: logo, the four main places as a segmented control, Find (also "/" anywhere), Create and the account.
 * No sidebar: everything else lives in the account menu and the You page.
 */
export function Header() {
  const { viewer, t } = useShell();
  const path = usePathname();
  const [find, setFind] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setFind(true); }
      // Some keydown events (e.g. Chrome autofill) carry no key at all.
      if ((e.key ?? '').toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setFind(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setFind(false); }, [path]);

  return (
    <header className={`top-0 z-40 border-b border-transparent bg-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-bg/75 ${path === '/watch' ? 'relative sm:sticky' : 'sticky'}`}>
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
        <Logo />
        <nav aria-label={t('nav.main')} className="mx-auto hidden rounded-2xl bg-surface p-1 md:flex">
          {TABS.map((tab) => {
            const on = tabActive(tab.href, path);
            return (
              <Link key={tab.href} href={tab.href} aria-current={on ? 'page' : undefined}
                className={`rounded-xl px-4 py-2 text-[14px] font-semibold transition-colors lg:px-5 ${on ? 'bg-elevated text-ink shadow-[0_1px_4px_rgb(8_40_38/0.12)]' : 'text-muted hover:text-ink'}`}>{t(tab.label)}</Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <button type="button" onClick={() => setFind(true)} aria-label={t('header.findShortcut')}
            className="flex h-10 items-center gap-2.5 rounded-xl bg-surface px-3 text-[14px] text-muted hover:bg-surface-hover lg:w-56">
            <Icon.Search size={20} /><span className="hidden lg:inline">{t('header.find')}</span>
            <kbd className="ml-auto hidden rounded-md border border-line bg-elevated px-1.5 font-sans text-[11px] font-semibold lg:inline">/</kbd>
          </button>
          {viewer ? (
            <>
              <span className="hidden sm:block">{viewer.channel ? <CreateMenu /> : (
                <Link href="/channel/create" className="flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand hover:bg-brand-strong"><Icon.Plus size={20} />{t('header.create')}</Link>
              )}</span>
              {viewer.premium?.active ? (
                <Link href="/plans" aria-label={t('header.plans')} title={t('header.plans')} className="hidden h-10 items-center gap-1.5 rounded-xl px-2.5 text-[14px] font-semibold text-muted hover:bg-surface hover:text-ink sm:flex"><VerifiedBadge size={20} kind="premium" /><span className="hidden lg:inline">{t('header.plans')}</span></Link>
              ) : (
                <Link href="/premium" className="flex h-10 items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#f5b95c] to-[#e39a2a] px-3 text-[14px] font-bold text-[#2a1a02] shadow-[0_2px_10px_rgb(227_154_42/0.35)] hover:brightness-105 sm:px-4"><Icon.PremiumStar size={18} filled /><span className="hidden min-[400px]:inline">{t('header.upgrade')}</span></Link>
              )}
              <NotificationBell />
              <AccountMenu viewer={viewer} />
            </>
          ) : path === '/login' ? <LanguageMenu /> : (
            <>
            <LanguageMenu />
            <Link href={`/login?returnTo=${encodeURIComponent(path || '/')}`} className="flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand hover:bg-brand-strong">
              <Icon.PersonCircle size={20} />{t('header.signIn')}
            </Link>
            </>
          )}
        </div>
      </div>
      <FindPanel open={find} onClose={() => setFind(false)} />
    </header>
  );
}
