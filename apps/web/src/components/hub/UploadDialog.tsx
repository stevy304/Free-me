'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { formatBytes, formatEta } from '@/lib/uploader';
import { useUploads } from './UploadsContext';
import { VideoDetailsForm } from './VideoDetailsForm';
import type { HubVideo } from './types';

const ACCEPT = '.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.flv,.mpeg,.mpg,.3gp,.ts,.mts,video/*';

/** "Upload videos": drop a file, it starts uploading at once; fill in the details while it uploads and processes. */
export function UploadDialog() {
  const { dialog, closeDialog, items, start, openDialog } = useUploads();
  const [drag, setDrag] = useState(false);
  const [video, setVideo] = useState<HubVideo | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const item = items.find((i) => i.id === dialog.uploadId) ?? null;
  const snap = item?.snap;

  // Follow the server-side state (processing progress, thumbnails) once the upload exists.
  // A different upload shows a fresh form; the same upload keeps what the creator typed while it uploaded.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    if (shownId.current !== (snap?.videoId ?? null)) { shownId.current = snap?.videoId ?? null; setVideo(null); }
    if (!snap?.videoId) return;
    let stop = false;
    const tick = async () => {
      const r = await api<{ video: HubVideo }>(`/hub/videos/${snap.videoId}`).catch(() => null);
      if (stop) return;
      if (r) setVideo((cur) => (cur && cur.status === r.video.status && cur.processingProgress === r.video.processingProgress && cur.thumbnailCandidates.length === r.video.thumbnailCandidates.length && cur.thumbnailUrl === r.video.thumbnailUrl && (cur.captions?.length ?? 0) === (r.video.captions?.length ?? 0) ? cur : r.video));
      if (!r || r.video.processingStage !== 'Ready' && r.video.status !== 'FAILED') setTimeout(tick, 2500);
    };
    void tick();
    return () => { stop = true; };
  }, [snap?.videoId, snap?.state === 'done']); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dialog.open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [dialog.open, closeDialog]);

  if (!dialog.open) return null;
  const pick = (files: FileList | null) => { const f = files?.[0]; if (f) openDialog(start(f)); };

  let status: React.ReactNode = null;
  if (snap) {
    const pct = snap.total ? Math.floor((snap.sent / snap.total) * 100) : 0;
    if (snap.state === 'error') status = <span className="flex items-center gap-2 text-danger"><Icon.Warning size={16} />{snap.error}</span>;
    else if (snap.state === 'cancelled') status = 'Upload cancelled';
    else if (snap.state !== 'done') status = <span className="tabular-nums">{snap.state === 'paused' ? 'Paused' : snap.state === 'finishing' ? 'Finishing upload…' : `Uploading ${pct}%`} · {formatBytes(snap.sent)} of {formatBytes(snap.total)}{snap.state === 'uploading' && snap.bytesPerSecond ? ` · ${formatBytes(snap.bytesPerSecond)}/s · ${formatEta(snap.secondsLeft)}` : ''}</span>;
    else if (video?.status === 'FAILED') status = <span className="flex items-center gap-2 text-danger"><Icon.Warning size={16} />{video.processingError}</span>;
    else if (video?.processingStage === 'Ready') status = <span className="flex items-center gap-2 text-brand"><Icon.CheckCircle size={16} />Processing complete · {video.renditions.at(-1)}</span>;
    else status = <span className="tabular-nums">Upload complete · {video?.processingStage ?? 'Processing'} {video ? `${video.processingProgress}%` : ''}</span>;
  }
  const bar = snap ? (snap.state === 'done' ? (video?.processingProgress ?? 0) : snap.total ? (snap.sent / snap.total) * 100 : 0) : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="Upload video">
      <div className="flex h-full w-full max-w-[960px] flex-col overflow-hidden bg-elevated sm:h-auto sm:max-h-[92dvh] sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="truncate text-[20px] font-semibold">{snap ? snap.title : 'Upload videos'}</h2>
          <button type="button" onClick={closeDialog} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={22} /></button>
        </header>

        {!item ? (
          <div className={`m-6 flex flex-1 flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center ${drag ? 'border-brand bg-brand-soft' : 'border-transparent'}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}>
            <div className="grid h-36 w-36 place-items-center rounded-full bg-surface text-muted"><Icon.Upload size={56} strokeWidth={1.4} /></div>
            <p className="mt-6 text-[15px]">Drag and drop a video file to upload</p>
            <p className="mt-1 text-[13px] text-muted">Your video stays private until you publish it.</p>
            <button type="button" onClick={() => input.current?.click()} className="mt-6 h-10 rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand hover:opacity-90">Select file</button>
            <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
            <p className="mt-8 max-w-md text-[12px] leading-5 text-faint">MP4, MOV, MKV, WebM, AVI and other common formats. Large files upload in parts and resume if your connection drops: choose the same file again to continue.</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col-reverse gap-6 overflow-y-auto px-6 py-6 lg:flex-row">
            <div className="min-w-0 flex-1">
              {video ? <VideoDetailsForm key={video.id} video={video} onSaved={setVideo} saveLabel="Save" /> : <div className="flex items-center gap-2 text-[14px] text-muted"><Icon.Spinner size={16} className="animate-spin" />Preparing your upload…</div>}
            </div>
            <aside className="lg:w-[320px] lg:shrink-0">
              <div className="overflow-hidden rounded-xl bg-surface">
                <div className="grid aspect-video place-items-center bg-black/80 text-[13px] text-white/80">
                  {video?.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : snap?.state === 'done' ? <span className="flex items-center gap-2"><Icon.Spinner size={16} className="animate-spin" />Processing…</span> : 'Uploading…'}
                </div>
                <div className="space-y-2 p-3 text-[13px]">
                  {video && <div><p className="text-muted">Video link</p>{video.status === 'READY' ? <Link href={`/watch?v=${video.id}`} target="_blank" className="flex items-center gap-1 break-all text-brand">/watch?v={video.id}<Icon.ExternalLink size={13} /></Link> : <p className="break-all text-faint">/watch?v={video.id}</p>}</div>}
                  <div><p className="text-muted">File</p><p className="break-all">{item.upload.file.name} · {formatBytes(item.upload.file.size)}</p></div>
                </div>
              </div>
            </aside>
          </div>
        )}

        {snap && (
          <footer className="border-t border-line px-6 py-3">
            <div className="h-1 overflow-hidden rounded-full bg-surface"><div className={`h-full transition-[width] duration-500 ${snap.state === 'error' ? 'bg-danger' : 'bg-brand'}`} style={{ width: `${Math.max(2, bar)}%` }} /></div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
              <span className="min-w-0">{status}</span>
              <span className="flex gap-2">
                {snap.state === 'uploading' && <button type="button" onClick={() => item!.upload.pause()} className="flex items-center gap-1 rounded-full px-3 py-1 hover:bg-surface"><Icon.Pause size={14} />Pause</button>}
                {(snap.state === 'paused' || snap.state === 'error') && <button type="button" onClick={() => item!.upload.resume()} className="flex items-center gap-1 rounded-full px-3 py-1 text-brand hover:bg-surface"><Icon.Play size={14} />Resume</button>}
                {snap.state !== 'done' && snap.state !== 'cancelled' && <button type="button" onClick={() => void item!.upload.cancel()} className="rounded-full px-3 py-1 hover:bg-surface">Cancel upload</button>}
              </span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
