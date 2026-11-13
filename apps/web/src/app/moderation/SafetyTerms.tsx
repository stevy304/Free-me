'use client';

import { useCallback, useEffect, useState } from 'react';
import { inputClass } from '@/components/Dialog';
import { api } from '@/lib/client-api';

interface Overview {
  engine: 'none' | 'openai' | 'http'; unscannedReview: 'new' | 'all' | 'none';
  categories: Array<{ key: string; label: string; holdFrom: number; priority: number }>;
  builtIn: number;
  terms: Array<{ id: string; term: string; language: string; category: string; weight: number }>;
}
interface Tried { normalised: string; hold: boolean; category: string | null; reason: string | null; matches: Array<{ term: string; category: string }> }

const ENGINE = { none: 'Built-in text rules only (no machine looks at pictures)', openai: 'OpenAI moderation (pictures and text)', http: 'Outside scanner (SAFETY_SCAN_URL)' };

/**
 * The automatic check's word lists (API safety/rules.ts): the terms only people who speak a language know (slang,
 * coded words, local slurs), per language and category, and a field to try any wording against the check.
 */
export function SafetyTerms() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ term: '', language: 'rw', category: 'hate', weight: 1 });
  const [text, setText] = useState('');
  const [tried, setTried] = useState<Tried | null>(null);
  const load = useCallback(() => { api<Overview>('/moderation/safety').then(setData).catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    setError(null);
    try { await api('/moderation/safety/terms', { method: 'POST', body: form }); setForm({ ...form, term: '' }); load(); } catch (e) { setError((e as Error).message); }
  };
  const remove = async (id: string) => { await api(`/moderation/safety/terms/${id}`, { method: 'DELETE', body: {} }).catch(() => undefined); load(); };
  const tryIt = async () => { try { setTried(await api<Tried>('/moderation/safety/try', { method: 'POST', body: { text } })); } catch (e) { setError((e as Error).message); } };
  if (!data) return error ? <p role="alert" className="text-danger">{error}</p> : null;
  return (
    <section aria-labelledby="safety-heading" className="mt-10 border-t border-line pt-8">
      <h2 id="safety-heading" className="text-2xl font-bold">Automatic check</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Engine: <strong>{ENGINE[data.engine]}</strong>{data.engine === 'none' && data.unscannedReview !== 'none' ? ` · ${data.unscannedReview === 'all' ? 'every new video' : 'new Spaces’ first videos'} wait for a person here` : ''}.
        {' '}{data.builtIn} built-in terms; add what only speakers of a language know. Weight 1 is enough alone; under 1 counts only with another finding (for words that can be literal).
      </p>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void add(); }} className="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_1.4fr_1fr_auto] sm:items-end">
        <label className="text-sm font-medium">Word or phrase<input required minLength={2} maxLength={80} value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="text-sm font-medium">Language<input required value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="rw, fr, en, sw, any" className={`${inputClass} mt-1`} /></label>
        <label className="text-sm font-medium">Category<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={`${inputClass} mt-1`}>{data.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
        <label className="text-sm font-medium">Weight<select value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} className={`${inputClass} mt-1`}><option value={1}>1 · alone</option><option value={0.6}>0.6 · with another</option></select></label>
        <button className="h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand">Add</button>
      </form>
      {data.terms.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-2xl border border-line text-sm">
          {data.terms.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1 font-medium">{t.term}</span><span className="text-muted">{t.language}</span>
              <span className="text-muted">{data.categories.find((c) => c.key === t.category)?.label ?? t.category}</span><span className="tabular-nums text-muted">{t.weight}</span>
              <button type="button" onClick={() => void remove(t.id)} className="font-semibold text-danger">Remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <label className="text-sm font-medium" htmlFor="safety-try">Try wording</label>
        <div className="mt-1 flex gap-2"><input id="safety-try" value={text} onChange={(e) => setText(e.target.value)} className={inputClass} /><button type="button" onClick={() => void tryIt()} className="h-11 rounded-xl border border-line px-4 text-sm font-semibold">Check</button></div>
        {tried && <p role="status" className={`mt-2 text-sm ${tried.hold ? 'text-danger' : 'text-brand'}`}>{tried.hold ? tried.reason : 'Would pass.'}{tried.matches.length ? ` Matched: ${tried.matches.map((m) => m.term).join(', ')}.` : ''} <span className="text-muted">Read as: “{tried.normalised}”.</span></p>}
      </div>
    </section>
  );
}
