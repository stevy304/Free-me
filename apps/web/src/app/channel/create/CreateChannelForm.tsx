'use client';

import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CHANNEL_DESCRIPTION_MAX, CHANNEL_NAME_MAX, handleProblem, normalizeHandle } from '@free-me/shared';
import { Avatar } from '@/components/Avatar';
import { CountrySelect, LanguageSelect, inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';

const suggestHandle = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30);

export function CreateChannelForm({ suggestedName, country: c0, language: l0, avatarUrl }: { suggestedName: string; country: string | null; language: string; avatarUrl: string | null }) {
  const [name, setName] = useState(suggestedName);
  const [handle, setHandle] = useState(suggestHandle(suggestedName));
  const [description, setDescription] = useState('');
  const [country, setCountry] = useState<string | null>(c0);
  const [language, setLanguage] = useState<string | null>(l0);
  const [check, setCheck] = useState<{ state: 'idle' | 'checking' | 'ok' | 'bad'; reason?: string }>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const local = handleProblem(handle);
    if (!handle) { setCheck({ state: 'idle' }); return; }
    if (local) { setCheck({ state: 'bad', reason: local }); return; }
    setCheck({ state: 'checking' });
    const t = setTimeout(() => {
      api<{ available: boolean; reason?: string }>(`/channels/handle-available?handle=${encodeURIComponent(handle)}`)
        .then((r) => setCheck(r.available ? { state: 'ok' } : { state: 'bad', reason: r.reason })).catch(() => setCheck({ state: 'idle' }));
    }, 300);
    return () => clearTimeout(t);
  }, [handle]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ channel: { handle: string } }>('/channels', { body: { handle, name, description: description || undefined, country: country ?? undefined, defaultLanguage: language ?? undefined } });
      window.location.href = `/@${r.channel.handle}`;
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create the channel.'); setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-[28px] font-semibold tracking-tight">Create your channel</h1>
      <p className="mt-1.5 text-[15px] text-muted">Your channel is your home on Free Me: where people find your videos and subscribe.</p>
      <div className="mt-8 flex justify-center"><Avatar name={name || '?'} src={avatarUrl} size={112} /></div>
      <form className="mt-8 space-y-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label htmlFor="name" className="text-[14px] font-medium">Name</label>
          <input id="name" required maxLength={CHANNEL_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-2`} />
        </div>
        <div>
          <label htmlFor="handle" className="text-[14px] font-medium">Handle</label>
          <div className="relative mt-2">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-muted">@</span>
            <input id="handle" required value={handle} onChange={(e) => setHandle(normalizeHandle(e.target.value))} maxLength={30} autoCapitalize="none" spellCheck={false} aria-describedby="handle-help" className={`${inputClass} pl-8 pr-10`} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              {check.state === 'checking' && <Loader2 size={18} className="animate-spin text-muted" />}
              {check.state === 'ok' && <Check size={18} className="text-brand" aria-label="Available" />}
              {check.state === 'bad' && <X size={18} className="text-danger" aria-label="Not available" />}
            </span>
          </div>
          <p id="handle-help" className={`mt-1.5 text-[13px] ${check.state === 'bad' ? 'text-danger' : 'text-muted'}`}>{check.state === 'bad' ? check.reason : `Your channel address: /@${handle || 'handle'}`}</p>
        </div>
        <div>
          <label htmlFor="description" className="text-[14px] font-medium">Description <span className="font-normal text-muted">(optional)</span></label>
          <textarea id="description" rows={4} maxLength={CHANNEL_DESCRIPTION_MAX} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Tell viewers what your channel is about"
            className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-brand" />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div><label htmlFor="country" className="text-[14px] font-medium">Country</label><div className="mt-2"><CountrySelect id="country" value={country} onChange={setCountry} /></div></div>
          <div><label htmlFor="language" className="text-[14px] font-medium">Main language</label><div className="mt-2"><LanguageSelect id="language" value={language} onChange={setLanguage} /></div></div>
        </div>
        {error && <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="submit" disabled={busy || check.state !== 'ok' || !name.trim()} className="flex h-10 items-center gap-2 rounded-full bg-strong px-6 text-[14px] font-medium text-on-strong hover:opacity-90 disabled:opacity-40">
            {busy && <Loader2 size={16} className="animate-spin" />}Create channel
          </button>
        </div>
      </form>
    </div>
  );
}
