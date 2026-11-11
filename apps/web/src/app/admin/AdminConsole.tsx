'use client';

import * as Icon from '@/components/icons';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';
import type { Role } from '@/lib/types';
import { useShell } from '@/components/shell/ShellContext';
import { AdminMoney } from './AdminMoney';
import { AdminSignIn } from './AdminSignIn';
import { AdminPlaybackHealth } from './AdminPlaybackHealth';
import { AdminLaunch } from './AdminLaunch';

interface UserRow { id: string; email: string; roles: Role[]; status: string; createdAt: string; lastLoginAt: string | null; displayName: string | null; channelHandle: string | null }
interface AuditRow { id: string; action: string; entityType: string; entityId: string | null; ipAddress: string | null; createdAt: string; actorEmail: string | null; detailsJson: string | null }
const EDITABLE: Role[] = ['MODERATOR', 'ADVERTISER', 'ADMIN'];

/** Accounts (roles, suspension) and the audit log. Every change is checked and recorded by the API. */
export function AdminConsole({ selfId }: { selfId: string }) {
  const { locale } = useShell();
  const [tab, setTab] = useState<'users' | 'money' | 'signin' | 'launch' | 'health' | 'audit'>('users');
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadUsers = useCallback(async (query: string) => {
    try { setUsers((await api<{ users: UserRow[] }>(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`)).users); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void loadUsers(''); }, [loadUsers]);
  useEffect(() => { if (tab === 'audit' && !audit) api<{ entries: AuditRow[] }>('/admin/audit').then((r) => setAudit(r.entries)).catch((e) => setError(e.message)); }, [tab, audit]);

  const change = async (u: UserRow, body: { roles?: Role[]; status?: string }) => {
    setBusy(u.id); setError(null);
    try {
      if (body.roles) { const r = await api<{ roles: Role[] }>(`/admin/users/${u.id}/roles`, { method: 'PATCH', body: { roles: body.roles } }); setUsers((list) => list!.map((x) => (x.id === u.id ? { ...x, roles: r.roles } : x))); }
      if (body.status) { const r = await api<{ status: string }>(`/admin/users/${u.id}/status`, { method: 'PATCH', body: { status: body.status } }); setUsers((list) => list!.map((x) => (x.id === u.id ? { ...x, status: r.status } : x))); }
      setAudit(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const tabClass = (on: boolean) => `border-b-2 px-1 pb-3 text-[15px] font-medium ${on ? 'border-ink' : 'border-transparent text-muted'}`;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <h1 className="text-[28px] font-semibold tracking-tight">Administration</h1>
      <nav className="mt-4 flex gap-6 overflow-x-auto whitespace-nowrap border-b border-line"><button className={tabClass(tab === 'users')} onClick={() => setTab('users')}>Accounts</button><button className={tabClass(tab === 'money')} onClick={() => setTab('money')}>Money</button><button className={tabClass(tab === 'signin')} onClick={() => setTab('signin')}>Sign-in</button><button className={tabClass(tab === 'launch')} onClick={() => setTab('launch')}>Launch</button><button className={tabClass(tab === 'health')} onClick={() => setTab('health')}>Playback Health</button><button className={tabClass(tab === 'audit')} onClick={() => setTab('audit')}>Audit log</button></nav>
      {error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      {tab === 'health' ? <AdminPlaybackHealth /> : tab === 'money' ? <AdminMoney /> : tab === 'signin' ? <AdminSignIn /> : tab === 'launch' ? <AdminLaunch /> : tab === 'users' ? (
        <>
          <form className="mt-5 flex max-w-md items-center gap-2 rounded-full border border-line px-4" onSubmit={(e) => { e.preventDefault(); void loadUsers(q); }}>
            <Icon.Search size={18} className="text-muted" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email, name or @handle" aria-label="Find accounts" className="h-10 flex-1 bg-transparent text-[15px] outline-none" />
          </form>
          {!users ? <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" /> : (
            <div className="mt-5 overflow-x-auto rounded-2xl border border-line">
              <table className="w-full min-w-[760px] text-left text-[14px]">
                <thead className="bg-surface text-[12px] uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Account</th><th className="px-4 py-3">Roles</th><th className="px-4 py-3">Last sign-in</th><th className="px-4 py-3">Status</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-3"><p className="font-medium">{u.displayName ?? '—'}</p><p className="text-muted">{u.email}{u.channelHandle && ` · @${u.channelHandle}`}</p></td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {u.roles.includes('CREATOR') && <span className="rounded-full bg-surface px-2.5 py-1 text-[12px]">Creator</span>}
                          {EDITABLE.map((r) => {
                            const on = u.roles.includes(r);
                            const locked = r === 'ADMIN' && u.id === selfId;
                            return <button key={r} type="button" disabled={busy === u.id || locked} aria-pressed={on} title={locked ? 'You cannot remove your own administrator role' : undefined}
                              onClick={() => void change(u, { roles: (on ? u.roles.filter((x) => x !== r) : [...u.roles, r]).filter((x) => x !== 'VIEWER' && x !== 'CREATOR') })}
                              className={`rounded-full border px-2.5 py-1 text-[12px] disabled:opacity-50 ${on ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink'}`}>{r.charAt(0) + r.slice(1).toLowerCase()}</button>;
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt, locale) : 'Never'}</td>
                      <td className="px-4 py-3">
                        {u.id === selfId ? <span className="text-muted">You</span> : (
                          <button type="button" disabled={busy === u.id} onClick={() => void change(u, { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}
                            className={`rounded-full px-3 py-1 text-[13px] font-medium disabled:opacity-50 ${u.status === 'ACTIVE' ? 'bg-surface hover:bg-surface-hover' : 'bg-danger/10 text-danger'}`}>
                            {u.status === 'ACTIVE' ? 'Suspend' : 'Suspended · reactivate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!users.length && <p className="px-4 py-8 text-center text-muted">No accounts found.</p>}
            </div>
          )}
        </>
      ) : !audit ? <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" /> : (
        <ul className="mt-5 divide-y divide-line rounded-2xl border border-line text-[14px]">
          {audit.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
              <span className="font-mono text-[12px] font-medium">{a.action}</span>
              <span className="text-muted">{a.actorEmail ?? 'system'} · {a.entityType}{a.entityId ? ` ${a.entityId.slice(0, 8)}` : ''}</span>
              <span className="ml-auto text-[12px] text-faint">{timeAgo(a.createdAt, locale)}{a.ipAddress ? ` · ${a.ipAddress}` : ''}</span>
            </li>
          ))}
          {!audit.length && <li className="px-4 py-8 text-center text-muted">No entries yet.</li>}
        </ul>
      )}
    </div>
  );
}
