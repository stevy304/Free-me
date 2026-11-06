'use client';

import * as Icon from '@/components/icons';
import { useEffect, useRef, useState } from 'react';
import { LanguageSelect, inputClass } from '../Pickers';
import { languageName } from '@free-me/shared';
import { api } from '@/lib/client-api';
import type { Category } from '@/lib/types';
import type { HubVideo } from './types';

const VISIBILITY = [
  { v: 'PRIVATE', label: 'Private', help: 'Only you can watch it', Icon: Icon.Lock },
  { v: 'UNLISTED', label: 'Unlisted', help: 'Anyone with the link can watch it', Icon: Icon.Link },
  { v: 'PUBLIC', label: 'Public', help: 'Everyone can find and watch it', Icon: Icon.Globe },
] as const;

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Makes any picture the browser can open into an upload the server accepts: small JPEG, PNG and WebP files go
 * as they are; anything larger than 1280x720 or 2 MB, or in another format (HEIC, GIF, BMP...), is redrawn as a JPEG.
 */
export async function prepareThumbnail(f: File): Promise<Blob> {
  const fine = ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size <= MAX_BYTES;
  let img: ImageBitmap;
  try { img = await createImageBitmap(f); } catch {
    if (fine) return f;
    throw new Error('This picture could not be opened. Use a JPEG, PNG or WebP image.');
  }
  if (fine && img.width <= 1920 && img.height <= 1080) { img.close(); return f; }
  const scale = Math.min(1, 1280 / img.width, 720 / img.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); // transparent PNGs get a dark backdrop, not black-on-nothing
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height); img.close();
  for (const q of [0.9, 0.8, 0.7, 0.55]) {
    const b = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', q));
    if (b && b.size <= MAX_BYTES) return b;
  }
  throw new Error('The image is too large. Try a smaller picture.');
}

/** Title, description, thumbnail, audience, category, tags, language and visibility of one video. */
export function VideoDetailsForm({ video, onSaved, saveLabel = 'Save' }: { video: HubVideo; onSaved: (v: HubVideo) => void; saveLabel?: string }) {
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description ?? '');
  const [visibility, setVisibility] = useState(video.visibility);
  const [category, setCategory] = useState(video.category?.slug ?? '');
  const [tags, setTags] = useState(video.tags.join(', '));
  const [language, setLanguage] = useState<string | null>(video.language);
  const [kids, setKids] = useState<boolean | null>(video.publishedAt || video.madeForKids ? video.madeForKids : null);
  const [comments, setComments] = useState(video.commentsEnabled);
  const [thumb, setThumb] = useState<number | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { fetch('/api/categories').then((r) => r.json()).then((d) => setCategories(d.categories ?? [])).catch(() => undefined); }, []);

  const save = async () => {
    if (kids === null) { setMessage({ ok: false, text: 'Choose whether this video is made for kids.' }); return; }
    setBusy(true); setMessage(null);
    try {
      const r = await api<{ video: HubVideo }>(`/hub/videos/${video.id}`, { method: 'PATCH', body: {
        title, description, visibility, category: category || null, language, madeForKids: kids, commentsEnabled: comments,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean), ...(thumb !== null ? { thumbnail: thumb } : {}),
      } });
      setMessage({ ok: true, text: visibility === 'PRIVATE' ? 'Saved' : video.status === 'READY' ? 'Published' : 'Saved. It goes live when processing finishes.' });
      onSaved(r.video);
    } catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }); } finally { setBusy(false); }
  };
  const uploadThumb = async (f: File) => {
    setBusy(true); setMessage(null);
    try {
      const body = await prepareThumbnail(f);
      const res = await fetch(`/api/hub/videos/${video.id}/thumbnail`, { method: 'PUT', body, headers: { 'content-type': body.type || 'application/octet-stream' }, credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message ?? (res.status === 413 ? 'The image is too large.' : 'Could not upload the image. Check your connection and try again.'));
      setThumb(null); onSaved(d.video); setMessage({ ok: true, text: 'Thumbnail updated' });
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };

  const label = 'text-[14px] font-medium';
  const chosen = thumb ?? (video.customThumbnail ? -1 : video.thumbnailCandidates.findIndex((u) => video.thumbnailUrl && u.split('?')[0] === video.thumbnailUrl.split('?')[0]));
  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div>
        <label htmlFor="v-title" className={label}>Title (required)</label>
        <input id="v-title" required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-2`} />
        <p className="mt-1 text-right text-[12px] text-faint">{title.length}/100</p>
      </div>
      <div>
        <label htmlFor="v-desc" className={label}>Description</label>
        <textarea id="v-desc" rows={5} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Tell viewers about your video"
          className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-brand" />
      </div>
      <div>
        <p className={label}>Thumbnail</p>
        <p className="text-[13px] text-muted">Pick a frame or upload a picture. Any size works: big photos are resized to 1280×720 for you.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" disabled={!video.thumbnailCandidates.length || busy} onClick={() => file.current?.click()}
            className="flex aspect-video w-36 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-[12px] text-muted hover:bg-surface disabled:opacity-50">
            <Icon.ImageAdd size={20} />Upload thumbnail
          </button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadThumb(f); e.target.value = ''; }} />
          {video.customThumbnail && video.thumbnailUrl && (
            <span className={`relative aspect-video w-36 overflow-hidden rounded-lg ring-2 ${chosen === -1 ? 'ring-ink' : 'ring-transparent'}`}><img src={video.thumbnailUrl} alt="Custom thumbnail" className="h-full w-full object-cover" /></span>
          )}
          {video.thumbnailCandidates.length ? video.thumbnailCandidates.map((u, i) => (
            <button key={u} type="button" onClick={() => setThumb(i)} aria-pressed={chosen === i} className={`relative aspect-video w-36 overflow-hidden rounded-lg ring-2 ${chosen === i ? 'ring-ink' : 'ring-transparent hover:ring-line'}`}>
              <img src={u} alt={`Frame ${i + 1}`} className="h-full w-full object-cover" />{chosen === i && <Icon.Check size={18} className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white" />}
            </button>
          )) : <p className="flex items-center gap-2 text-[13px] text-muted"><Icon.Spinner size={14} className="animate-spin" />Frames, and your own picture, can be chosen once the first version is ready.</p>}
        </div>
      </div>
      <fieldset>
        <legend className={label}>Audience (required)</legend>
        <p className="text-[13px] text-muted">Videos made for kids get fewer personalised features to protect children&apos;s privacy.</p>
        <div className="mt-2 space-y-1.5 text-[14px]">
          <label className="flex items-center gap-3"><input type="radio" name="kids" checked={kids === true} onChange={() => setKids(true)} className="h-4 w-4 accent-[var(--brand)]" />Yes, it&apos;s made for kids</label>
          <label className="flex items-center gap-3"><input type="radio" name="kids" checked={kids === false} onChange={() => setKids(false)} className="h-4 w-4 accent-[var(--brand)]" />No, it&apos;s not made for kids</label>
        </div>
      </fieldset>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="v-cat" className={label}>Category</label>
          <select id="v-cat" value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} mt-2`}>
            <option value="">None</option>{categories.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </div>
        <div><label htmlFor="v-lang" className={label}>Video language</label><div className="mt-2"><LanguageSelect id="v-lang" allowEmpty value={language} onChange={setLanguage} /></div></div>
        <div className="sm:col-span-2"><Captions video={video} onSaved={onSaved} /></div>
        <div className="sm:col-span-2"><label htmlFor="v-tags" className={label}>Tags</label><input id="v-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Separate tags with commas" className={`${inputClass} mt-2`} /></div>
      </div>
      <label className={`flex items-start gap-3 rounded-xl border border-line p-3 ${kids ? 'opacity-60' : 'cursor-pointer hover:bg-surface'}`}>
        <input type="checkbox" checked={comments && !kids} disabled={!!kids} onChange={(e) => setComments(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--brand)]" />
        <span><span className="flex items-center gap-1.5 text-[14px] font-medium"><Icon.Comment size={15} />Allow comments</span><span className="text-[12px] text-muted">{kids ? 'Comments are always off on videos made for kids.' : 'Viewers can comment and reply. You can remove or pin comments.'}</span></span>
      </label>
      <fieldset>
        <legend className={label}>Visibility</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {VISIBILITY.map(({ v, label: l, help, Icon: VisIcon }) => (
            <label key={v} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${visibility === v ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface'}`}>
              <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1 h-4 w-4 accent-[var(--brand)]" />
              <span><span className="flex items-center gap-1.5 text-[14px] font-medium"><VisIcon size={15} />{l}</span><span className="text-[12px] text-muted">{help}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center justify-end gap-4">
        {message && <p role="status" className={`text-[14px] ${message.ok ? 'text-brand' : 'text-danger'}`}>{message.text}</p>}
        <button type="submit" disabled={busy || !title.trim()} className="flex h-10 items-center gap-2 rounded-xl bg-brand px-6 text-[14px] font-semibold text-on-brand hover:opacity-90 disabled:opacity-40">
          {busy && <Icon.Spinner size={16} className="animate-spin" />}{saveLabel}
        </button>
      </div>
    </form>
  );
}

/** Subtitles per language: upload a .vtt or .srt file; automatic ones (when the server makes them) are marked. */
function Captions({ video, onSaved }: { video: HubVideo; onSaved: (v: HubVideo) => void }) {
  const [lang, setLang] = useState<string | null>(video.language ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const caps = video.captions ?? [];
  const upload = async (f: File) => {
    if (!lang) { setMessage({ ok: false, text: 'Choose the language of the captions first.' }); return; }
    if (f.size > 1024 * 1024) { setMessage({ ok: false, text: 'A caption file must be 1 MB or smaller.' }); return; }
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/hub/videos/${video.id}/captions/${lang}`, { method: 'PUT', body: await f.text(), headers: { 'content-type': f.name.toLowerCase().endsWith('.srt') ? 'application/x-subrip' : 'text/vtt' }, credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message ?? 'Could not add the captions.');
      onSaved(d.video); setMessage({ ok: true, text: `${languageName(lang)} captions added` });
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const remove = async (language: string) => {
    setBusy(true); setMessage(null);
    try { const r = await api<{ video: HubVideo }>(`/hub/videos/${video.id}/captions/${language}`, { method: 'DELETE', body: {} }); onSaved(r.video); }
    catch (e) { setMessage({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="text-[14px] font-medium">Captions</p>
      <p className="text-[13px] text-muted">Captions can be generated after processing. Upload a WebVTT (.vtt) or SubRip (.srt) file if you want to provide your own.</p>
      {caps.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
          {caps.map((c) => (
            <li key={c.language} className="flex items-center gap-3 px-3 py-2.5 text-[14px]">
              <span className="grid h-7 min-w-9 place-items-center rounded-md bg-surface px-1.5 text-[11px] font-extrabold uppercase">{c.language}</span>
              <span className="min-w-0 flex-1"><span className="font-medium">{languageName(c.language)}</span>{c.source === 'AUTO' && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-on-accent-soft">Automatic</span>}<span className="block text-[12px] text-muted">{c.cues} lines</span></span>
              <a href={c.url} target="_blank" rel="noreferrer" className="rounded-lg px-2 py-1 text-[13px] font-semibold text-brand hover:bg-surface">View</a>
              <button type="button" disabled={busy} onClick={() => remove(c.language)} aria-label={`Remove ${languageName(c.language)} captions`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-danger"><Icon.Trash size={17} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1"><LanguageSelect id="v-cap-lang" allowEmpty value={lang} onChange={setLang} /></div>
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="flex h-10 items-center gap-2 rounded-xl border border-line px-4 text-[14px] font-semibold hover:bg-surface disabled:opacity-50">
          {busy ? <Icon.Spinner size={16} className="animate-spin" /> : <Icon.Upload size={18} />}Add captions
        </button>
        <input ref={file} type="file" accept=".vtt,.srt,text/vtt,application/x-subrip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      </div>
      {message && <p role={message.ok ? 'status' : 'alert'} className={`mt-2 text-[13px] ${message.ok ? 'text-brand' : 'text-danger'}`}>{message.text}</p>}
    </div>
  );
}

