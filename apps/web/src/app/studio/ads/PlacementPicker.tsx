'use client';

import { useEffect, useState } from 'react';
import { inputClass } from '@/components/Pickers';
import { api } from '@/lib/client-api';

interface Placements {
  videos: Array<{ id: string; title: string; durationSeconds: number; channel: { name: string; handle: string } }>;
  channels: Array<{ id: string; name: string; handle: string }>;
}

export function PlacementPicker({ videos, channels, onVideo, onChannel }: {
  videos: string[];
  channels: string[];
  onVideo: (id: string) => void;
  onChannel: (handle: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Placements | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setResult(null); setError('');
    if (query.trim().length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      api<Placements>(`/ads/placements?q=${encodeURIComponent(query.trim())}`)
        .then((data) => { if (active) setResult(data); })
        .catch((e: Error) => { if (active) setError(e.message); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);
  return (
    <section className="space-y-3 rounded-2xl border border-line p-4 sm:col-span-2">
      <label className="block text-sm font-semibold">Find ad placements
        <input type="search" className={`${inputClass} mt-1`} value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} placeholder="Search video titles or channel names" />
      </label>
      <p className="text-sm text-muted">Search public content that can carry a mid-roll ad. Selected placements appear below.</p>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> :
        query.trim().length >= 2 && !result ? <p role="status" className="text-sm text-muted">Searching…</p> : null}
      {result && !result.videos.length && !result.channels.length && <p role="status" className="text-sm text-muted">No eligible placements found.</p>}
      {!!result?.videos.length && <div><h3 className="text-sm font-semibold">Videos</h3><ul className="mt-1 divide-y divide-line">
        {result.videos.map((video) => <li key={video.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>{video.title} <span className="text-muted">· @{video.channel.handle}</span></span>
          <button type="button" disabled={videos.includes(video.id)} onClick={() => onVideo(video.id)} className="shrink-0 rounded-lg bg-surface px-3 py-1 font-semibold disabled:opacity-60">{videos.includes(video.id) ? 'Added' : 'Add video'}</button>
        </li>)}
      </ul></div>}
      {!!result?.channels.length && <div><h3 className="text-sm font-semibold">Channels</h3><ul className="mt-1 divide-y divide-line">
        {result.channels.map((channel) => <li key={channel.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>{channel.name} <span className="text-muted">· @{channel.handle}</span></span>
          <button type="button" disabled={channels.includes(channel.handle)} onClick={() => onChannel(channel.handle)} className="shrink-0 rounded-lg bg-surface px-3 py-1 font-semibold disabled:opacity-60">{channels.includes(channel.handle) ? 'Added' : 'Add channel'}</button>
        </li>)}
      </ul></div>}
    </section>
  );
}
