'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { HubNotices } from './HubNotices';
import { HubStats } from './HubStats';
import { HubMoney } from './HubMoney';
import { useShell } from '@/components/shell/ShellContext';
import { useUploads } from '@/components/hub/UploadsContext';
import { VideoDetailsForm } from '@/components/hub/VideoDetailsForm';
import type { HubVideo } from '@/components/hub/types';
import { api } from '@/lib/client-api';
import { compactNumber, duration, fullDate } from '@/lib/format';

const VIS = { PUBLIC: ['Public', Icon.Globe], UNLISTED: ['Unlisted', Icon.Link], PRIVATE: ['Private', Icon.Lock] } as const;

/** Creator Hub: every video with its status, visibility, date, views and reactions; removals and notices in their own tab. */
export function HubContent({ handle }: { handle: string }) {
  const { locale } = useShell();
  const params = useSearchParams();
  const [tab, setTab] = useState<'videos' | 'stats' | 'money' | 'notices'>(((t) => (t === 'notices' || t === 'stats' || t === 'money' ? t : 'videos'))(params.get('tab')));
  // The Create button on phones opens the upload straight away.
  useEffect(() => { if (params.get('upload') === '1') openDialog(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { openDialog, items } = useUploads();
  const [videos, setVideos] = useState<HubVideo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<HubVideo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await api<{ videos: HubVideo[]; nextCursor: string | null }>('/hub/videos'); setVideos(r.videos); setCursor(r.nextCursor); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load, items.length]);
  // Refresh while something is uploading or processing.
  useEffect(() => {
    if (!videos?.some((v) => v.status === 'UPLOADING' || v.status === 'PROCESSING' || (v.status === 'READY' && v.processingStage !== 'Ready'))) return;
    const t = setTimeout(() => void load(), 3000);
    return () => clearTimeout(t);
  }, [videos, load]);

  const more = async () => { if (!cursor) return; const r = await api<{ videos: HubVideo[]; nextCursor: string | null }>(`/hub/videos?cursor=${cursor}`); setVideos((v) => [...(v ?? []), ...r.videos]); setCursor(r.nextCursor); };
  const remove = async (v: HubVideo) => {
    if (!window.confirm(`Delete "${v.title}" permanently? This cannot be undone.`)) return;
    try { await api(`/hub/videos/${v.id}`, { method: 'DELETE', body: {} }); setVideos((list) => list!.filter((x) => x.id !== v.id)); } catch (e) { setError((e as Error).message); }
  };

  const statusCell = (v: HubVideo) => {
    if (v.takenDownAt) return <button type="button" onClick={() => setTab('notices')} className="flex items-start gap-1.5 text-left text-danger hover:underline"><Icon.Warning size={15} className="mt-0.5 shrink-0" />Removed: {v.takedownReason === 'COPYRIGHT' ? 'copyright notice' : 'Community Guidelines'}</button>;
    if (v.status === 'FAILED') return <span className="flex items-start gap-1.5 text-danger"><Icon.Warning size={15} className="mt-0.5 shrink-0" />{v.processingError ?? 'Processing failed'}</span>;
    if (v.status === 'UPLOADING') return <span className="text-muted">Upload not finished</span>;
    if (v.status === 'FLAGGED') return <span className="flex items-start gap-1.5 text-accent" title="Our automatic check asked a moderator to look at this video before it goes live."><Icon.Clock size={15} className="mt-0.5 shrink-0" />Being reviewed before it goes live</span>;
    if (v.status === 'PROCESSING' || v.processingStage !== 'Ready') return <span className="flex items-center gap-1.5 text-muted"><Icon.Spinner size={14} className="animate-spin" />{v.processingStage} {v.processingProgress}%</span>;
    return <span className="text-muted">{[v.renditions.at(-1), v.isShort ? 'Moment' : null, v.isPodcast ? 'Podcast' : null].filter(Boolean).join(' · ')}</span>;
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="flex items-center gap-2 text-[28px] font-semibold tracking-tight"><Icon.Hub size={28} className="text-brand" />Creator Hub</h1><p className="text-[14px] text-muted">Channel <Link href={`/@${handle}`} className="text-brand">@{handle}</Link></p></div>
        <button type="button" onClick={() => openDialog()} className="flex h-10 items-center gap-2 rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand hover:bg-brand-strong"><Icon.Upload size={18} />Upload video</button>
      </div>
      <div role="tablist" className="mt-5 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        {([['videos', 'Videos', Icon.Videos], ['stats', 'Stats', Icon.Trail], ['money', 'Monetisation', Icon.Wallet], ['notices', 'Removals and notices', Icon.Shield]] as const).map(([k, l, I]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-[14px] font-medium ${tab === k ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`}><I size={18} filled={tab === k} />{l}</button>
        ))}
      </div>
      {tab === 'stats' ? <HubStats /> : tab === 'money' ? <HubMoney /> : tab === 'notices' ? <HubNotices /> : <>
      {error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-[14px] text-danger">{error}</p>}
      {!videos ? <Icon.Spinner className="mx-auto mt-16 animate-spin text-muted" /> : !videos.length ? (
        <div className="mx-auto mt-16 max-w-sm text-center">
          <div className="mx-auto grid h-24 w-24 place-items-center rounded-full bg-surface text-muted"><Icon.Videos size={40} strokeWidth={1.4} /></div>
          <h2 className="mt-5 text-[18px] font-semibold">No videos yet</h2>
          <p className="mt-1 text-[14px] text-muted">Upload your first video. It stays private until you publish it.</p>
          <button type="button" onClick={() => openDialog()} className="mt-5 h-10 rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand">Upload video</button>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[1080px] text-left text-[14px]">
            <thead className="border-b border-line text-[12px] uppercase tracking-wide text-muted"><tr><th className="px-4 py-3 font-medium">Video</th><th className="px-4 py-3 font-medium">Visibility</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 text-right font-medium">Views</th><th className="px-4 py-3 text-right font-medium">Reactions</th><th className="w-28 px-4 py-3" /></tr></thead>
            <tbody className="divide-y divide-line">
              {videos.map((v) => {
                const [visLabel, VisIcon] = VIS[v.visibility];
                return (
                  <tr key={v.id} className="group hover:bg-surface/50">
                    <td className="px-4 py-3">
                      <div className="flex gap-3">
                        <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-surface">
                          {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-faint"><Icon.Videos size={22} /></div>}
                          {v.durationSeconds > 0 && <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[11px] text-white">{duration(v.durationSeconds)}</span>}
                        </div>
                        <div className="min-w-0"><p className="line-clamp-2 font-medium">{v.title}</p><p className="line-clamp-1 text-[12px] text-muted">{v.description || 'Add description'}</p></div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><span className="flex items-center gap-1.5"><VisIcon size={15} />{visLabel}</span></td>
                    <td className="max-w-[220px] px-4 py-3 text-[13px]">{statusCell(v)}</td>
                    <td className="px-4 py-3 text-[13px] text-muted">{fullDate(v.publishedAt ?? v.createdAt, locale)}<br />{v.publishedAt ? 'Published' : 'Uploaded'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{compactNumber(v.viewCount, locale)}</td>
                    <td className="px-4 py-3 text-right text-[13px] tabular-nums text-muted">
                      <span className="inline-flex items-center gap-1" title="Likes"><Icon.ThumbUp size={14} />{compactNumber(v.likeCount, locale)}</span>
                      <span className="ml-3 inline-flex items-center gap-1" title="Dislikes (only you see these)"><Icon.ThumbDown size={14} />{compactNumber(v.dislikeCount, locale)}</span>
                      <span className="ml-3 inline-flex items-center gap-1" title="Comments"><Icon.Comment size={14} />{compactNumber(v.commentCount, locale)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1 opacity-70 group-hover:opacity-100">
                        <button type="button" onClick={() => setEditing(v)} aria-label={`Edit ${v.title}`} className="rounded-full p-2 hover:bg-surface"><Icon.Pencil size={17} /></button>
                        {v.playbackUrl && <Link href={`/watch?v=${v.id}`} aria-label={`Watch ${v.title}`} className="rounded-full p-2 hover:bg-surface"><Icon.Play size={17} /></Link>}
                        <button type="button" onClick={() => void remove(v)} aria-label={`Delete ${v.title}`} className="rounded-full p-2 hover:bg-surface"><Icon.Trash size={17} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {cursor && <div className="border-t border-line p-3 text-center"><button type="button" onClick={() => void more()} className="rounded-full px-4 py-2 text-[14px] font-medium text-brand hover:bg-brand-soft">Show more</button></div>}
        </div>
      )}
      </>}
      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="Video details">
          <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden bg-elevated sm:h-auto sm:max-h-[92dvh] sm:rounded-2xl">
            <header className="flex items-center justify-between border-b border-line px-6 py-4"><h2 className="text-[20px] font-semibold">Video details</h2><button type="button" onClick={() => setEditing(null)} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={22} /></button></header>
            <div className="overflow-y-auto px-6 py-6"><VideoDetailsForm video={editing} onSaved={(v) => { setEditing(v); setVideos((list) => list!.map((x) => (x.id === v.id ? v : x))); }} /></div>
          </div>
        </div>
      )}
    </div>
  );
}
