'use client';

import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';

interface GoogleView { source: 'app' | 'environment' | 'none'; active: boolean; enabled: boolean; clientId: string; clientSecret: string; origin: string; redirectUri: string }

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 font-mono text-[13px]">
      <span className="min-w-0 flex-1 break-all">{text}</span>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => undefined); }} className="shrink-0 rounded-lg px-2 py-1 font-sans text-[12px] font-semibold hover:bg-surface-hover">{done ? 'Copied' : 'Copy'}</button>
    </span>
  );
}

/** Administration → Sign-in: Google sign-in switched on here, with the exact addresses to give Google. */
export function AdminSignIn() {
  const [g, setG] = useState<GoogleView | null>(null);
  const [form, setForm] = useState({ clientId: '', clientSecret: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: GoogleView) => { setG(r); setForm({ clientId: r.clientId, clientSecret: '' }); };
  useEffect(() => { api<GoogleView>('/admin/auth/google').then(apply).catch((e) => setError((e as Error).message)); }, []);
  const save = async (enabled: boolean) => {
    setBusy(true); setError(null); setMsg(null);
    try {
      apply(await api<GoogleView>('/admin/auth/google', { method: 'PUT', body: { enabled, clientId: form.clientId.trim(), ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}) } }));
      setMsg(enabled ? 'Google sign-in is on: “Continue with Google” now shows on the sign-in page.' : 'Google sign-in is off. People sign in with an email code.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!g) return error ? <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;

  return (
    <div className="mt-5 max-w-3xl space-y-4">
      <section className="space-y-4 rounded-2xl border border-line p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-[18px] font-semibold">Google sign-in</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${g.active ? 'bg-brand-soft text-brand' : 'bg-surface text-muted'}`}>{g.active ? 'On' : 'Off'}{g.source === 'environment' ? ' · from server settings' : ''}</span>
        </div>
        <p className="text-[14px] text-muted">People can always sign in with a code sent to their email. Turning this on adds <b className="text-ink">Continue with Google</b> to the sign-in page.</p>
        <ol className="list-decimal space-y-3 pl-5 text-[14px]">
          <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="font-semibold text-brand underline">Google Cloud Console → Credentials</a> (create a project if you have none), then <b>Create credentials → OAuth client ID</b> → <b>Web application</b>. The first time, Google asks you to fill in the consent screen: app name <b>Free Me</b>, your support email, and your logo.</li>
          <li>Under <b>Authorised JavaScript origins</b> add:<div className="mt-1"><Copy text={g.origin} /></div></li>
          <li>Under <b>Authorised redirect URIs</b> add:<div className="mt-1"><Copy text={g.redirectUri} /></div></li>
          <li>Create it, then paste the <b>Client ID</b> and <b>Client secret</b> here and press <b>Turn on</b>.</li>
        </ol>
        {!g.origin.startsWith('https://') && <p className="rounded-xl bg-accent-soft px-4 py-3 text-[13px] text-on-accent-soft">This server’s address starts with http://. Google accepts that only for localhost: on your real domain, set APP_URL to https://… first.</p>}
        <div className="grid gap-3">
          <label className="block"><span className="text-[13px] font-semibold">Client ID</span><input className={`mt-1 ${inputClass} font-mono text-[13px]`} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="1234567890-abc….apps.googleusercontent.com" autoComplete="off" spellCheck={false} /></label>
          <label className="block"><span className="text-[13px] font-semibold">Client secret</span><input className={`mt-1 ${inputClass} font-mono text-[13px]`} type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder={g.clientSecret ? `Saved (${g.clientSecret}): leave empty to keep it` : 'GOCSPX-…'} autoComplete="new-password" /></label>
        </div>
        {msg && <p role="status" className="rounded-xl bg-brand-soft px-4 py-3 text-[14px] text-brand">{msg}</p>}
        {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void save(true)} className="h-10 rounded-xl bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">{g.active ? 'Save' : 'Turn on'}</button>
          {g.active && <button type="button" disabled={busy} onClick={() => void save(false)} className="h-10 rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover disabled:opacity-50">Turn off</button>}
          {g.active && <a href="/login" target="_blank" rel="noreferrer" className="flex h-10 items-center rounded-xl px-4 text-[14px] font-semibold text-brand hover:bg-surface">Try the sign-in page</a>}
        </div>
      </section>
    </div>
  );
}
