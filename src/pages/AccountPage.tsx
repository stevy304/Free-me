import { Film, ShieldCheck } from 'lucide-react';
import { EmptyState } from '../components/layout/EmptyState';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { pageUrl } from '../services/routes';

export type Account = { id: string; email: string };
type Upload = { id: string; title: string; visibility: 'public' | 'private'; status: string };

async function request(path: string, method = 'GET', data?: object) {
  const response = await fetch('/api' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The video service is unavailable.');
  return body;
}

export function AccountPage({ account, onChange, onVideoChange }: {
  account: Account | null;
  onChange: (account: Account | null) => void;
  onVideoChange: () => void;
}) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let disposed = false;
    setUploads([]);
    if (account) void request('/videos/mine')
      .then((body) => { if (!disposed) setUploads(body.videos); })
      .catch((cause) => { if (!disposed) setError(cause.message); });
    return () => { disposed = true; };
  }, [account]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act(async () => {
      const body = await request('/account/' + (register ? 'register' : 'login'), 'POST', {
        email: form.get('email'), password: form.get('password'),
      });
      onChange(body.account);
    });
  }

  function edit(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act(async () => {
      const video = await request('/videos/' + id, 'PATCH', { title: form.get('title'), visibility: form.get('visibility') });
      setUploads((items) => items.map((item) => item.id === id ? video : item));
      onVideoChange();
      setNotice('Video details saved.');
    });
  }

  return (
    <section className={`workspace-page upload-page ${account ? '' : 'account-signin'}`}>
      <header className="workspace-heading">
        {!account && <span className="app-empty-icon"><ShieldCheck size={24} aria-hidden="true" /></span>}
        <p className="workspace-eyebrow">Creator account</p>
        <h1>{account ? 'Your videos' : register ? 'Create an account' : 'Sign in to Free Me'}</h1>
        <p>{account ? account.email : 'Sign in to upload and manage your videos.'}</p>
      </header>
      {error && <p role="alert" className="upload-error mb-4">{error}</p>}
      {notice && <p role="status" className="upload-status mb-4">{notice}</p>}
      {!account ? (
        <form onSubmit={authenticate} className="workspace-panel upload-details">
          <label>Email<input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required /></label>
          <button disabled={busy} className="workspace-primary" type="submit">{register ? 'Create account' : 'Sign in'}</button>
          <button type="button" disabled={busy} className="underline text-sm" onClick={() => { setRegister(!register); setError(''); }}>
            {register ? 'Already have an account? Sign in' : 'New to Free Me? Create an account'}
          </button>
        </form>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <a className="workspace-primary" href="/upload">Upload video</a>
            <button type="button" className="underline" disabled={busy} onClick={() => void act(async () => {
              await request('/account/logout', 'POST', {});
              onChange(null);
            })}>Sign out</button>
          </div>
          {uploads.length === 0 && <EmptyState icon={Film} title="Your library is empty" description="Videos you upload will appear here. You can manage their titles and visibility from this page." />}
          {uploads.map((video) => (
            <form key={video.id} onSubmit={(event) => edit(event, video.id)} className="workspace-panel upload-details">
              <p className="capitalize">{video.status}</p>
              <label>Title<input name="title" defaultValue={video.title} maxLength={120} required /></label>
              <label>Visibility<select name="visibility" defaultValue={video.visibility}>
                <option value="private">Private</option><option value="public">Public</option>
              </select></label>
              <div className="flex items-center gap-4">
                <button type="submit" className="workspace-primary" disabled={busy}>Save changes</button>
                {video.status === 'ready' && <a className="underline" href={pageUrl('watch', video.id)}>Watch video</a>}
              </div>
            </form>
          ))}
        </div>
      )}
    </section>
  );
}
