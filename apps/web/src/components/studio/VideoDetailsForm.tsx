'use client';

import { Check, ImagePlus, Loader2, Lock, Link2, Globe2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LanguageSelect, inputClass } from '../Pickers';
import { api } from '@/lib/client-api';
import type { Category } from '@/lib/types';
import type { StudioVideo } from './types';

const VISIBILITY = [
  { v: 'PRIVATE', label: 'Private', help: 'Only you can watch it', Icon: Lock },
  { v: 'UNLISTED', label: 'Unlisted', help: 'Anyone with the link can watch it', Icon: Link2 },
  { v: 'PUBLIC', label: 'Public', help: 'Everyone can find and watch it', Icon: Globe2 },
] as const;

/** Title, description, thumbnail, audience, category, tags, language and visibility of one video. */
export function VideoDetailsForm({ video, onSaved, saveLabel = 'Save' }: { video: StudioVideo; onSaved: (v: StudioVideo) => void; saveLabel?: string }) {
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description ?? '');
  const [visibility, setVisibility] = useState(video.visibility);
  const [category, setCategory] = useState(video.category?.slug ?? '');
  const [tags, setTags] = useState(video.tags.join(', '));
  const [language, setLanguage] = useState<string | null>(video.language);
  const [kids, setKids] = useState<boolean | null>(video.publishedAt || video.madeForKids ? video.madeForKids : null);
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
      const r = await api<{ video: StudioVideo }>(`/studio/videos/${video.id}`, { method: 'PATCH', body: {
        title, description, visibility, category: category || null, language, madeForKids: kids,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean), ...(thumb !== null ? { thumbnail: thumb } : {}),
      } });
      setMessage({ ok: true, text: visibility === 'PRIVATE' ? 'Saved' : video.status === 'READY' ? 'Published' : 'Saved. It goes live when processing finishes.' });
      onSaved(r.video);
    } catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }); } finally { setBusy(false); }
  };
  const uploadThumb = async (f: File) => {
    if (f.size > 2 * 1024 * 1024) { setMessage({ ok: false, text: 'The image must be 2 MB or smaller.' }); return; }
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/studio/videos/${video.id}/thumbnail`, { method: 'PUT', body: f, headers: { 'content-type': f.type || 'application/octet-stream' }, credentials: 'same-origin' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.message ?? 'Could not upload the image.');
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
        <p className="text-[13px] text-muted">Pick a frame or upload a picture (JPEG, PNG or WebP, 1280×720, up to 2 MB).</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" disabled={!video.thumbnailCandidates.length || busy} onClick={() => file.current?.click()}
            className="flex aspect-video w-36 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-[12px] text-muted hover:bg-surface disabled:opacity-50">
            <ImagePlus size={20} />Upload thumbnail
          </button>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadThumb(f); e.target.value = ''; }} />
          {video.customThumbnail && video.thumbnailUrl && (
            <span className={`relative aspect-video w-36 overflow-hidden rounded-lg ring-2 ${chosen === -1 ? 'ring-ink' : 'ring-transparent'}`}><img src={video.thumbnailUrl} alt="Custom thumbnail" className="h-full w-full object-cover" /></span>
          )}
          {video.thumbnailCandidates.length ? video.thumbnailCandidates.map((u, i) => (
            <button key={u} type="button" onClick={() => setThumb(i)} aria-pressed={chosen === i} className={`relative aspect-video w-36 overflow-hidden rounded-lg ring-2 ${chosen === i ? 'ring-ink' : 'ring-transparent hover:ring-line'}`}>
              <img src={u} alt={`Frame ${i + 1}`} className="h-full w-full object-cover" />{chosen === i && <Check size={18} className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white" />}
            </button>
          )) : <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 size={14} className="animate-spin" />Frames appear once processing starts.</p>}
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
        <div className="sm:col-span-2"><label htmlFor="v-tags" className={label}>Tags</label><input id="v-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Separate tags with commas" className={`${inputClass} mt-2`} /></div>
      </div>
      <fieldset>
        <legend className={label}>Visibility</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {VISIBILITY.map(({ v, label: l, help, Icon }) => (
            <label key={v} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${visibility === v ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface'}`}>
              <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} className="mt-1 h-4 w-4 accent-[var(--brand)]" />
              <span><span className="flex items-center gap-1.5 text-[14px] font-medium"><Icon size={15} />{l}</span><span className="text-[12px] text-muted">{help}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center justify-end gap-4">
        {message && <p role="status" className={`text-[14px] ${message.ok ? 'text-brand' : 'text-danger'}`}>{message.text}</p>}
        <button type="submit" disabled={busy || !title.trim()} className="flex h-10 items-center gap-2 rounded-full bg-strong px-6 text-[14px] font-medium text-on-strong hover:opacity-90 disabled:opacity-40">
          {busy && <Loader2 size={16} className="animate-spin" />}{saveLabel}
        </button>
      </div>
    </form>
  );
}
