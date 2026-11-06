'use client';

import { api, ApiError } from './client-api';
import { compressVideo } from './compress';

export type UploadState = 'starting' | 'compressing' | 'uploading' | 'paused' | 'finishing' | 'done' | 'error' | 'cancelled';
export interface UploadSnapshot {
  state: UploadState; videoId: string | null; title: string; sent: number; total: number; bytesPerSecond: number; secondsLeft: number | null; error: string | null;
  /** While compressing: how far (0–1). After: the original size, when a smaller copy is being uploaded instead. */
  compress: { progress: number; originalBytes: number; savedBytes: number | null } | null;
}

const INITIAL_PARALLEL = 4;
const MAX_PARALLEL = 6;
const SAMPLE_PARTS = 12;
const URL_BATCH = 20;
const STORE = 'fm_uploads';
const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
function remembered(): Record<string, string> { try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; } }
function remember(f: File, id: string | null) {
  try { const m = remembered(); if (id) m[fileKey(f)] = id; else delete m[fileKey(f)]; localStorage.setItem(STORE, JSON.stringify(m)); } catch { /* storage blocked */ }
}

/**
 * Uploads one file straight to storage in parts with adaptive concurrency, each retried with backoff, with progress, speed and
 * time left. Choosing the same file again after a closed tab or a lost connection resumes from the parts already stored.
 */
export class VideoUpload {
  private snap: UploadSnapshot;
  private assembled = false;
  private partSize = 0;
  private partCount = 0;
  private done = new Set<number>();
  private completedBytes = 0;
  private transferBytes = 0;
  private transferMs = 0;
  private retries = 0;
  private peakParallel = 0;
  private lastTick = -Infinity;
  private inflight = new Map<number, XMLHttpRequest>();
  private progress = new Map<number, number>();
  private urls = new Map<number, string>();
  private signing: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private retryWaiters = new Set<() => void>();
  private samples: Array<[number, number]> = [];

  /** What is uploaded: the chosen file, or a smaller copy made in the browser. */
  file: File;
  private compressed = false;
  private compressing: AbortController | null = null;

  constructor(readonly original: File, private readonly onChange: (s: UploadSnapshot) => void, private readonly options: { ad?: boolean; compress?: boolean } = {}) {
    this.file = original;
    this.snap = { state: 'starting', videoId: null, title: original.name.replace(/\.[^.]+$/, ''), sent: 0, total: original.size, bytesPerSecond: 0, secondsLeft: null, error: null, compress: null };
  }

  private cancelled() { return this.snap.state === 'cancelled'; }
  /** Upload the original instead of finishing the smaller copy. */
  skipCompression() { this.compressing?.abort(new DOMException('skipped', 'AbortError')); }

  /**
   * A smaller copy before uploading (on by default; less mobile data and a much shorter upload). Not for a file that
   * is already partly uploaded from an earlier visit: that upload resumes as it was.
   */
  private async prepare() {
    if (this.options.compress === false || this.compressed || this.snap.videoId || remembered()[fileKey(this.original)]) return;
    const ctl = new AbortController(); this.compressing = ctl;
    this.set({ state: 'compressing', compress: { progress: 0, originalBytes: this.original.size, savedBytes: null } });
    try {
      const r = await compressVideo(this.original, (progress) => { if (this.snap.state === 'compressing') this.set({ compress: { progress, originalBytes: this.original.size, savedBytes: null } }); }, ctl.signal);
      if (r) {
        this.file = r.file; this.compressed = true;
        this.set({ total: r.file.size, compress: { progress: 1, originalBytes: this.original.size, savedBytes: this.original.size - r.file.size } });
      } else this.set({ compress: null });
    } catch {
      this.set({ compress: null }); // skipped or cancelled: the original goes up
    } finally { this.compressing = null; }
    if (this.snap.state === 'compressing') this.set({ state: 'starting' });
  }
  get snapshot() { return this.snap; }
  private set(p: Partial<UploadSnapshot>) { this.snap = { ...this.snap, ...p }; this.onChange(this.snap); }

  async start() {
    try {
      await this.prepare();
      if (this.cancelled()) return;
      // A smaller copy is made anew each time, so it is not resumed after the tab closes (the original is).
      const previous = this.compressed ? undefined : remembered()[fileKey(this.file)];
      if (previous) {
        const s = await api<{ status: string; partSize: number; assembled?: boolean; parts: Array<{ partNumber: number; etag: string }> }>(`/uploads/${previous}`).catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        });
        if (this.snap.state === 'cancelled') return;
        if (s?.status === 'UPLOADING') {
          this.assembled = s.assembled === true;
          this.partSize = s.partSize; this.partCount = Math.ceil(this.file.size / s.partSize);
          for (const p of s.parts) {
            this.done.add(p.partNumber);
            this.completedBytes += this.size(p.partNumber);
          }
          this.set({ videoId: previous });
        } else if (s?.status === 'PROCESSING' || s?.status === 'READY') {
          remember(this.file, null);
          this.set({ videoId: previous, state: 'done', sent: this.file.size });
          return;
        }
      }
      if (!this.snap.videoId) {
        const r = await api<{ videoId: string; title: string; partSize: number; partCount: number }>('/uploads', { body: { fileName: this.file.name, sizeBytes: this.file.size, ...(this.options.ad ? { ad: true } : {}) } });
        if (this.snap.state === 'cancelled') {
          await api(`/uploads/${r.videoId}`, { method: 'DELETE', body: {} });
          return;
        }
        this.partSize = r.partSize; this.partCount = r.partCount;
        if (!this.compressed) remember(this.file, r.videoId);
        this.set({ videoId: r.videoId, title: r.title });
      }
      await this.run();
    } catch (e) { this.fail(e); }
  }

  private sentBytes() {
    let n = this.completedBytes;
    for (const v of this.progress.values()) n += v;
    return n;
  }
  private size(p: number) { return p < this.partCount ? this.partSize : this.file.size - this.partSize * (this.partCount - 1); }

  private tick(force = false) {
    const now = performance.now();
    if (!force && now - this.lastTick < 100) return;
    this.lastTick = now;
    const sent = this.sentBytes();
    this.samples.push([now, sent]);
    this.samples = this.samples.filter(([t]) => now - t < 8000);
    const [t0, s0] = this.samples[0];
    const bps = now - t0 > 500 ? Math.max(0, ((sent - s0) * 1000) / (now - t0)) : this.snap.bytesPerSecond;
    this.set({ sent, bytesPerSecond: bps, secondsLeft: bps > 0 ? Math.round((this.file.size - sent) / bps) : null });
  }

  private run() {
    this.running ??= this.pump().catch((e) => this.fail(e)).finally(() => { this.running = null; });
    return this.running;
  }

  private async pump() {
    if (this.snap.state === 'paused' || this.snap.state === 'cancelled') return;
    this.samples = [];
    this.set({ state: 'uploading', error: null, bytesPerSecond: 0, secondsLeft: null });
    this.tick(true);
    const todo = this.assembled ? [] : Array.from({ length: this.partCount }, (_, i) => i + 1).filter((n) => !this.done.has(n));
    if (todo.length) await this.transfer(todo);
    if (this.snap.state !== 'uploading') return;
    if (!this.assembled && this.done.size !== this.partCount) return this.fail(new Error('Some parts could not be uploaded.'));
    this.set({ state: 'finishing', sent: this.file.size, secondsLeft: 0 });
    await api(`/uploads/${this.snap.videoId}/complete`, { body: {
      transfer: {
        bytes: this.transferBytes,
        durationMs: Math.round(this.transferMs),
        retries: this.retries,
        peakParallel: this.peakParallel,
      },
    } });
    remember(this.file, null);
    this.set({ state: 'done' });
  }

  private async transfer(todo: number[]) {
    const started = performance.now();
    const active = new Set<Promise<void>>();
    let next = 0;
    let parallel = INITIAL_PARALLEL;
    let baseline = 0;
    let settled = false;
    let sampleStart = started;
    let sampleBytes = this.transferBytes;
    let sampleParts = this.done.size;
    let sampleRetries = this.retries;

    while (this.snap.state === 'uploading' && (next < todo.length || active.size)) {
      while (next < todo.length && active.size < parallel) {
        const part = todo[next++];
        const task = this.sendPart(part).catch((e) => this.fail(e)).finally(() => active.delete(task));
        active.add(task);
        this.peakParallel = Math.max(this.peakParallel, active.size);
      }
      await Promise.race(active);
      if (this.retries > sampleRetries) {
        parallel = Math.max(2, parallel - 1);
        sampleRetries = this.retries;
        settled = true;
      }
      if (settled || todo.length - next < SAMPLE_PARTS) continue;
      if (this.done.size - sampleParts < SAMPLE_PARTS) continue;

      const now = performance.now();
      const rate = (this.transferBytes - sampleBytes) / Math.max(1, now - sampleStart);
      if (baseline && rate < baseline * 1.1) {
        parallel--;
        settled = true;
      } else if (parallel < MAX_PARALLEL) {
        parallel++;
        baseline = rate;
      } else {
        settled = true;
      }
      sampleStart = now;
      sampleBytes = this.transferBytes;
      sampleParts = this.done.size;
    }
    await Promise.all(active);
    this.transferMs += performance.now() - started;
  }

  private async urlFor(n: number) {
    while (!this.urls.has(n)) {
      this.signing ??= this.signBatch(n).finally(() => { this.signing = null; });
      await this.signing;
      if (this.snap.state !== 'uploading') return null;
    }
    return this.urls.get(n)!;
  }

  private async signBatch(n: number) {
    const start = Math.floor((n - 1) / URL_BATCH) * URL_BATCH + 1;
    const partNumbers = Array.from({ length: URL_BATCH }, (_, i) => start + i)
      .filter((p) => p <= this.partCount && !this.done.has(p) && !this.urls.has(p));
    const r = await api<{ urls: Record<string, string> }>(`/uploads/${this.snap.videoId}/parts`, { body: { partNumbers } });
    for (const [k, v] of Object.entries(r.urls)) this.urls.set(Number(k), v);
    if (!this.urls.has(n)) throw new Error('Missing signed upload URL.');
  }

  private async sendPart(n: number) {
    for (let attempt = 0; ; attempt++) {
      if (this.snap.state !== 'uploading') return;
      try {
        const url = await this.urlFor(n);
        if (!url || this.snap.state !== 'uploading') return;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          this.inflight.set(n, xhr);
          xhr.open('PUT', url);
          xhr.upload.onprogress = (e) => { this.progress.set(n, e.loaded); this.tick(); };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(Object.assign(new Error(`part ${n}: ${xhr.status}`), { status: xhr.status }));
          };
          xhr.onerror = () => reject(new Error('network'));
          xhr.onabort = () => reject(new Error('aborted'));
          xhr.send(this.file.slice((n - 1) * this.partSize, n * this.partSize));
        });
        this.inflight.delete(n); this.progress.delete(n);
        this.done.add(n);
        this.completedBytes += this.size(n);
        this.transferBytes += this.size(n);
        this.urls.delete(n);
        this.tick();
        return;
      } catch (e) {
        this.inflight.delete(n); this.progress.delete(n);
        if (this.snap.state !== 'uploading') return;
        if ((e as { status?: number }).status === 403) this.urls.delete(n); // link expired: get a new one
        this.retries++;
        if (attempt >= 6) throw e;
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            this.retryWaiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, Math.min(30_000, 1000 * 2 ** attempt));
          this.retryWaiters.add(wake);
        });
      }
    }
  }

  private stopTransfers() {
    for (const x of this.inflight.values()) x.abort();
    for (const wake of this.retryWaiters) wake();
  }

  pause() {
    if (this.snap.state !== 'uploading') return;
    this.set({ state: 'paused' });
    this.stopTransfers();
  }
  async resume() {
    if (this.snap.state !== 'paused' && this.snap.state !== 'error') return;
    await this.running;
    if (this.snap.state !== 'paused' && this.snap.state !== 'error') return;
    if (this.snap.videoId) await this.run();
    else {
      this.set({ state: 'starting', error: null });
      await this.start();
    }
  }
  async cancel() {
    if (this.snap.state === 'finishing' || this.snap.state === 'done') return;
    this.set({ state: 'cancelled' });
    this.compressing?.abort();
    this.stopTransfers();
    remember(this.file, null);
    if (this.snap.videoId) await api(`/uploads/${this.snap.videoId}`, { method: 'DELETE', body: {} }).catch(() => undefined);
  }
  private fail(e: unknown) {
    if (this.snap.state === 'cancelled' || this.snap.state === 'paused') return;
    this.set({ state: 'error', error: e instanceof ApiError ? e.message : 'The upload stopped. Check your connection, then resume.' });
    this.stopTransfers();
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
