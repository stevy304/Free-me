import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, CircleCheck, CloudUpload, FileVideo, LoaderCircle } from 'lucide-react';
import type { ReadyUpload } from '../services/videoCatalog';

export function UploadPage({ onBack, onUploadComplete }: {
  onBack: () => void;
  onUploadComplete: (video: ReadyUpload) => void;
}) {
  const request = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<'uploading' | 'processing' | ''>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);

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
    if (!title || !(file instanceof File) || !file.size || !/\.mp4$/i.test(file.name) || file.size > 25 * 1024 * 1024) {
      setError('Enter a title and select an MP4 file up to 25 MiB.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setError('');
    setStatus('uploading');
    try {
      const response = await fetch('/api/videos', { method: 'POST', headers: {
        'Content-Type': 'video/mp4',
        'X-Video-Visibility': String(form.get('visibility')),
        'X-Video-Title': encodeURIComponent(title),
        'X-Video-Description': encodeURIComponent(String(form.get('description') || '').trim()),
        'X-Video-Category': encodeURIComponent(String(form.get('category'))),
      }, body: file, signal });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.error || 'The video service is unavailable. Restart Free Me with npm run dev, then try again.');
      }
      const { statusUrl } = await response.json();
      setStatus('processing');
      const deadline = Date.now() + 420_000;
      while (Date.now() < deadline && !signal.aborted) {
        const result = await fetch('/api' + statusUrl, { signal, cache: 'no-store' });
        if (!result.ok) throw new Error('Could not check video status.');
        const video = await result.json();
        if (video.status === 'failed') throw new Error('FFmpeg could not process this file. Try another MP4.');
        if (video.status === 'ready' && video.playlistUrl) {
          onUploadComplete(video);
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
              <span>{selectedFile ? (selectedFile.size / 1024 / 1024).toFixed(1) + ' MiB · Click to replace' : 'MP4 · Up to 25 MiB'}</span>
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
          {status && <p className="upload-status" role="status"><LoaderCircle size={18} className="animate-spin" />{status === 'uploading' ? 'Uploading file…' : 'Preparing video for playback…'}</p>}
          {error && <p className="upload-error" role="alert">{error}</p>}
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
            <li><FileVideo size={18} /><div><strong>Choose your file</strong><p>Use an MP4 up to 25 MiB.</p></div></li>
            <li><LoaderCircle size={18} /><div><strong>Process the video</strong><p>The local service prepares the first 60 seconds for streaming.</p></div></li>
            <li><CircleCheck size={18} /><div><strong>Watch on Free Me</strong><p>When processing finishes, the video opens on its watch page.</p></div></li>
          </ol>

        </aside>
      </form>
    </section>
  );
}
