'use client';

import { useEffect, useState } from 'react';
import { COLLECTION_TITLE_MAX } from '@free-me/shared';
import * as Icon from '@/components/icons';
import { Dialog, buttonClass, inputClass } from '@/components/Dialog';
import { api } from '@/lib/client-api';

export interface CollectionSummary { id: string; kind: 'SAVED' | 'CUSTOM'; title: string; visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE'; videoCount: number; thumbnailUrl: string | null; updatedAt: string }

const VIS_ICON = { PUBLIC: Icon.Globe, UNLISTED: Icon.Link, PRIVATE: Icon.Lock } as const;

/** Pick the collections a video belongs to; each tick saves at once. A new collection can be made here. */
export function SaveDialog({ videoId, open, onClose, onSavedChange }: { videoId: string; open: boolean; onClose: () => void; onSavedChange: (saved: boolean) => void }) {
  const [list, setList] = useState<CollectionSummary[] | null>(null);
  const [inside, setInside] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'UNLISTED' | 'PUBLIC'>('PRIVATE');

  useEffect(() => {
    if (!open) return;
    setError(null); setCreating(false); setTitle('');
    Promise.all([api<{ collections: CollectionSummary[] }>('/me/collections'), api<{ collectionIds: string[] }>(`/me/collections/containing/${videoId}`)])
      .then(([a, b]) => { setList(a.collections); setInside(new Set(b.collectionIds)); })
      .catch((e) => setError((e as Error).message));
  }, [open, videoId]);

  const toggle = async (c: CollectionSummary) => {
    const has = inside.has(c.id);
    setBusy(c.id); setError(null);
    try {
      await api(`/me/collections/${c.id}/videos/${videoId}`, { method: has ? 'DELETE' : 'PUT', body: {} });
      const next = new Set(inside); if (has) next.delete(c.id); else next.add(c.id);
      setInside(next); onSavedChange(next.size > 0);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const create = async () => {
    setBusy('new'); setError(null);
    try {
      const r = await api<{ collection: CollectionSummary }>('/me/collections', { body: { title, visibility } });
      await api(`/me/collections/${r.collection.id}/videos/${videoId}`, { method: 'PUT', body: {} });
      setList((l) => [...(l ?? []), { ...r.collection, videoCount: 1 }]);
      setInside((s) => new Set(s).add(r.collection.id)); onSavedChange(true);
      setCreating(false); setTitle('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Save to…"
      footer={creating
        ? <><button type="button" className={buttonClass.quiet} onClick={() => setCreating(false)}>Cancel</button><button type="button" className={buttonClass.primary} disabled={!title.trim() || busy === 'new'} onClick={create}>{busy === 'new' && <Icon.Spinner size={16} className="animate-spin" />}Create</button></>
        : <button type="button" className={`${buttonClass.soft} w-full`} onClick={() => setCreating(true)}><Icon.Plus size={18} />New collection</button>}>
      {!list && !error && <div className="grid place-items-center py-8"><Icon.Spinner className="animate-spin text-muted" /></div>}
      {list && (
        <ul className="-mx-2">
          {list.map((c) => {
            const V = VIS_ICON[c.visibility];
            const on = inside.has(c.id);
            return (
              <li key={c.id}>
                <button type="button" role="checkbox" aria-checked={on} disabled={busy === c.id} onClick={() => toggle(c)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-surface disabled:opacity-60">
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${on ? 'border-brand bg-brand text-on-brand' : 'border-faint'}`}>{on && <Icon.Check size={14} strokeWidth={3} />}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px]">{c.title}</span>
                  {busy === c.id ? <Icon.Spinner size={16} className="animate-spin text-muted" /> : <V size={16} className="text-muted" aria-label={c.visibility.toLowerCase()} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <div className="mt-3 space-y-3 border-t border-line pt-4">
          <label className="block text-[13px] font-medium">Name<input autoFocus value={title} maxLength={COLLECTION_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) void create(); }} placeholder="e.g. Cooking ideas" className={`${inputClass} mt-1`} /></label>
          <label className="block text-[13px] font-medium">Who can see it
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)} className={`${inputClass} mt-1`}>
              <option value="PRIVATE">Only me</option>
              <option value="UNLISTED">Anyone with the link</option>
              <option value="PUBLIC">Public</option>
            </select>
          </label>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}
