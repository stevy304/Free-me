'use client';

import { Clapperboard, Compass, Film, Home, Settings, Shield, SquarePlay, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Avatar } from '../Avatar';
import { Logo } from '../Logo';
import { useShell } from './ShellContext';
import type { Category, ChannelInfo } from '@/lib/types';

function Row({ href, icon, label, active, onClick }: { href: string; icon: ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <Link href={href} onClick={onClick} aria-current={active ? 'page' : undefined}
      className={`flex h-10 items-center gap-6 rounded-lg px-3 text-[14px] ${active ? 'bg-surface font-medium' : 'hover:bg-surface'}`}>
      <span className="grid w-6 shrink-0 place-items-center">{icon}</span><span className="truncate">{label}</span>
    </Link>
  );
}

function MiniRow({ href, icon, label, active }: { href: string; icon: ReactNode; label: string; active?: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={`flex flex-col items-center gap-1.5 rounded-lg px-1 pb-3.5 pt-4 text-[10px] ${active ? 'bg-surface' : 'hover:bg-surface'}`}>
      {icon}<span className="max-w-full truncate">{label}</span>
    </Link>
  );
}

/** Full sidebar (wide screens), narrow rail (tablets, or when collapsed) and a drawer on small screens. */
export function Sidebar() {
  const { viewer, collapsed, drawerOpen, toggleSidebar, closeDrawer } = useShell();
  const path = usePathname();
  const params = useSearchParams();
  const [categories, setCategories] = useState<Category[]>([]);
  const [subs, setSubs] = useState<ChannelInfo[]>([]);
  const [showAllSubs, setShowAllSubs] = useState(false);

  useEffect(() => { fetch('/api/categories').then((r) => r.ok ? r.json() : { categories: [] }).then((d) => setCategories(d.categories)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!viewer) { setSubs([]); return; }
    fetch('/api/feed/subscriptions?limit=1').then((r) => r.ok ? r.json() : { channels: [] }).then((d) => setSubs(d.channels ?? [])).catch(() => undefined);
  }, [viewer, path]);
  useEffect(() => { closeDrawer(); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const icon = (I: typeof Home, active: boolean) => <I size={24} strokeWidth={active ? 2.2 : 1.6} />;
  const home = path === '/' && !params.get('category');
  const main = [
    { href: '/', label: 'Home', I: Home, active: home },
    { href: '/shorts', label: 'Shorts', I: Clapperboard, active: path === '/shorts' },
    { href: '/feed/subscriptions', label: 'Subscriptions', I: Users, active: path === '/feed/subscriptions' },
  ];
  const you = viewer?.channel
    ? { href: `/@${viewer.channel.handle}`, label: 'Your channel', I: SquarePlay, active: path === `/channel/${viewer.channel.handle}` }
    : { href: viewer ? '/channel/create' : '/login?returnTo=/channel/create', label: 'Create a channel', I: UserPlus, active: path === '/channel/create' };

  const full = (
    <nav aria-label="Main" className="thin-scrollbar flex h-full flex-col overflow-y-auto px-3 pb-6">
      <div className="space-y-0.5 border-b border-line py-3">{main.map((m) => <Row key={m.href} href={m.href} icon={icon(m.I, m.active)} label={m.label} active={m.active} />)}</div>
      <div className="space-y-0.5 border-b border-line py-3">
        <p className="px-3 pb-1 pt-1 text-[16px] font-semibold">You</p>
        <Row href={you.href} icon={icon(you.I, you.active)} label={you.label} active={you.active} />
        {viewer?.channel && <Row href="/studio" icon={icon(Film, path === '/studio')} label="Your videos" active={path === '/studio'} />}
        {viewer && <Row href="/settings" icon={icon(Settings, path === '/settings')} label="Settings" active={path === '/settings'} />}
        {viewer?.user.roles.includes('ADMIN') && <Row href="/admin" icon={icon(Shield, path === '/admin')} label="Administration" active={path === '/admin'} />}
      </div>
      {!viewer && (
        <div className="border-b border-line px-3 py-4 text-[14px]">
          <p className="text-ink">Sign in to subscribe to channels and follow what you like.</p>
          <Link href={`/login?returnTo=${encodeURIComponent(path)}`} className="mt-3 inline-flex h-9 items-center rounded-full border border-line px-4 font-medium text-brand hover:bg-brand-soft">Sign in</Link>
        </div>
      )}
      {viewer && subs.length > 0 && (
        <div className="space-y-0.5 border-b border-line py-3">
          <p className="px-3 pb-1 pt-1 text-[16px] font-semibold">Subscriptions</p>
          {(showAllSubs ? subs : subs.slice(0, 7)).map((c) => (
            <Row key={c.id} href={`/@${c.handle}`} icon={<Avatar name={c.name} src={c.avatarUrl} size={24} />} label={c.name} active={path === `/channel/${c.handle}`} />
          ))}
          {subs.length > 7 && <button type="button" onClick={() => setShowAllSubs((s) => !s)} className="flex h-10 w-full items-center gap-6 rounded-lg px-3 text-[14px] hover:bg-surface"><span className="w-6" />{showAllSubs ? 'Show fewer' : `Show ${subs.length - 7} more`}</button>}
        </div>
      )}
      {categories.length > 0 && (
        <div className="space-y-0.5 border-b border-line py-3">
          <p className="px-3 pb-1 pt-1 text-[16px] font-semibold">Explore</p>
          {categories.map((c) => <Row key={c.id} href={`/?category=${c.slug}`} icon={<Compass size={22} strokeWidth={1.6} />} label={c.name} active={path === '/' && params.get('category') === c.slug} />)}
        </div>
      )}
      <p className="px-3 pt-4 text-[12px] leading-5 text-faint">Free Me: your content, your freedom, your opportunity.<br />© {new Date().getFullYear()} Free Me</p>
    </nav>
  );

  return (
    <>
      {/* Narrow rail: tablets always; desktops when collapsed. */}
      <aside className={`fixed bottom-0 left-0 top-14 z-20 hidden w-[72px] flex-col gap-1 px-1 pt-1 md:flex ${collapsed ? '' : 'xl:hidden'}`}>
        {[...main, you].map((m) => <MiniRow key={m.label} href={m.href} icon={icon(m.I, m.active)} label={m.label === 'Create a channel' ? 'Create' : m.label === 'Your channel' ? 'You' : m.label} active={m.active} />)}
      </aside>
      {/* Full sidebar on wide screens. */}
      <aside className={`fixed bottom-0 left-0 top-14 z-20 hidden w-60 ${collapsed ? '' : 'xl:block'}`}>{full}</aside>
      {/* Drawer on smaller screens. */}
      <div className={`fixed inset-0 z-50 xl:hidden ${drawerOpen ? '' : 'pointer-events-none invisible'}`} aria-hidden={!drawerOpen}>
        <div className={`absolute inset-0 bg-black/50 transition-opacity ${drawerOpen ? 'opacity-100' : 'opacity-0'}`} onClick={closeDrawer} />
        <aside className={`absolute bottom-0 left-0 top-0 w-60 bg-elevated transition-transform ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="flex h-14 items-center gap-3 px-4">
             <button type="button" onClick={closeDrawer} aria-label="Close menu" className="rounded-full p-2 hover:bg-surface"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 6h18M3 12h18M3 18h18" /></svg></button>
            <Logo />
          </div>
          <div className="h-[calc(100%-3.5rem)]">{full}</div>
        </aside>
      </div>
    </>
  );
}
