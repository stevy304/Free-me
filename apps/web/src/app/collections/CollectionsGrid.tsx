'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { COLLECTION_TITLE_MAX } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { Dialog, buttonClass, inputClass } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import type { CollectionSummary } from '@/components/engagement/SaveDialog';
import { api } from '@/lib/client-api';

export const VISIBILITY_LABEL = { PUBLIC: 'Public', UNLISTED: 'Anyone with the link', PRIVATE: 'Only me' } as const;
export const VISIBILITY_ICON = { PUBLIC: Icon.Globe, UNLISTED: Icon.Link, PRIVATE: Icon.Lock } as const;

/** Cover of a collection: its newest video, with a stack edge and the number of videos. */
export function CollectionCover({ c }: { c: CollectionSummary }) {
  return (
    <div className="relative pt-2">
      <div className="absolute inset-x-3 top-0 h-3 rounded-t-xl bg-surface-hover" />
      <div className="relative aspect-video overflow-hidden rounded-xl bg-surface">
        {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-faint">{c.kind === 'SAVED' ? <Icon.Bookmark size={36} strokeWidth={1.3} /> : <Icon.Collections size={36} strokeWidth={1.3} />}</div>}
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-[12px] font-medium text-white"><Icon.Collections size={14} />{c.videoCount} {c.videoCount === 1 ? 'video' : 'videos'}</span>
      </div>
    </div>
  );
}

export function CollectionsGrid() {
  const [list, setList] = useState<CollectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'UNLISTED' | 'PUBLIC'>('PRIVATE');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<{ collections: CollectionSummary[] }>('/me/collections').then((r) => setList(r.collections)).catch((e) => setError((e as Error).message)); }, []);
  const create = async () => {
    setBusy(true); setError(null);
    try { const r = await api<{ collection: CollectionSummary }>('/me/collections', { body: { title, visibility } }); setList((l) => [...(l ?? []), r.collection]); setCreating(false); setTitle(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!list) return error ? <EmptyState icon={<Icon.Offline size={36} strokeWidth={1.4} />} title="Collections could not be loaded">{error}</EmptyState> : <div className="grid place-items-center py-20"><Icon.Spinner className="animate-spin text-muted" /></div>;
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] font-bold sm:text-[36px]">Collections</h1>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.soft}><Icon.Plus size={18} />New collection</button>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {list.map((c) => {
          const V = VISIBILITY_ICON[c.visibility];
          return (
            <Link key={c.id} href={`/collection/${c.kind === 'SAVED' ? 'saved' : c.id}`} className="group">
              <CollectionCover c={c} />
              <p className="mt-3 truncate text-[16px] font-semibold group-hover:underline">{c.title}</p>
              <p className="flex items-center gap-1.5 text-[13px] text-muted"><V size={14} />{VISIBILITY_LABEL[c.visibility]}</p>
            </Link>
          );
        })}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New collection"
        footer={<><button type="button" className={buttonClass.quiet} onClick={() => setCreating(false)}>Cancel</button><button type="button" className={buttonClass.primary} disabled={!title.trim() || busy} onClick={create}>{busy && <Icon.Spinner size={14} className="animate-spin" />}Create</button></>}>
        <div className="space-y-3">
          <label className="block text-[13px] font-medium">Name<input autoFocus value={title} maxLength={COLLECTION_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} /></label>
          <label className="block text-[13px] font-medium">Who can see it
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)} className={`${inputClass} mt-1`}>
              <option value="PRIVATE">Only me</option><option value="UNLISTED">Anyone with the link</option><option value="PUBLIC">Public</option>
            </select>
          </label>
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        </div>
      </Dialog>
    </div>
  );
}
