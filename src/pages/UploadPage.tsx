import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, CircleCheck, CloudUpload, FileVideo, LoaderCircle } from 'lucide-react';
import type { ReadyUpload } from '../services/videoCatalog';

import { defaultUploadLimit, formatUploadLimit } from '../services/uploadLimits.mjs';

import { sendResumableVideo } from '../services/resumableUpload';

export function UploadPage({ onBack, onUploadComplete }: {
  onBack: () => void;
  onUploadComplete: (video: ReadyUpload) => void;
}) {
  const request = useRef<AbortController | null>(null);
  const [maxBytes, setMaxBytes] = useState(defaultUploadLimit);
  const [chunkBytes, setChunkBytes] = useState(1024 * 1024);
  const [percent, setPercent] = useState(0);
  const limit = formatUploadLimit(maxBytes);
  const [status, setStatus] = useState<'uploading' | 'processing' | ''>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/videos/upload-limits', { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((limits) => {
        if (controller.signal.aborted) return;
        if (Number.isSafeInteger(limits?.maxBytes) && limits.maxBytes > 0) setMaxBytes(limits.maxBytes);
        if (Number.isSafeInteger(limits?.chunkBytes) && limits.chunkBytes > 0) setChunkBytes(limits.chunkBytes);
      })
      .catch(() => {});
    return () => { controller.abort(); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!selectedFile) { setPreview(''); return; }
    const url = URL.createObjectURL(selectedFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const form = new FormData(event.currentTarget);
    const file = form.get('video');
    const title = String(form.get('title') || '').trim();
    if (!title || !(file instanceof File) || !file.size || !/\.mp4$/i.test(file.name) || file.size > maxBytes) {
      setError(`Enter a title and select an MP4 file up to ${limit}.`);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setError('');
    setPercent(0);
    setStatus('uploading');
    try {
      const statusUrl = await sendResumableVideo(file, {
        title,
        description: String(form.get('description') || '').trim(),
        category: String(form.get('category')),
        visibility: String(form.get('visibility')),
      }, chunkBytes, signal, setPercent);
      setStatus('processing');
      while (!signal.aborted) {
        const result = await fetch('/api' + statusUrl, { signal, cache: 'no-store' });
        if (!result.ok) throw new Error('Could not check video status.');
        const video = await result.json();
        if (video.status === 'failed') throw new Error('The video was received but could not be processed. Try an MP4 encoded as H.264, or check the video backend log.');
        if (video.status === 'ready' && video.playlistUrl) {
          onUploadComplete(video);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      request.current = null;
      if (!signal.aborted) setStatus('');
    }
  }

  return (
    <section className="workspace-page upload-page" aria-labelledby="upload-title">
      <button className="workspace-back" onClick={onBack}><ArrowLeft size={17} /> Creator Studio</button>
      <header className="workspace-heading">
        <p className="workspace-eyebrow">Creator workspace</p>
        <h1 id="upload-title">Upload a video</h1>
        <p>Add a video and its details. Free Me will prepare it for playback.</p>
      </header>
      <form onSubmit={upload} className="upload-workspace">
        <fieldset disabled={Boolean(status)} className="upload-fields">
          <section className="workspace-panel">
            <h2>Video file</h2>
            <p>Choose an MP4 from your device.</p>
            <label className="upload-picker">
              <input className="sr-only" name="video" type="file" accept="video/mp4,.mp4" required
                onChange={(event) => { setSelectedFile(event.target.files?.[0] ?? null); setError(''); }} />
              {selectedFile ? <FileVideo aria-hidden="true" size={32} /> : <CloudUpload aria-hidden="true" size={32} />}
              <strong>{selectedFile?.name || 'Select video'}</strong>
              <span>{selectedFile ? (selectedFile.size / 1024 / 1024).toFixed(1) + ' MiB · Click to replace' : `MP4 · Up to ${limit}`}</span>
            </label>
          </section>
          <section className="workspace-panel upload-details">
            <h2>Video details</h2>
            <label>Title <span aria-hidden="true">*</span><input name="title" placeholder="Give your video a clear title" maxLength={120} required /></label>
            <label>Description <span className="upload-optional">Optional</span><textarea name="description" placeholder="Tell viewers what the video is about" maxLength={1000} rows={4} /></label>
            <label>Visibility
              <select name="visibility"><option value="private">Private · only you</option><option value="public">Public · anyone</option></select>
            </label>
            <label>Category
              <select name="category">
                {['Kigali Life', 'Tech & Innovation', 'Wildlife & Safari', 'Music & Performance', 'Culinary & Coffee'].map((category) => <option key={category}>{category}</option>)}
              </select>
            </label>
          </section>
          {status && <p className="upload-status" role="status"><LoaderCircle size={18} className="animate-spin" />{status === 'uploading' ? `Uploading file… ${percent}%` : 'Preparing video for playback…'}</p>}
          {error && <p className="upload-error" role="alert">{error} {status !== 'processing' && 'Retry with the same file to resume any saved transfer.'}</p>}
          <button type="submit" className="workspace-primary"><CloudUpload size={19} /> Upload video</button>
        </fieldset>
        <aside className="workspace-panel upload-guide" aria-label="Upload guide">
          {preview && (
            <div className="upload-preview">
              <h2>Video preview</h2>
              <video src={preview} controls playsInline preload="metadata" aria-label="Selected video preview" />
            </div>
          )}
          <p className="workspace-eyebrow">Publishing</p>
          <h2>From file to playback</h2>
          <ol>
            <li><FileVideo size={18} /><div><strong>Choose your file</strong><p>Use an MP4 up to {limit}.</p></div></li>
            <li><LoaderCircle size={18} /><div><strong>Process the video</strong><p>The service prepares the full video for streaming. You can check processing later in Your videos.</p></div></li>
            <li><CircleCheck size={18} /><div><strong>Watch on Free Me</strong><p>When processing finishes, the video opens on its watch page.</p></div></li>
          </ol>

        </aside>
      </form>
    </section>
  );
}
