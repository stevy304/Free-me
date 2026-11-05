'use client';

import { api, ApiError } from './client-api';

export type UploadState = 'starting' | 'uploading' | 'paused' | 'finishing' | 'done' | 'error' | 'cancelled';
export interface UploadSnapshot { state: UploadState; videoId: string | null; title: string; sent: number; total: number; bytesPerSecond: number; secondsLeft: number | null; error: string | null }

const PARALLEL = 4;
const STORE = 'fm_uploads';
const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
function remembered(): Record<string, string> { try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; } }
function remember(f: File, id: string | null) {
  try { const m = remembered(); if (id) m[fileKey(f)] = id; else delete m[fileKey(f)]; localStorage.setItem(STORE, JSON.stringify(m)); } catch { /* storage blocked */ }
}

/**
 * Uploads one file straight to storage in parts: four at a time, each retried with backoff, with progress, speed and
 * time left. Choosing the same file again after a closed tab or a lost connection resumes from the parts already stored.
 */
export class VideoUpload {
  private snap: UploadSnapshot;
  private partSize = 0;
  private partCount = 0;
  private done = new Map<number, string>(); // part → ETag
  private inflight = new Map<number, XMLHttpRequest>();
  private progress = new Map<number, number>();
  private urls = new Map<number, string>();
  private samples: Array<[number, number]> = [];

  constructor(readonly file: File, private readonly onChange: (s: UploadSnapshot) => void) {
    this.snap = { state: 'starting', videoId: null, title: file.name.replace(/\.[^.]+$/, ''), sent: 0, total: file.size, bytesPerSecond: 0, secondsLeft: null, error: null };
  }
  get snapshot() { return this.snap; }
  private set(p: Partial<UploadSnapshot>) { this.snap = { ...this.snap, ...p }; this.onChange(this.snap); }

  async start() {
    try {
      const previous = remembered()[fileKey(this.file)];
      if (previous) {
        const s = await api<{ status: string; partSize: number; parts: Array<{ partNumber: number; etag: string }> }>(`/uploads/${previous}`).catch(() => null);
        if (s?.status === 'UPLOADING') {
          this.partSize = s.partSize; this.partCount = Math.ceil(this.file.size / s.partSize);
          for (const p of s.parts) this.done.set(p.partNumber, p.etag);
          this.set({ videoId: previous });
        }
      }
      if (!this.snap.videoId) {
        const r = await api<{ videoId: string; title: string; partSize: number; partCount: number }>('/uploads', { body: { fileName: this.file.name, sizeBytes: this.file.size } });
        this.partSize = r.partSize; this.partCount = r.partCount;
        remember(this.file, r.videoId);
        this.set({ videoId: r.videoId, title: r.title });
      }
      await this.pump();
    } catch (e) { this.fail(e); }
  }

  private sentBytes() {
    let n = 0;
    for (const p of this.done.keys()) n += this.size(p);
    for (const v of this.progress.values()) n += v;
    return n;
  }
  private size(p: number) { return p < this.partCount ? this.partSize : this.file.size - this.partSize * (this.partCount - 1); }

  private tick() {
    const sent = this.sentBytes();
    const now = performance.now();
    this.samples.push([now, sent]);
    this.samples = this.samples.filter(([t]) => now - t < 8000);
    const [t0, s0] = this.samples[0];
    const bps = now - t0 > 500 ? ((sent - s0) * 1000) / (now - t0) : this.snap.bytesPerSecond;
    this.set({ sent, bytesPerSecond: bps, secondsLeft: bps > 0 ? Math.round((this.file.size - sent) / bps) : null });
  }

  private async pump() {
    if (this.snap.state === 'paused' || this.snap.state === 'cancelled') return;
    this.set({ state: 'uploading', error: null });
    const todo = Array.from({ length: this.partCount }, (_, i) => i + 1).filter((n) => !this.done.has(n));
    const queue = [...todo];
    const worker = async () => {
      while (queue.length && this.snap.state === 'uploading') {
        const n = queue.shift()!;
        await this.sendPart(n);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (this.snap.state !== 'uploading') return;
    if (this.done.size !== this.partCount) return this.fail(new Error('Some parts could not be uploaded.'));
    this.set({ state: 'finishing', sent: this.file.size, secondsLeft: 0 });
    await api(`/uploads/${this.snap.videoId}/complete`, { body: { parts: [...this.done].map(([partNumber, etag]) => ({ partNumber, etag })) } });
    remember(this.file, null);
    this.set({ state: 'done' });
  }

  private async urlFor(n: number) {
    if (!this.urls.has(n)) {
      const want = Array.from({ length: 20 }, (_, i) => n + i).filter((p) => p <= this.partCount && !this.done.has(p));
      const r = await api<{ urls: Record<string, string> }>(`/uploads/${this.snap.videoId}/parts`, { body: { partNumbers: want } });
      for (const [k, v] of Object.entries(r.urls)) this.urls.set(Number(k), v);
    }
    return this.urls.get(n)!;
  }

  private async sendPart(n: number) {
    for (let attempt = 0; ; attempt++) {
      if (this.snap.state !== 'uploading') return;
      try {
        const url = await this.urlFor(n);
        const etag = await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          this.inflight.set(n, xhr);
          xhr.open('PUT', url);
          xhr.upload.onprogress = (e) => { this.progress.set(n, e.loaded); this.tick(); };
          xhr.onload = () => {
            const tag = xhr.getResponseHeader('ETag');
            if (xhr.status >= 200 && xhr.status < 300 && tag) resolve(tag); else reject(Object.assign(new Error(`part ${n}: ${xhr.status}`), { status: xhr.status }));
          };
          xhr.onerror = () => reject(new Error('network'));
          xhr.onabort = () => reject(new Error('aborted'));
          xhr.send(this.file.slice((n - 1) * this.partSize, n * this.partSize));
        });
        this.inflight.delete(n); this.progress.delete(n);
        this.done.set(n, etag);
        this.tick();
        return;
      } catch (e) {
        this.inflight.delete(n); this.progress.delete(n);
        if (this.snap.state !== 'uploading') return;
        if ((e as { status?: number }).status === 403) this.urls.delete(n); // link expired: get a new one
        if (attempt >= 6) throw e;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      }
    }
  }

  pause() { if (this.snap.state !== 'uploading') return; this.set({ state: 'paused' }); for (const x of this.inflight.values()) x.abort(); }
  resume() { if (this.snap.state === 'paused' || this.snap.state === 'error') void this.pump().catch((e) => this.fail(e)); }
  async cancel() {
    this.set({ state: 'cancelled' });
    for (const x of this.inflight.values()) x.abort();
    remember(this.file, null);
    if (this.snap.videoId) await api(`/uploads/${this.snap.videoId}`, { method: 'DELETE', body: {} }).catch(() => undefined);
  }
  private fail(e: unknown) {
    if (this.snap.state === 'cancelled' || this.snap.state === 'paused') return;
    this.set({ state: 'error', error: e instanceof ApiError ? e.message : 'The upload stopped. Check your connection, then resume.' });
  }
}

export function formatBytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function formatEta(s: number | null) {
  if (s === null || !Number.isFinite(s)) return '';
  if (s < 60) return `${s} s left`;
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min left`;
}
