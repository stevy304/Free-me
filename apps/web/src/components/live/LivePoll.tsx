'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import * as Icon from '@/components/icons';
import { getSocket } from '@/lib/realtime';

export interface Poll { id: string; question: string; options: string[]; votes: number[]; total: number; open: boolean; startedAt: string }

const pct = (p: Poll, i: number) => (p.total ? Math.round((p.votes[i] / p.total) * 100) : 0);

/** Result bars: each answer with its share; the viewer's own choice and the leading answer stand out. */
function Results({ p, mine }: { p: Poll; mine: number | null }) {
  const lead = Math.max(...p.votes);
  return (
    <ul className="mt-3 space-y-2">
      {p.options.map((o, i) => (
        <li key={i} className={`relative overflow-hidden rounded-xl border px-3 py-2.5 text-[14px] ${mine === i ? 'border-brand' : 'border-line'}`}>
          <div className={`absolute inset-y-0 left-0 transition-[width] duration-500 ${p.votes[i] === lead && lead > 0 ? 'bg-brand/20' : 'bg-surface'}`} style={{ width: `${pct(p, i)}%` }} />
          <div className="relative flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">{o}{mine === i && <Icon.Check size={16} className="ml-1 inline text-brand" />}</span>
            <span className="tabular-nums text-muted">{pct(p, i)}%</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A viewer's poll card: tap an answer to vote (one vote per account); results show after voting and when it ends. */
export function PollCard({ streamId, poll, signedIn }: { streamId: string; poll: Poll; signedIn: boolean }) {
  const key = `fm:poll:${poll.id}`;
  const [mine, setMine] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { const v = localStorage.getItem(key); setMine(v === null ? null : Number(v)); } catch { /* blocked */ } }, [key]);

  const vote = async (option: number) => {
    setBusy(true); setError(null);
    try {
      const r = await (await getSocket()).emitWithAck('live:poll-vote', { streamId, pollId: poll.id, option }) as { ok: boolean; counted?: boolean; error?: string };
      if (!r.ok) { setError(r.error ?? 'Your vote did not go through.'); return; }
      // Already voted from another device: keep that choice unknown, show the results.
      const chosen = r.counted ? option : -1;
      setMine(chosen);
      try { localStorage.setItem(key, String(chosen)); } catch { /* blocked */ }
    } catch { setError('Your vote did not go through. Check your connection.'); } finally { setBusy(false); }
  };

  const voted = mine !== null;
  return (
    <section aria-labelledby={`poll-${poll.id}`} className="rounded-2xl border border-line bg-elevated p-4">
      <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">
        <Icon.Sort size={14} />{poll.open ? 'Live poll' : 'Poll ended'}<span className="ml-auto normal-case tracking-normal">{poll.total.toLocaleString()} {poll.total === 1 ? 'vote' : 'votes'}</span>
      </p>
      <h2 id={`poll-${poll.id}`} className="mt-1.5 font-display text-[17px] font-bold">{poll.question}</h2>
      {poll.open && !voted ? (
        signedIn ? (
          <div className="mt-3 grid gap-2">
            {poll.options.map((o, i) => (
              <button key={i} type="button" disabled={busy} onClick={() => void vote(i)} className="rounded-xl border border-line px-3 py-2.5 text-left text-[14px] font-semibold hover:border-brand hover:bg-brand-soft disabled:opacity-60">{o}</button>
            ))}
          </div>
        ) : <p className="mt-3 text-[14px] text-muted"><Link href="/login" className="font-semibold text-brand underline">Sign in</Link> to vote.</p>
      ) : <Results p={poll} mine={mine !== null && mine >= 0 ? mine : null} />}
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    </section>
  );
}

/** The host's poll controls while live: ask a question with 2 to 4 answers, watch the votes come in, end it. */
export function HostPoll({ streamId, live }: { streamId: string; live: boolean }) {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!live) return;
    let s: Awaited<ReturnType<typeof getSocket>> | null = null;
    const on = (d: { poll: Poll | null }) => setPoll(d.poll);
    void getSocket().then((sock) => { s = sock; sock.emit('join', `live:${streamId}`); sock.on('poll', on); });
    void fetch(`/api/live/${streamId}`).then((r) => r.json()).then((d) => setPoll(d.stream?.poll ?? null)).catch(() => undefined);
    return () => { s?.off('poll', on); };
  }, [streamId, live]);

  const send = async (event: string, body: object) => {
    setBusy(true); setError(null);
    try {
      const r = await (await getSocket()).emitWithAck(event, { streamId, ...body }) as { ok: boolean; poll?: Poll; error?: string };
      if (!r.ok) { setError(r.error ?? 'That did not work.'); return false; }
      if (r.poll) setPoll(r.poll);
      return true;
    } catch { setError('Check your connection and try again.'); return false; } finally { setBusy(false); }
  };
  const start = async () => {
    if (await send('live:poll-start', { question, options: options.map((o) => o.trim()).filter(Boolean) })) { setQuestion(''); setOptions(['', '']); }
  };

  const ready = question.trim().length > 0 && options.filter((o) => o.trim()).length >= 2;
  return (
    <div className="mt-4 rounded-2xl border border-line p-3">
      <p className="flex items-center gap-2 font-semibold"><Icon.Sort size={18} />Poll your viewers</p>
      {!live ? <p className="mt-1 text-[12px] text-muted">Available once you are live.</p> : (
        <>
          {poll && (
            <div className="mt-3 rounded-xl bg-surface p-3">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 font-semibold">{poll.question}</p>
                <span className="shrink-0 text-[12px] text-muted">{poll.total} {poll.total === 1 ? 'vote' : 'votes'}{poll.open ? '' : ' · ended'}</span>
              </div>
              <Results p={poll} mine={null} />
              {poll.open && <button type="button" disabled={busy} onClick={() => void send('live:poll-close', {})} className="mt-3 h-9 rounded-xl bg-elevated px-4 text-[13px] font-bold hover:bg-surface-hover disabled:opacity-50">End poll</button>}
            </div>
          )}
          <div className="mt-3 space-y-2">
            <input className="h-10 w-full rounded-xl border border-line bg-bg px-3 text-[14px] outline-none focus:border-brand" maxLength={120} placeholder={poll ? 'Ask another question' : 'Ask a question'} value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Poll question" />
            {options.map((o, i) => (
              <div key={i} className="flex gap-2">
                <input className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[14px] outline-none focus:border-brand" maxLength={60} placeholder={`Answer ${i + 1}`} value={o} aria-label={`Answer ${i + 1}`}
                  onChange={(e) => setOptions((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
                {options.length > 2 && <button type="button" onClick={() => setOptions((x) => x.filter((_, j) => j !== i))} aria-label={`Remove answer ${i + 1}`} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-surface"><Icon.Close size={16} /></button>}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              {options.length < 4 && <button type="button" onClick={() => setOptions((x) => [...x, ''])} className="h-9 rounded-xl px-3 text-[13px] font-semibold text-brand hover:bg-brand-soft">+ Add answer</button>}
              <button type="button" disabled={busy || !ready} onClick={() => void start()} className="ml-auto h-9 rounded-xl bg-brand px-4 text-[13px] font-bold text-on-brand disabled:opacity-50">{poll?.open ? 'Replace poll' : 'Start poll'}</button>
            </div>
          </div>
          {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
        </>
      )}
    </div>
  );
}
