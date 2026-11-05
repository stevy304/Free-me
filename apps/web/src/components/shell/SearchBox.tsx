'use client';

import * as Icon from '@/components/icons';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** Search with suggestions as you type (arrow keys to choose), like a familiar video site. */
export function SearchBox({ mobileOpen, onMobileClose }: { mobileOpen: boolean; onMobileClose: () => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setQ(params.get('q') ?? ''); }, [params]);
  useEffect(() => { if (mobileOpen) input.current?.focus(); }, [mobileOpen]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setSuggestions([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search/suggest?q=${encodeURIComponent(term)}`, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : { suggestions: [] }).then((d) => { setSuggestions(d.suggestions ?? []); setActive(-1); }).catch(() => undefined);
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const go = (term: string) => {
    const t = term.trim();
    if (!t) return;
    setFocused(false);
    input.current?.blur();
    onMobileClose();
    router.push(`/results?q=${encodeURIComponent(t)}`);
  };
  const open = focused && suggestions.length > 0;

  return (
    <div className={`${mobileOpen ? 'absolute inset-x-0 top-0 z-30 flex h-14 items-center gap-2 bg-bg px-2' : 'hidden'} min-w-0 flex-1 sm:static sm:z-auto sm:flex sm:h-auto sm:max-w-[640px] sm:px-0`}>
      {mobileOpen && <button type="button" onClick={onMobileClose} aria-label="Close search" className="rounded-full p-2 hover:bg-surface sm:hidden"><Icon.ArrowLeft size={22} /></button>}
      <form role="search" className="relative flex min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); go(active >= 0 ? suggestions[active] : q); }}>
        <div className={`flex h-10 min-w-0 flex-1 items-center rounded-l-full border bg-bg pr-1 ${focused ? 'border-brand pl-4 shadow-[inset_0_1px_2px_rgb(0_0_0/0.15)] sm:ml-0' : 'border-line pl-4 sm:ml-8'}`}>
          {focused && <Icon.Search size={18} className="mr-3 hidden shrink-0 text-muted sm:block" aria-hidden="true" />}
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length); }
              else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1)); }
              else if (e.key === 'Escape') { setFocused(false); onMobileClose(); }
            }}
            placeholder="Search" aria-label="Search" role="combobox" aria-expanded={open} aria-controls="search-suggestions" aria-autocomplete="list"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint" maxLength={100} />
          {q && <button type="button" aria-label="Clear search" onClick={() => { setQ(''); input.current?.focus(); }} className="rounded-full p-1.5 text-muted hover:bg-surface"><Icon.Close size={18} /></button>}
        </div>
        <button type="submit" aria-label="Search" className="grid h-10 w-16 shrink-0 place-items-center rounded-r-full border border-l-0 border-line bg-surface hover:bg-surface-hover"><Icon.Search size={20} /></button>
        {open && (
          <ul id="search-suggestions" role="listbox" className="absolute left-0 right-16 top-11 z-40 overflow-hidden rounded-xl border border-line bg-elevated py-3 shadow-[var(--shadow)] sm:left-8">
            {suggestions.map((s, i) => (
              <li key={s} role="option" aria-selected={i === active}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(s)} className={`flex w-full items-center gap-3 px-4 py-1.5 text-left text-[15px] font-medium ${i === active ? 'bg-surface' : 'hover:bg-surface'}`}>
                  <Icon.Search size={16} className="shrink-0 text-muted" /><span className="truncate">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  );
}
