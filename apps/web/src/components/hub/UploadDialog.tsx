'use client';

import * as Icon from '@/components/icons';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { formatBytes, formatEta } from '@/lib/uploader';
import { useUploads } from './UploadsContext';
import { VideoDetailsForm, prepareThumbnail } from './VideoDetailsForm';
import type { UploadKind } from './UploadsContext';
import type { HubVideo } from './types';
import { useRealtime } from '@/lib/realtime';

const STEPS = ['Uploading', 'Processing', 'Ready to watch'];

const ACCEPT = '.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.flv,.mpeg,.mpg,.3gp,.ts,.mts,video/*';
const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,audio/*';
const KINDS: Array<{ k: UploadKind; label: string; hint: string; icon: typeof Icon.Upload }> = [
  { k: 'video', label: 'Video', hint: 'Any length, landscape or portrait', icon: Icon.Videos },
  { k: 'moment', label: 'Moment', hint: 'Vertical, up to 3 minutes', icon: Icon.Moments },
  { k: 'podcast', label: 'Podcast', hint: 'A sound file and a cover picture', icon: Icon.Mic },
];

/** "Upload videos": drop a file, it starts uploading at once; fill in the details while it uploads and processes. */
export function UploadDialog() {
  const { dialog, closeDialog, items, start, openDialog } = useUploads();
  const [drag, setDrag] = useState(false);
  const [kind, setKind] = useState<UploadKind>(dialog.kind);
  useEffect(() => { if (dialog.open) setKind(dialog.kind); }, [dialog.open, dialog.kind]);
  // Podcasts: the cover picture, sent as soon as the upload exists (the podcast video is made from it).
  const [cover, setCover] = useState<{ file: File; url: string } | null>(null);
  const [coverFor, setCoverFor] = useState<number | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [video, setVideo] = useState<HubVideo | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const item = items.find((i) => i.id === dialog.uploadId) ?? null;
  const snap = item?.snap;

  // Follow the server-side state (processing progress, thumbnails) once the upload exists.
  // A different upload shows a fresh form; the same upload keeps what the creator typed while it uploaded.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    if (shownId.current !== (snap?.videoId ?? null)) { shownId.current = snap?.videoId ?? null; setVideo(null); }
    if (!dialog.open || !snap?.videoId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const r = await api<{ video: HubVideo }>(`/hub/videos/${snap.videoId}`).catch(() => null);
      if (stop) return;
      if (r) setVideo((cur) => (cur && cur.status === r.video.status && cur.processingStage === r.video.processingStage && cur.processingError === r.video.processingError && cur.renditions.join() === r.video.renditions.join() && cur.processingProgress === r.video.processingProgress && cur.thumbnailCandidates.length === r.video.thumbnailCandidates.length && cur.thumbnailUrl === r.video.thumbnailUrl && (cur.captions?.length ?? 0) === (r.video.captions?.length ?? 0) ? cur : r.video));
      if (!r || !['FAILED', 'SUSPENDED'].includes(r.video.status) && r.video.processingStage !== 'Ready') timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [dialog.open, snap?.videoId, snap?.state === 'done']); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cover || coverFor === null || !snap?.videoId || item?.id !== coverFor) return;
    const c = cover; setCoverFor(null);
    (async () => {
      try {
        const body = await prepareThumbnail(c.file);
        const res = await fetch(`/api/hub/videos/${snap.videoId}/thumbnail`, { method: 'PUT', body, headers: { 'content-type': body.type || 'application/octet-stream' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'The cover could not be uploaded.');
      } catch (e) { setCoverError((e as Error).message); }
    })();
  }, [snap?.videoId, coverFor, cover, item?.id]);

  // Processing progress arrives as it happens; the page asks for the full state then.
  const [bump, setBump] = useState(0);
  useRealtime('captions', () => setBump((b) => b + 1), snap?.videoId ? `video:${snap.videoId}` : null, !!snap?.videoId);
  useRealtime('processing', () => setBump((b) => b + 1), snap?.videoId ? `video:${snap.videoId}` : null, !!snap?.videoId);
  useEffect(() => {
    if (!bump || !snap?.videoId) return;
    let stale = false;
    api<{ video: HubVideo }>(`/hub/videos/${snap.videoId}`).then((r) => {
      if (!stale) setVideo(r.video);
    }).catch(() => undefined);
    return () => { stale = true; };
  }, [bump, snap?.videoId]);

  useEffect(() => {
    if (!dialog.open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [dialog.open, closeDialog]);

  if (!dialog.open) return null;
  const pick = (files: FileList | null) => {
    const f = files?.[0]; if (!f) return;
    const id = start(f);
    if (kind === 'podcast' && cover) setCoverFor(id);
    openDialog(id, kind);
  };

  const playable = video?.status === 'READY' && !!video.playbackUrl;
  const phase = snap?.state === 'done' ? (playable ? 2 : 1) : 0;
  let status: React.ReactNode = null;
  if (snap) {
    const pct = snap.total ? Math.floor((snap.sent / snap.total) * 100) : 0;
    if (snap.state === 'error') status = <span className="flex items-center gap-2 text-danger"><Icon.Warning size={16} />{snap.error}</span>;
    else if (snap.reconnecting) status = <span role="status">Reconnecting… Upload resumes when you’re back online.</span>;
    else if (snap.state === 'cancelled') status = 'Upload cancelled';
    else if (snap.state === 'compressing') status = <span className="tabular-nums">Making it smaller to save data · {Math.floor((snap.compress?.progress ?? 0) * 100)}% of {formatBytes(snap.compress?.originalBytes ?? snap.total)}</span>;
    else if (snap.state !== 'done') status = <span className="tabular-nums">{snap.state === 'paused' ? 'Paused' : snap.state === 'finishing' ? 'Finishing upload…' : snap.state === 'starting' ? 'Starting…' : `Uploading ${pct}%`} · {formatBytes(snap.sent)} of {formatBytes(snap.total)}{snap.compress?.savedBytes ? ` (was ${formatBytes(snap.compress.originalBytes)})` : ''}{snap.state === 'uploading' && snap.bytesPerSecond ? ` · ${formatBytes(snap.bytesPerSecond)}/s · ${formatEta(snap.secondsLeft)}` : ''}</span>;
    else if (video?.status === 'FAILED') status = <span className="flex items-center gap-2 text-danger"><Icon.Warning size={16} />{video.processingError ?? 'Processing failed.'}</span>;
    else if (video?.status === 'FLAGGED') status = 'Held for review';
    else if (video?.status === 'SUSPENDED') status = 'Video unavailable';
    else if (playable && video.processingError) status = <span className="flex items-center gap-2 text-muted"><Icon.Warning size={16} />Ready to watch · {video.processingError}</span>;
    else if (playable && video.processingStage === 'Ready') status = video.processingError ?? `Processing complete${video.renditions.length ? ` · ${video.renditions.at(-1)}` : ''}`;
    else if (playable) status = video.processingStage === 'Playable · adding qualities' ? 'Ready to watch · Higher qualities are processing' : 'Ready to watch · Finishing processing';
    else status = <span className="tabular-nums">{video?.status === 'PROCESSING' ? `${video.processingStage ?? 'Processing'} · ${video.processingProgress}%` : 'Waiting to process…'}</span>;
  }
  const bar = snap ? (snap.state === 'done' ? (video?.processingProgress ?? 0) : snap.state === 'compressing' ? (snap.compress?.progress ?? 0) * 100 : snap.total ? (snap.sent / snap.total) * 100 : 0) : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-0 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="launchpad-title">
      <div className="flex h-full w-full max-w-[960px] flex-col overflow-hidden bg-elevated sm:h-auto sm:max-h-[92dvh] sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 id="launchpad-title" className="text-[20px] font-semibold">Launchpad</h2>
            <p className="truncate text-[13px] text-muted">{snap?.title ?? 'Upload a video, Moment, or podcast'}</p>
          </div>
          <button type="button" onClick={closeDialog} aria-label="Close" className="rounded-full p-2 hover:bg-surface"><Icon.Close size={22} /></button>
        </header>

        {!item ? (
          <div className={`m-6 flex flex-1 flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center ${drag ? 'border-brand bg-brand-soft' : 'border-transparent'}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}>
            <div role="radiogroup" aria-label="What are you posting?" className="mb-8 grid w-full max-w-xl grid-cols-3 gap-2">
              {KINDS.map((x) => (
                <button key={x.k} type="button" role="radio" aria-checked={kind === x.k} onClick={() => setKind(x.k)}
                  className={`rounded-2xl border-2 px-3 py-3 text-center ${kind === x.k ? 'border-brand bg-brand-soft' : 'border-line hover:border-faint'}`}>
                  <x.icon size={24} className="mx-auto" filled={kind === x.k} /><span className="mt-1 block text-[14px] font-bold">{x.label}</span><span className="block text-[11px] leading-4 text-muted">{x.hint}</span>
                </button>
              ))}
            </div>
            {kind === 'podcast' ? (
              <>
                <button type="button" onClick={() => coverInput.current?.click()} className="relative grid h-40 w-40 place-items-center overflow-hidden rounded-3xl bg-surface text-muted hover:bg-surface-hover" aria-label="Choose a cover picture">
                  {cover ? <img src={cover.url} alt="Cover" className="h-full w-full object-cover" /> : <span className="flex flex-col items-center gap-1 text-[13px]"><Icon.ImageAdd size={36} strokeWidth={1.4} />Cover picture</span>}
                </button>
                <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setCover({ file: f, url: URL.createObjectURL(f) }); e.target.value = ''; }} />
                <p className="mt-4 text-[15px]">Choose a cover, then your sound file (MP3, M4A, WAV, OGG, FLAC)</p>
                <p className="mt-1 text-[13px] text-muted">We make a video of your cover with a moving waveform. Square or 16:9 pictures work best.</p>
                <button type="button" disabled={!cover} onClick={() => input.current?.click()} className="mt-6 h-10 rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand hover:opacity-90 disabled:opacity-50">Select sound file</button>
                <input ref={input} type="file" accept={AUDIO_ACCEPT} hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
              </>
            ) : (
              <>
                <div className="grid h-32 w-32 place-items-center rounded-full bg-surface text-muted">{kind === 'moment' ? <Icon.Moments size={52} strokeWidth={1.4} /> : <Icon.Upload size={52} strokeWidth={1.4} />}</div>
                <p className="mt-6 text-[15px]">{kind === 'moment' ? 'Drag and drop a vertical video, up to 3 minutes' : 'Drag and drop a video file to upload'}</p>
                <p className="mt-1 text-[13px] text-muted">{kind === 'moment' ? 'Vertical videos of 3 minutes or less appear in Moments.' : 'Your video stays private until you publish it.'}</p>
                <button type="button" onClick={() => input.current?.click()} className="mt-6 h-10 rounded-xl bg-brand px-5 text-[14px] font-semibold text-on-brand hover:opacity-90">Select file</button>
                <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
              </>
            )}
            <p className="mt-8 max-w-md text-[12px] leading-5 text-faint">{kind === 'podcast' ? 'Long recordings are fine: large files upload in parts and resume if your connection drops.' : <>MP4, MOV, MKV, WebM, AVI and other common formats. Large files upload in parts and resume if your connection drops: choose the same file again to continue.</>}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col-reverse gap-6 overflow-y-auto px-6 py-6 lg:flex-row">
            <div className="min-w-0 flex-1">
              {coverError && <p role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-[14px] text-danger">{coverError}</p>}
              {video ? <VideoDetailsForm key={video.id} video={video} onSaved={setVideo} saveLabel="Save" /> : <div className="flex items-center gap-2 text-[14px] text-muted"><Icon.Spinner size={16} className="animate-spin" />Preparing your upload…</div>}
            </div>
            <aside className="lg:w-[320px] lg:shrink-0">
              <div className="overflow-hidden rounded-xl bg-surface">
                <div className="grid aspect-video place-items-center bg-black/80 text-[13px] text-white/80">
                  {video?.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : snap?.state === 'done' ? <span className="flex items-center gap-2"><Icon.Spinner size={16} className="animate-spin" />Processing…</span> : 'Uploading…'}
                </div>
                <div className="space-y-2 p-3 text-[13px]">
                  {video && <div><p className="text-muted">Video link</p>{playable ? <Link href={`/watch?v=${video.id}`} target="_blank" className="flex items-center gap-1 break-all text-brand">Open video<Icon.ExternalLink size={13} /></Link> : <p className="break-all text-faint">/watch?v={video.id}</p>}</div>}
                  <div><p className="text-muted">File</p><p className="break-all">{item.upload.original.name} · {formatBytes(item.upload.original.size)}{item.upload.file !== item.upload.original ? ` · sending a ${formatBytes(item.upload.file.size)} copy` : ''}</p></div>
                </div>
              </div>
            </aside>
          </div>
        )}

        {snap && (
          <footer className="border-t border-line px-6 py-3">
            <ol aria-label="Upload steps" className="mb-3 grid grid-cols-3 gap-2 text-[12px] font-semibold sm:text-[13px]">
              {STEPS.map((step, index) => (
                <li key={step} aria-current={index === phase ? 'step' : undefined}
                  className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 ${index <= phase ? 'bg-brand-soft text-brand' : 'bg-surface text-muted'}`}>
                  {index < phase && <Icon.CheckCircle size={14} className="shrink-0" />}{step}
                </li>
              ))}
            </ol>
            <div className="h-1 overflow-hidden rounded-full bg-surface"><div className={`h-full transition-[width] duration-500 ${snap.state === 'error' ? 'bg-danger' : 'bg-brand'}`} style={{ width: `${Math.max(2, bar)}%` }} /></div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
              <span className="min-w-0">{status}</span>
              <span className="flex gap-2">
                {snap.state === 'compressing' && <button type="button" onClick={() => item!.upload.skipCompression()} className="flex items-center gap-1 rounded-full px-3 py-1 hover:bg-surface">Upload the original instead</button>}
                {snap.state === 'uploading' && <button type="button" onClick={() => item!.upload.pause()} className="flex items-center gap-1 rounded-full px-3 py-1 hover:bg-surface"><Icon.Pause size={14} />Pause</button>}
                {(snap.state === 'paused' || snap.state === 'error') && <button type="button" onClick={() => item!.upload.resume()} className="flex items-center gap-1 rounded-full px-3 py-1 text-brand hover:bg-surface"><Icon.Play size={14} />Resume</button>}
                {snap.state !== 'done' && snap.state !== 'cancelled' && snap.state !== 'finishing' && <button type="button" onClick={() => void item!.upload.cancel()} className="rounded-full px-3 py-1 hover:bg-surface">Cancel upload</button>}
              </span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
