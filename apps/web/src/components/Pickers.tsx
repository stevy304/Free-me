'use client';

import { COUNTRY_CODES, LANGUAGE_CODES, countryName, languageName } from '@free-me/shared';
import { useMemo } from 'react';
import { useShell } from './shell/ShellContext';

const field = 'h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-brand';

/** Every country, named in the reader's language and sorted for them. */
export function CountrySelect({ value, onChange, id, emptyLabel = 'Not set' }: { value: string | null; onChange: (v: string | null) => void; id?: string; emptyLabel?: string }) {
  // The visitor's language from the server (same on server and browser), so the list renders identically on both.
  const { locale } = useShell();
  const options = useMemo(() => {
    return COUNTRY_CODES.map((c) => ({ c, n: countryName(c, locale) })).sort((a, b) => a.n.localeCompare(b.n, locale));
  }, [locale]);
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={field}>
      <option value="">{emptyLabel}</option>
      {/* Node and browsers can ship slightly different Unicode name data; the server's names are kept. */}
      {options.map(({ c, n }) => <option key={c} value={c} suppressHydrationWarning>{n}</option>)}
    </select>
  );
}

/** Languages, each written in its own language ("Français", "Kinyarwanda", "日本語"). */
export function LanguageSelect({ value, onChange, id, allowEmpty = false }: { value: string | null; onChange: (v: string | null) => void; id?: string; allowEmpty?: boolean }) {
  const { locale } = useShell();
  const options = useMemo(() => LANGUAGE_CODES.map((l) => ({ l, n: languageName(l) })).sort((a, b) => a.n.localeCompare(b.n, locale)), [locale]);
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={field}>
      {allowEmpty && <option value="">Not set</option>}
      {options.map(({ l, n }) => <option key={l} value={l} suppressHydrationWarning>{n.charAt(0).toUpperCase() + n.slice(1)}</option>)}
    </select>
  );
}

export const inputClass = field;
