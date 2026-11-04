import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Upload, X } from 'lucide-react';
import type { Video } from '../../types';

export function VideoUploadModal({ onClose, onUploadComplete }: {
  onClose: () => void;
  onUploadComplete: (video: Partial<Video>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    return () => request.current?.abort();
  }, []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const form = new FormData(event.currentTarget);
    const file = form.get('video');
    const title = String(form.get('title') || '').trim();
    if (!title || !(file instanceof File) || !file.size || !/\.mp4$/i.test(file.name) || file.size > 25 * 1024 * 1024) {
      setError('Enter a title and select an MP4 file up to 25 MiB.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setError('');
    setStatus('Uploading video…');
    try {
      const response = await fetch('/api/videos', { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: file, signal });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.error || 'The video service is unavailable. Start the local backend and try again.');
      }
      const { id, statusUrl } = await response.json();
      setStatus('Processing video…');
      const deadline = Date.now() + 125_000;
      while (Date.now() < deadline && !signal.aborted) {
        const result = await fetch('/api' + statusUrl, { signal, cache: 'no-store' });
        if (!result.ok) throw new Error('Could not check video status.');
        const video = await result.json();
        if (video.status === 'failed') throw new Error('FFmpeg could not process this file. Try another MP4.');
        if (video.status === 'ready' && video.playlistUrl) {
          onUploadComplete({
            id, title, description: String(form.get('description') || '').trim(),
            category: String(form.get('category')),
            videoUrl: '/api' + video.playlistUrl, thumbnailUrl: '',
          });
          onClose();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      if (!signal.aborted) throw new Error('The video is taking longer than expected to process.');
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      request.current = null;
      if (!signal.aborted) setStatus('');
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="upload-title" onCancel={onClose}
      className="fixed inset-0 m-auto w-[min(92vw,32rem)] max-h-[90dvh] overflow-auto rounded-2xl bg-white p-6 text-slate-900 shadow-xl backdrop:bg-black/60 dark:bg-slate-900 dark:text-white">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="upload-title" className="text-xl font-bold">Upload to Free Me</h2>
        <button type="button" aria-label="Close upload" onClick={onClose}><X /></button>
      </div>
      <form onSubmit={upload} className="grid gap-3">
        <fieldset disabled={Boolean(status)} className="grid gap-3">
          <label className="grid gap-1">MP4 video <input name="video" type="file" accept="video/mp4,.mp4" required /></label>
          <p className="text-xs opacity-70">Up to 25 MiB. The local prototype processes the first 60 seconds.</p>
          <label className="grid gap-1">Title <input className="rounded-md border p-2" name="title" maxLength={120} required /></label>
          <label className="grid gap-1">Description <textarea className="rounded-md border p-2" name="description" maxLength={1000} /></label>
          <label className="grid gap-1">Category
            <select className="rounded-md border p-2" name="category">
              {['Kigali Life', 'Tech & Innovation', 'Wildlife & Safari', 'Music & Performance', 'Culinary & Coffee'].map((category) => <option key={category}>{category}</option>)}
            </select>
          </label>
          <button type="submit" className="flex items-center justify-center gap-2 rounded-lg bg-teal-800 px-4 py-2 text-white"><Upload size={17} /> Upload video</button>
        </fieldset>
        {status && <p role="status">{status}</p>}
        {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      </form>
    </dialog>
  );
}
