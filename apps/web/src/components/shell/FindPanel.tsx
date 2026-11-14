'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Icon from '@/components/icons';
import { Avatar } from '../Avatar';
import { duration, followersLabel } from '@/lib/format';
import type { ChannelInfo, VideoCardData } from '@/lib/types';
import { useShell } from './ShellContext';

interface Results { videos: VideoCardData[]; channels: ChannelInfo[] }
const RECENT = 'fm_recent_finds';
const readRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]').slice(0, 6); } catch { return []; } };
const remember = (q: string) => { try { localStorage.setItem(RECENT, JSON.stringify([q, ...readRecent().filter((x) => x !== q)].slice(0, 6))); } catch { /* storage blocked */ } };

/**
 * Find: a panel over the page (button in the header, or "/" anywhere) with videos, Spaces and suggestions as you
 * type. Enter opens the full results; arrow keys move through the list.
 */
export function FindPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { locale, t } = useShell();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Results | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setRecent(readRecent()); setActive(-1);
    setTimeout(() => input.current?.focus(), 10);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); setSuggest([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : null).then((d) => d && setRes({ videos: d.videos.slice(0, 4), channels: d.channels.slice(0, 3) })).catch(() => undefined);
      fetch(`/api/search/suggest?q=${encodeURIComponent(term)}`, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : { suggestions: [] }).then((d) => setSuggest((d.suggestions ?? []).filter((s: string) => s.toLowerCase() !== term.toLowerCase()).slice(0, 4))).catch(() => undefined);
      setActive(-1);
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const term = q.trim();
  const links: Array<{ href: string; key: string }> = [
    ...(res?.videos ?? []).map((v) => ({ href: `/watch?v=${v.id}`, key: v.id })),
    ...(res?.channels ?? []).map((c) => ({ href: `/@${c.handle}`, key: c.id })),
    ...(term.length >= 2 ? suggest : recent).map((s) => ({ href: `/results?q=${encodeURIComponent(s)}`, key: `s:${s}` })),
  ];
  const go = (href: string, search?: string) => { if (search) remember(search); onClose(); setQ(''); router.push(href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(links.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && links[active]) go(links[active].href, links[active].key.startsWith('s:') ? links[active].key.slice(2) : undefined);
      else if (term) go(`/results?q=${encodeURIComponent(term)}`, term);
    }
  };
  if (!open) return null;
  let i = -1;
  const row = (on: boolean) => `flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${on ? 'bg-surface' : 'hover:bg-surface'}`;

  // On the page itself, not inside the header: the header's blur makes it the frame of anything fixed inside it,
  // and on Moments (phones) the header has no height.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-[rgb(20_17_15/0.45)] p-0 backdrop-blur-sm sm:p-6 sm:pt-[10vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Find">
      <div className="flex h-full w-full flex-col overflow-hidden bg-elevated shadow-[var(--shadow)] sm:h-auto sm:max-h-[78vh] sm:max-w-[720px] sm:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <Icon.Search size={24} className="shrink-0 text-brand" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('find.placeholder')} aria-label={t('header.find')} autoComplete="off" spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-display text-[20px] font-semibold outline-none placeholder:font-sans placeholder:text-[17px] placeholder:font-normal placeholder:text-faint" />
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-[12px] font-semibold text-muted hover:bg-surface"><span className="hidden sm:inline">esc</span><Icon.Close size={20} className="sm:hidden" /></button>
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {res && res.videos.length > 0 && (
            <section className="mb-2">
              <h4 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t('find.videos')}</h4>
              {res.videos.map((v) => { i++; const on = i === active; return (
                <Link key={v.id} href={`/watch?v=${v.id}`} onClick={() => go(`/watch?v=${v.id}`, term)} className={row(on)}>
                  <div className="relative aspect-[16/10] w-24 shrink-0 overflow-hidden rounded-lg bg-surface">{v.thumbnailUrl && <img src={v.thumbnailSmallUrl ?? v.thumbnailUrl} alt="" className="h-full w-full object-cover" />}</div>
                  <div className="min-w-0"><p className="line-clamp-1 font-semibold">{v.title}</p><p className="text-[13px] text-muted">{v.channel.name} · {duration(v.durationSeconds)}</p></div>
                  {on && <span className="ml-auto shrink-0 text-[12px] text-muted">↵ Watch</span>}
                </Link>
              ); })}
            </section>
          )}
          {res && res.channels.length > 0 && (
            <section className="mb-2">
              <h4 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t('find.spaces')}</h4>
              {res.channels.map((c) => { i++; return (
                <Link key={c.id} href={`/@${c.handle}`} onClick={() => go(`/@${c.handle}`, term)} className={row(i === active)}>
                  <Avatar name={c.name} src={c.avatarUrl} size={40} />
                  <div className="min-w-0"><p className="font-semibold">{c.name}</p><p className="text-[13px] text-muted" suppressHydrationWarning>@{c.handle} · {followersLabel(c.followerCount, locale)}</p></div>
                </Link>
              ); })}
            </section>
          )}
          {term.length >= 2 && res && !res.videos.length && !res.channels.length && <p className="px-3 py-6 text-center text-[14px] text-muted">Nothing matches &ldquo;{term}&rdquo; yet. Press Enter to search everything.</p>}
          {(term.length >= 2 ? suggest : recent).length > 0 && (
            <section>
              <h4 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{term.length >= 2 ? t('find.try') : t('find.recent')}</h4>
              <div className="flex flex-wrap gap-2 px-3 pt-1">
                {(term.length >= 2 ? suggest : recent).map((s) => { i++; return (
                  <Link key={s} href={`/results?q=${encodeURIComponent(s)}`} onClick={() => go(`/results?q=${encodeURIComponent(s)}`, s)} className={`rounded-xl px-3 py-1.5 text-[13px] font-medium ${i === active ? 'bg-brand text-on-brand' : 'bg-surface hover:bg-surface-hover'}`}>{s}</Link>
                ); })}
              </div>
            </section>
          )}
          {term.length < 2 && !recent.length && <p className="px-3 py-6 text-center text-[14px] text-muted">{t('find.twoLetters')}</p>}
        </div>
        <div className="hidden gap-5 bg-surface px-5 py-2.5 text-[12px] text-muted sm:flex">
          <span><kbd className="rounded-md border border-line bg-elevated px-1.5 font-sans">↑</kbd> <kbd className="rounded-md border border-line bg-elevated px-1.5 font-sans">↓</kbd> move</span>
          <span><kbd className="rounded-md border border-line bg-elevated px-1.5 font-sans">↵</kbd> open</span>
          <span><kbd className="rounded-md border border-line bg-elevated px-1.5 font-sans">/</kbd> opens Find anywhere</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
