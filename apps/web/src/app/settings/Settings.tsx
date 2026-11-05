'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { BIO_MAX, CHANNEL_DESCRIPTION_MAX, CHANNEL_NAME_MAX, DISPLAY_NAME_MAX } from '@free-me/shared';
import { CountrySelect, LanguageSelect, inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';
import { fullDate, timeAgo } from '@/lib/format';
import type { Viewer } from '@/lib/types';
import type { SessionRow } from './page';
import { useShell } from '@/components/shell/ShellContext';

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-b border-line py-8 last:border-0">
      <h2 className="text-[20px] font-semibold">{title}</h2>
      {intro && <p className="mt-1 text-[14px] text-muted">{intro}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function SaveBar({ busy, message, disabled }: { busy: boolean; message: { ok: boolean; text: string } | null; disabled?: boolean }) {
  return (
    <div className="mt-6 flex items-center justify-end gap-4">
      {message && <p role="status" className={`text-[14px] ${message.ok ? 'text-brand' : 'text-danger'}`}>{message.text}</p>}
      <button type="submit" disabled={busy || disabled} className="flex h-10 items-center gap-2 rounded-full bg-strong px-5 text-[14px] font-medium text-on-strong hover:opacity-90 disabled:opacity-40">{busy && <Icon.Spinner size={16} className="animate-spin" />}Save</button>
    </div>
  );
}

const zones = (() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return []; } })();

function device(ua: string | null) {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Mobile|Android|iPhone/.test(ua) };
}

export function Settings({ viewer, sessions: initial }: { viewer: Viewer; sessions: SessionRow[] }) {
  const router = useRouter();
  const { locale } = useShell();
  const p = viewer.profile;
  const [profile, setProfile] = useState({ displayName: p?.displayName ?? '', bio: p?.bio ?? '', country: p?.country ?? null, city: p?.city ?? '', preferredLanguage: p?.preferredLanguage ?? 'en', timezone: p?.timezone ?? null });
  const [pBusy, setPBusy] = useState(false);
  const [pMsg, setPMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const c = viewer.channel;
  const [channel, setChannel] = useState({ name: c?.name ?? '', description: c?.description ?? '', country: c?.country ?? null, defaultLanguage: c?.defaultLanguage ?? null });
  const [cBusy, setCBusy] = useState(false);
  const [cMsg, setCMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [sessions, setSessions] = useState(initial);
  const [sMsg, setSMsg] = useState<string | null>(null);
  const deviceZone = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } }, []);

  const saveProfile = async () => {
    setPBusy(true); setPMsg(null);
    try { await api('/me/profile', { method: 'PATCH', body: { ...profile, city: profile.city || null } }); setPMsg({ ok: true, text: 'Saved' }); router.refresh(); }
    catch (e) { setPMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }); } finally { setPBusy(false); }
  };
  const saveChannel = async () => {
    setCBusy(true); setCMsg(null);
    try { await api('/channels/mine', { method: 'PATCH', body: channel }); setCMsg({ ok: true, text: 'Saved' }); router.refresh(); }
    catch (e) { setCMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }); } finally { setCBusy(false); }
  };
  const revoke = async (id: string | null) => {
    setSMsg(null);
    try {
      if (id) { await api(`/me/sessions/${id}`, { method: 'DELETE', body: {} }); setSessions((s) => s.filter((x) => x.id !== id)); }
      else { const r = await api<{ revoked: number }>('/me/sessions', { method: 'DELETE', body: {} }); setSessions((s) => s.filter((x) => x.current)); setSMsg(`Signed out of ${r.revoked} other ${r.revoked === 1 ? 'device' : 'devices'}.`); }
    } catch (e) { setSMsg(e instanceof Error ? e.message : 'Could not sign out that device.'); }
  };

  const label = 'text-[14px] font-medium';
  return (
    <div className="mx-auto flex max-w-5xl gap-10 px-4 py-6 sm:px-6">
      <nav aria-label="Settings" className="sticky top-20 hidden h-fit w-48 shrink-0 space-y-1 md:block">
        {[['account', 'Account'], ['profile', 'Profile'], ...(c ? [['channel', 'Channel']] : []), ['devices', 'Signed-in devices']].map(([id, t]) => (
          <a key={id} href={`#${id}`} className="block rounded-lg px-3 py-2 text-[14px] hover:bg-surface">{t}</a>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <h1 className="text-[28px] font-semibold tracking-tight">Settings</h1>

        <Section id="account" title="Account" intro="You sign in with Google or a one-time code sent to this address.">
          <dl className="grid gap-4 text-[15px] sm:grid-cols-[160px_1fr]">
            <dt className="text-muted">Email</dt><dd className="break-all">{viewer.user.email}</dd>
            <dt className="text-muted">Account type</dt><dd>{viewer.user.roles.filter((r) => r !== 'VIEWER').map((r) => r.charAt(0) + r.slice(1).toLowerCase()).join(', ') || 'Viewer'}</dd>
            <dt className="text-muted">Member since</dt><dd>{fullDate(viewer.user.createdAt, locale)}</dd>
            <dt className="text-muted">Channel</dt><dd>{c ? <Link href={`/@${c.handle}`} className="text-brand">@{c.handle}</Link> : <Link href="/channel/create" className="text-brand">Create a channel</Link>}</dd>
          </dl>
        </Section>

        <Section id="profile" title="Profile" intro="Your name and picture appear with your comments.">
          <form onSubmit={(e) => { e.preventDefault(); void saveProfile(); }} className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2"><label htmlFor="dn" className={label}>Display name</label><input id="dn" required maxLength={DISPLAY_NAME_MAX} value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} className={`${inputClass} mt-2`} /></div>
            <div className="sm:col-span-2"><label htmlFor="bio" className={label}>About you</label><textarea id="bio" rows={3} maxLength={BIO_MAX} value={profile.bio} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-brand" /></div>
            <div><label htmlFor="country" className={label}>Country</label><div className="mt-2"><CountrySelect id="country" value={profile.country} onChange={(v) => setProfile({ ...profile, country: v })} /></div></div>
            <div><label htmlFor="city" className={label}>City</label><input id="city" maxLength={100} value={profile.city} onChange={(e) => setProfile({ ...profile, city: e.target.value })} className={`${inputClass} mt-2`} /></div>
            <div><label htmlFor="lang" className={label}>Language</label><div className="mt-2"><LanguageSelect id="lang" value={profile.preferredLanguage} onChange={(v) => setProfile({ ...profile, preferredLanguage: v ?? 'en' })} /></div></div>
            <div>
              <label htmlFor="tz" className={label}>Time zone</label>
              <select id="tz" value={profile.timezone ?? ''} onChange={(e) => setProfile({ ...profile, timezone: e.target.value || null })} className={`${inputClass} mt-2`}>
                <option value="">Not set{deviceZone ? ` (this device: ${deviceZone})` : ''}</option>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2"><SaveBar busy={pBusy} message={pMsg} /></div>
          </form>
        </Section>

        {c && (
          <Section id="channel" title="Channel" intro={`Shown on your channel page at /@${c.handle}.`}>
            <form onSubmit={(e) => { e.preventDefault(); void saveChannel(); }} className="grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2"><label htmlFor="cn" className={label}>Channel name</label><input id="cn" required maxLength={CHANNEL_NAME_MAX} value={channel.name} onChange={(e) => setChannel({ ...channel, name: e.target.value })} className={`${inputClass} mt-2`} /></div>
              <div className="sm:col-span-2"><label htmlFor="cd" className={label}>Description</label><textarea id="cd" rows={5} maxLength={CHANNEL_DESCRIPTION_MAX} value={channel.description} onChange={(e) => setChannel({ ...channel, description: e.target.value })} className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-brand" /></div>
              <div><label htmlFor="cc" className={label}>Country</label><div className="mt-2"><CountrySelect id="cc" value={channel.country} onChange={(v) => setChannel({ ...channel, country: v })} /></div></div>
              <div><label htmlFor="cl" className={label}>Main language</label><div className="mt-2"><LanguageSelect id="cl" allowEmpty value={channel.defaultLanguage} onChange={(v) => setChannel({ ...channel, defaultLanguage: v })} /></div></div>
              <div className="sm:col-span-2"><SaveBar busy={cBusy} message={cMsg} /></div>
            </form>
          </Section>
        )}

        <Section id="devices" title="Signed-in devices" intro="Sign out of a device you do not recognise.">
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {sessions.map((s) => {
              const d = device(s.userAgent);
              return (
                <li key={s.id} className="flex items-center gap-4 px-4 py-3.5">
                  {d.mobile ? <Icon.Phone size={22} className="shrink-0 text-muted" /> : <Icon.Laptop size={22} className="shrink-0 text-muted" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">{d.label}{s.current && <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[12px] font-medium text-brand">This device</span>}</p>
                    <p className="text-[13px] text-muted" suppressHydrationWarning>Signed in with {s.method === 'google' ? 'Google' : 'an email code'} · active {timeAgo(s.lastSeenAt, locale)}{s.ipAddress ? ` · ${s.ipAddress}` : ''}</p>
                  </div>
                  {!s.current && <button type="button" onClick={() => void revoke(s.id)} className="rounded-full px-3 py-1.5 text-[14px] font-medium text-brand hover:bg-brand-soft">Sign out</button>}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex items-center justify-between gap-4">
            <p role="status" className="text-[14px] text-muted">{sMsg}</p>
            {sessions.length > 1 && <button type="button" onClick={() => void revoke(null)} className="h-10 rounded-full bg-surface px-4 text-[14px] font-medium hover:bg-surface-hover">Sign out of all other devices</button>}
          </div>
        </Section>
      </div>
    </div>
  );
}
