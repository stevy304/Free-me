'use client';

import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { api } from '@/lib/client-api';
import { timeAgo } from '@/lib/format';

interface AndroidFile { name: string; url: string; sizeBytes: number; version: string; uploadedAt: string }
interface AndroidInfo { file: AndroidFile | null; packageName: string | null; fingerprints: string[] }

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Administration → Android app (ANDROID.md): upload the APK the "Android app" GitHub workflow builds; people download
 * it from Free Me. The link settings let Android open the app full screen (no browser address bar).
 */
export function AdminAndroid() {
  const [info, setInfo] = useState<AndroidInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [pkg, setPkg] = useState('rw.freeme.app');
  const [prints, setPrints] = useState('');

  const load = () => api<AndroidInfo>('/admin/app/android').then((r) => { setInfo(r); if (r.packageName) setPkg(r.packageName); setPrints(r.fingerprints.join('\n')); }).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await fetch(`/api/admin/app/android?version=${encodeURIComponent(version.trim())}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/vnd.android.package-archive' }, body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message ?? 'The upload failed.');
      setFile(null); setVersion(''); setNote(`Version ${d.file.version} is now the download.`); await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Remove the Android app download? People will no longer be able to download it.')) return;
    setBusy(true); setError(null);
    try { await api('/admin/app/android', { method: 'DELETE' }); setNote('Removed.'); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const link = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setNote(null);
    try { await api('/admin/app/android/link', { method: 'PUT', body: { packageName: pkg.trim(), fingerprints: prints.split(/[\s,]+/).filter(Boolean) } }); setNote('Saved. Android checks /.well-known/assetlinks.json when the app is installed.'); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!info) return error ? <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-danger">{error}</p> : <Icon.Spinner className="mx-auto mt-10 animate-spin text-muted" />;
  const field = 'h-10 w-full rounded-xl border border-line bg-surface px-3 text-[14px] outline-none focus:border-brand';
  return (
    <div className="mt-5 max-w-3xl space-y-5">
      <p className="text-[14px] text-muted">The Android app opens Free Me full screen from its own icon. The GitHub workflow <b>Android app</b> builds it from <code>android/</code>: download its <b>free-me-apk</b> result, then upload the APK here. People download it from the account menu, the You page and <a href="/app" className="text-brand hover:underline">/app</a>.</p>
      {note && <p role="status" className="rounded-xl bg-brand-soft px-4 py-3 text-[14px] text-brand">{note}</p>}
      {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}

      <section className="facet bg-elevated p-5">
        <h2 className="text-[17px] font-bold">Download</h2>
        {info.file ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[14px]">
            <Icon.CheckCircle size={22} className="text-brand" />
            <span className="flex-1">Version <b>{info.file.version}</b> · {mb(info.file.sizeBytes)} · uploaded <span suppressHydrationWarning>{timeAgo(info.file.uploadedAt)}</span></span>
            <a href="/api/app/android/download" className="facet-sm h-9 bg-surface px-3 py-2 text-[13px] font-semibold hover:bg-surface-hover">Test download</a>
            <button type="button" onClick={remove} disabled={busy} className="facet-sm h-9 px-3 text-[13px] font-semibold text-danger hover:bg-danger/10">Remove</button>
          </div>
        ) : <p className="mt-2 text-[14px] text-muted">No APK uploaded yet: the download buttons are hidden.</p>}
        <form onSubmit={upload} className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
          <label className="text-[13px] font-semibold">APK file<input type="file" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-[13px]" /></label>
          <label className="text-[13px] font-semibold">Version<input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" className={`mt-1 ${field}`} /></label>
          <button type="submit" disabled={!file || !version.trim() || busy} className="facet-sm flex h-10 items-center justify-center gap-2 bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">{busy && <Icon.Spinner size={16} className="animate-spin" />}Upload</button>
        </form>
      </section>

      <section className="facet bg-elevated p-5">
        <h2 className="text-[17px] font-bold">Full screen (Digital Asset Links)</h2>
        <p className="mt-1 text-[13px] text-muted">So Android trusts that the app and this site belong together and hides the address bar. The workflow prints the fingerprint of the key it signs with (its log, step &quot;Signing fingerprint&quot;). Google Play adds its own: add both.</p>
        <form onSubmit={link} className="mt-3 space-y-3">
          <label className="block text-[13px] font-semibold">Package name<input value={pkg} onChange={(e) => setPkg(e.target.value)} className={`mt-1 ${field}`} /></label>
          <label className="block text-[13px] font-semibold">SHA-256 certificate fingerprints (one per line)
            <textarea value={prints} onChange={(e) => setPrints(e.target.value)} rows={3} placeholder="AB:CD:EF:…" className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 font-mono text-[12px] outline-none focus:border-brand" />
          </label>
          <button type="submit" disabled={busy} className="facet-sm h-10 bg-brand px-4 text-[14px] font-semibold text-on-brand disabled:opacity-50">Save</button>
        </form>
      </section>
    </div>
  );
}
