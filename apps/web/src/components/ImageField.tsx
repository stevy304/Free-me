'use client';

import { useRef, useState } from 'react';
import * as Icon from '@/components/icons';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Crops a picture to fill `width` x `height` (centred, like object-fit: cover) and encodes it as JPEG under 2 MB, in
 * the browser: a 12 MB phone photo becomes a few hundred KB before it is sent, which matters on mobile data.
 */
export async function cropImage(file: File, width: number, height: number): Promise<Blob> {
  let img: ImageBitmap;
  try { img = await createImageBitmap(file); } catch { throw new Error('This picture could not be opened. Use a JPEG, PNG or WebP image.'); }
  const scale = Math.max(width / img.width, height / img.height);
  const sw = width / scale, sh = height / scale;
  const canvas = document.createElement('canvas');
  // Never enlarge a small picture beyond its own size.
  const out = Math.min(1, 1 / scale);
  canvas.width = Math.max(1, Math.round(width * out)); canvas.height = Math.max(1, Math.round(height * out));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  img.close();
  for (const q of [0.9, 0.8, 0.7, 0.55]) {
    const b = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', q));
    if (b && b.size <= MAX_BYTES) return b;
  }
  throw new Error('The picture is too large. Try a smaller one.');
}

/**
 * A picture setting: preview, Change and Remove. `shape` decides the crop and the preview: a round profile picture,
 * a rounded square Space picture, or a 6:1 banner.
 */
export function ImageField({ label, hint, url, endpoint, shape, fallback, onChange }: {
  label: string; hint: string; url: string | null; endpoint: string; shape: 'round' | 'square' | 'banner'; fallback?: string; onChange: (url: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [w, h] = shape === 'banner' ? [2560, 427] : [512, 512];

  const upload = async (f: File) => {
    setBusy(true); setMsg(null);
    try {
      const body = await cropImage(f, w, h);
      const res = await fetch(`/api${endpoint}`, { method: 'PUT', body, headers: { 'content-type': 'image/jpeg' }, credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message ?? 'Could not upload the picture. Check your connection and try again.');
      onChange(d.avatarUrl ?? d.bannerUrl ?? null);
      setMsg({ ok: true, text: 'Updated' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const remove = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api${endpoint}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not remove the picture.');
      onChange(null); setMsg({ ok: true, text: 'Removed' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };

  const preview = shape === 'banner'
    ? <div className="aspect-[6/1] w-full overflow-hidden rounded-2xl bg-gradient-to-br from-brand-soft to-surface">{url && <img src={url} alt="" className="h-full w-full object-cover" />}</div>
    : <div className={`grid h-24 w-24 shrink-0 place-items-center overflow-hidden bg-brand-soft text-[36px] font-bold text-brand ${shape === 'round' ? 'rounded-full' : 'rounded-[28px]'}`}>{url ? <img src={url} alt="" className="h-full w-full object-cover" /> : (fallback ?? '?').slice(0, 1).toUpperCase()}</div>;

  return (
    <div>
      <p className="text-[14px] font-medium">{label}</p>
      <div className={`mt-2 ${shape === 'banner' ? 'space-y-3' : 'flex items-center gap-5'}`}>
        {preview}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => input.current?.click()} className="flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-[14px] font-semibold hover:bg-surface-hover disabled:opacity-50">
              {busy ? <Icon.Spinner size={16} className="animate-spin" /> : <Icon.Upload size={16} />}{url ? 'Change' : 'Upload'}
            </button>
            {url && <button type="button" disabled={busy} onClick={() => void remove()} className="h-10 rounded-xl px-3 text-[14px] font-semibold text-muted hover:bg-surface disabled:opacity-50">Remove</button>}
            {msg && <span role="status" className={`text-[13px] ${msg.ok ? 'text-brand' : 'text-danger'}`}>{msg.text}</span>}
          </div>
          <p className="mt-1.5 text-[13px] text-muted">{hint}</p>
        </div>
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label={label} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
    </div>
  );
}
