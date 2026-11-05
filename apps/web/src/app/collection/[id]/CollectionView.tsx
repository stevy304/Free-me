'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import * as Icon from '@/components/icons';
import { Dialog, buttonClass, inputClass } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { useShell } from '@/components/shell/ShellContext';
import { VideoRow } from '@/components/video/VideoCard';
import { api } from '@/lib/client-api';
import { CollectionCover, VISIBILITY_ICON, VISIBILITY_LABEL } from '../../collections/CollectionsGrid';
import type { CollectionPage } from './page';

/** A collection: cover and details on the side, videos in order; owners can rename, share, remove and delete. */
export function CollectionView({ data }: { data: CollectionPage }) {
  const { locale } = useShell();
  const router = useRouter();
  const [c, setC] = useState(data.collection);
  const [videos, setVideos] = useState(data.videos);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [description, setDescription] = useState(c.description ?? '');
  const [visibility, setVisibility] = useState(c.visibility);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = c.kind === 'SAVED';
  const V = VISIBILITY_ICON[c.visibility];
  const key = saved ? 'saved' : c.id;

  const remove = async (id: string) => { try { await api(`/me/collections/${key}/videos/${id}`, { method: 'DELETE', body: {} }); setVideos((l) => l.filter((v) => v.id !== id)); } catch (e) { setError((e as Error).message); } };
  const save = async () => {
    try { const r = await api<{ collection: typeof c }>(`/me/collections/${c.id}`, { method: 'PATCH', body: { title, description, visibility } }); setC({ ...c, ...r.collection }); setEditing(false); } catch (e) { setError((e as Error).message); }
  };
  const del = async () => { if (!window.confirm(`Delete "${c.title}"? The videos themselves are not affected.`)) return; await api(`/me/collections/${c.id}`, { method: 'DELETE', body: {} }); router.push('/collections'); };
  const share = async () => { await navigator.clipboard.writeText(`${window.location.origin}/collection/${c.id}`).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
      <aside className="shrink-0 rounded-2xl bg-gradient-to-b from-brand-soft to-surface p-5 lg:sticky lg:top-20 lg:h-fit lg:w-[360px]">
        <CollectionCover c={{ ...c, videoCount: videos.length }} />
        <h1 className="mt-4 text-[26px] font-bold leading-8">{c.title}</h1>
        <p className="mt-1 text-[14px] font-medium">{data.owner.handle ? <Link href={`/@${data.owner.handle}`} className="hover:underline">{data.owner.name}</Link> : data.owner.name}</p>
        <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted"><V size={14} />{VISIBILITY_LABEL[c.visibility]} · {videos.length} {videos.length === 1 ? 'video' : 'videos'}</p>
        {c.description && <p className="mt-3 whitespace-pre-line text-[14px]">{c.description}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {videos[0] && <Link href={`/watch?v=${videos[0].id}`} className={buttonClass.primary}><Icon.Play size={16} />Play</Link>}
          {!saved && c.visibility !== 'PRIVATE' && <button type="button" onClick={share} className={buttonClass.soft}><Icon.Share size={18} />{copied ? 'Link copied' : 'Share'}</button>}
          {data.isOwner && !saved && <button type="button" onClick={() => setEditing(true)} className={buttonClass.soft}><Icon.Pencil size={18} />Edit</button>}
          {data.isOwner && !saved && <button type="button" onClick={del} aria-label="Delete collection" className={`${buttonClass.soft} px-2.5`}><Icon.Trash size={18} /></button>}
        </div>
        {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
      </aside>
      <div className="min-w-0 flex-1 space-y-3">
        {videos.length === 0
          ? <EmptyState icon={saved ? <Icon.Bookmark size={36} strokeWidth={1.4} /> : <Icon.Collections size={36} strokeWidth={1.4} />} title="No videos here yet">Use <strong>Save</strong> under any video to add it{saved ? '' : ' to this collection'}.</EmptyState>
          : videos.map((v, i) => (
            <div key={v.id} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-center text-[13px] text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1"><VideoRow v={v} locale={locale} actions={data.isOwner ? <button type="button" onClick={() => remove(v.id)} aria-label={`Remove ${v.title}`} className="grid h-10 w-10 place-items-center rounded-full hover:bg-surface"><Icon.Close size={20} /></button> : undefined} /></div>
            </div>
          ))}
      </div>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit collection"
        footer={<><button type="button" className={buttonClass.quiet} onClick={() => setEditing(false)}>Cancel</button><button type="button" className={buttonClass.primary} disabled={!title.trim()} onClick={save}>Save</button></>}>
        <div className="space-y-3">
          <label className="block text-[13px] font-medium">Name<input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} /></label>
          <label className="block text-[13px] font-medium">Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inputClass} mt-1`} /></label>
          <label className="block text-[13px] font-medium">Who can see it
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)} className={`${inputClass} mt-1`}>
              <option value="PRIVATE">Only me</option><option value="UNLISTED">Anyone with the link</option><option value="PUBLIC">Public</option>
            </select>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
