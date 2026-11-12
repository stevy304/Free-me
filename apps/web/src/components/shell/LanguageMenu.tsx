'use client';

import { useEffect, useRef, useState } from 'react';
import * as Icon from '@/components/icons';
import { LANG_COOKIE, LANGS, type Lang } from '@/i18n';
import { useShell } from './ShellContext';

/**
 * Remembers the interface language on this device for a year and reloads the page in it. A full reload (not a router
 * refresh): every text on the page, including what components keep in memory, comes back in the new language.
 */
export function useSetLang() {
  return (lang: Lang) => {
    document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=${365 * 86_400}; samesite=lax`;
    window.location.reload();
  };
}

/** The language list, as radio items (used inside the account menu). */
export function LanguageItems({ itemClass }: { itemClass: string }) {
  const { lang } = useShell();
  const setLang = useSetLang();
  return (
    <>
      {LANGS.map((l) => (
        <button key={l.code} type="button" role="menuitemradio" aria-checked={lang === l.code} lang={l.code} onClick={() => setLang(l.code)} className={itemClass}>
          <span className="w-6">{lang === l.code && <Icon.Check size={20} />}</span>{l.name}
        </button>
      ))}
    </>
  );
}

/** Visitors (no account menu yet): a globe button in the header with the three languages. */
export function LanguageMenu() {
  const { lang, t } = useShell();
  const setLang = useSetLang();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={t('account.language')} title={t('account.language')}
        className="flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-bold uppercase text-muted hover:bg-surface hover:text-ink">
        <Icon.Globe size={20} />{lang}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-52 rounded-2xl border border-line bg-elevated p-1.5 shadow-[var(--shadow)]">
          {LANGS.map((l) => (
            <button key={l.code} type="button" role="menuitemradio" aria-checked={lang === l.code} lang={l.code} onClick={() => { setOpen(false); setLang(l.code); }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[14px] hover:bg-surface">
              <span className="w-5">{lang === l.code && <Icon.Check size={18} />}</span>{l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
