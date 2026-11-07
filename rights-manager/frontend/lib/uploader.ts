"use client";

import { API_URL, ApiError, api } from "@/lib/api";

/**
 * Fast resumable upload straight to Hetzner Object Storage.
 * - parts of `chunk_size` (5 MB, more for huge files) cut with Blob.slice, never read whole into memory
 * - 4 parts at a time; under 1 MB/s → 1, over 10 MB/s → 6 (measured over the last 5 s)
 * - a failed part is retried 3 times (1 s, 2 s, 4 s) without touching the others
 * - pause aborts the parts in flight; resume asks Hetzner which parts it has and sends only the missing ones
 * - SHA-256 is computed in a worker meanwhile; a file uploaded before is linked at once
 * - the upload id is remembered per file, so after a refresh choosing the same file continues where it stopped
 */

export type TaskState = "queued" | "starting" | "uploading" | "paused" | "completing" | "processing" | "duplicate" | "error" | "cancelled";

export interface Snapshot {
  id: string; file: { name: string; size: number }; state: TaskState; uploadId: string | null; videoId: string | null;
  bytes: number; total: number; speed: number; eta: number | null; parallel: number; chunkSize: number; parts: number; partsDone: number;
  hashProgress: number; error: string | null; duplicateTitle: string | null; resumedFrom: number;
}

interface Session { upload_id: string; video_id: string; chunk_size: number; total_chunks: number; status: string; duplicate_of: string | null; bytes_uploaded: number }

const MB = 1024 * 1024;
const fingerprint = (f: File) => `upload:${f.name}:${f.size}:${f.lastModified}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function remember(f: File, id: string | null) {
  try { if (id) localStorage.setItem(fingerprint(f), id); else localStorage.removeItem(fingerprint(f)); } catch { /* private mode */ }
}
function remembered(f: File) {
  try { return localStorage.getItem(fingerprint(f)); } catch { return null; }
}

export class UploadTask {
  readonly id = Math.random().toString(36).slice(2);
  state: TaskState = "queued";
  session: Session | null = null;
  error: string | null = null;
  duplicateTitle: string | null = null;
  private done = new Set<number>();
  private sizes = new Map<number, number>();
  private inflight = new Map<number, XMLHttpRequest>();
  private partLoaded = new Map<number, number>();
  private urls = new Map<number, { url: string; until: number }>();
  private samples: { t: number; bytes: number }[] = [];
  private hasher: Worker | null = null;
  hashProgress = 0;
  parallel = 4;
  resumedFrom = 0;

  constructor(readonly file: File, private onChange: () => void, initialParallel = 4, private title?: string) {
    this.parallel = initialParallel;
  }

  /** The state right now (pause/cancel can change it while an await is pending). */
  private now(): TaskState { return this.state; }

  get bytes() {
    let b = 0;
    this.sizes.forEach((s, n) => { if (this.done.has(n)) b += s; });
    this.partLoaded.forEach((v) => { b += v; });
    return Math.min(b, this.file.size);
  }

  snapshot(): Snapshot {
    const speed = this.speed();
    const left = this.file.size - this.bytes;
    return {
      id: this.id, file: { name: this.file.name, size: this.file.size }, state: this.state, uploadId: this.session?.upload_id ?? null,
      videoId: this.session?.video_id ?? null, bytes: this.state === "processing" || this.state === "duplicate" ? this.file.size : this.bytes,
      total: this.file.size, speed, eta: speed > 0 && this.state === "uploading" ? left / speed : null, parallel: this.parallel,
      chunkSize: this.session?.chunk_size ?? 0, parts: this.session?.total_chunks ?? 0, partsDone: this.done.size, hashProgress: this.hashProgress,
      error: this.error, duplicateTitle: this.duplicateTitle, resumedFrom: this.resumedFrom,
    };
  }

  /** Bytes per second over the last 5 s. */
  speed() {
    const now = performance.now();
    this.samples = this.samples.filter((s) => now - s.t < 5000);
    if (this.samples.length < 2) return 0;
    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    return last.t > first.t ? ((last.bytes - first.bytes) / (last.t - first.t)) * 1000 : 0;
  }

  private tick() {
    this.samples.push({ t: performance.now(), bytes: this.bytes });
    this.onChange();
  }

  private adapt() {
    const s = this.speed();
    if (this.samples.length < 4) return;
    const target = s < 1 * MB ? 1 : s > 10 * MB ? 6 : 4;
    if (target !== this.parallel) this.parallel = target;
  }

  async start() {
    if (["uploading", "completing", "processing", "duplicate"].includes(this.state)) return;
    this.error = null;
    this.state = "starting";
    this.onChange();
    try {
      const known = remembered(this.file);
      let s: Session | null = null;
      if (known) {
        try {
          const r = await api<Session & { done: number[] }>(`/api/uploads/${known}/parts`);
          if (r.status === "Completed") { remember(this.file, null); }
          else { s = r; r.done.forEach((n) => this.markDone(n, r)); this.resumedFrom = this.bytes; }
        } catch { remember(this.file, null); }
      }
      if (!s) {
        s = await api<Session>("/api/uploads/create", { method: "POST", json: { file_name: this.file.name, file_size: this.file.size, title: this.title } });
        remember(this.file, s.upload_id);
      }
      this.session = s;
      if (!this.hasher && this.now() !== "duplicate") this.startHash();
      await this.pump();
    } catch (e) {
      const st = this.now();
      if (st === "paused" || st === "cancelled" || st === "duplicate") return;
      this.state = "error";
      this.error = (e as Error).message;
      this.onChange();
    }
  }

  private markDone(n: number, s: Session) {
    this.done.add(n);
    this.sizes.set(n, Math.min(s.chunk_size, this.file.size - (n - 1) * s.chunk_size));
  }

  private startHash() {
    try {
      this.hasher = new Worker(new URL("./hash.worker.ts", import.meta.url));
      this.hasher.onmessage = async (e) => {
        if (e.data.progress !== undefined) { this.hashProgress = e.data.progress; return; }
        this.hashProgress = 1;
        this.hasher?.terminate();
        if (!this.session || this.state === "cancelled") return;
        try {
          const r = await api<{ duplicate: boolean; duplicate_title: string | null }>(`/api/uploads/${this.session.upload_id}/hash`, { method: "POST", json: { sha256: e.data.sha256 } });
          if (r.duplicate) {
            this.state = "duplicate";
            this.duplicateTitle = r.duplicate_title;
            this.abortAll();
            remember(this.file, null);
            this.onChange();
          }
        } catch { /* the upload still works without the hash */ }
      };
      this.hasher.postMessage({ file: this.file });
    } catch { /* no worker support: skip deduplication */ }
  }

  private async sign(n: number): Promise<string> {
    const cached = this.urls.get(n);
    if (cached && cached.until > Date.now()) return cached.url;
    const s = this.session!;
    // Sign the next few missing parts in one request.
    const want: number[] = [];
    for (let k = n; k <= s.total_chunks && want.length < 20; k++) if (!this.done.has(k)) want.push(k);
    const r = await api<{ urls: Record<string, string>; expires_in: number }>(`/api/uploads/${s.upload_id}/sign`, { method: "POST", json: { part_numbers: want } });
    const until = Date.now() + (r.expires_in - 120) * 1000;
    Object.entries(r.urls).forEach(([k, url]) => this.urls.set(Number(k), { url, until }));
    return this.urls.get(n)!.url;
  }

  private putPart(n: number, url: string, blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.inflight.set(n, xhr);
      xhr.open("PUT", url);
      xhr.upload.onprogress = (e) => { this.partLoaded.set(n, e.loaded); this.tick(); };
      xhr.onload = () => {
        this.inflight.delete(n);
        this.partLoaded.delete(n);
        const etag = xhr.getResponseHeader("ETag");
        if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
        else reject(new ApiError(xhr.status, xhr.status === 403 ? "expired" : `Part ${n} failed (${xhr.status || "network"})`));
      };
      xhr.onerror = () => { this.inflight.delete(n); this.partLoaded.delete(n); reject(new ApiError(0, `Part ${n}: network error`)); };
      xhr.onabort = () => { this.inflight.delete(n); this.partLoaded.delete(n); reject(new ApiError(-1, "aborted")); };
      xhr.send(blob);
    });
  }

  private async sendPart(n: number) {
    const s = this.session!;
    const start = (n - 1) * s.chunk_size;
    const blob = this.file.slice(start, Math.min(start + s.chunk_size, this.file.size));
    for (let attempt = 0; ; attempt++) {
      if (this.state !== "uploading") throw new ApiError(-1, "aborted");
      try {
        const etag = await this.putPart(n, await this.sign(n), blob);
        this.done.add(n);
        this.sizes.set(n, blob.size);
        this.tick();
        api(`/api/uploads/${s.upload_id}/progress`, { method: "POST", json: { part_number: n, etag, size: blob.size } }).catch(() => undefined);
        return;
      } catch (e) {
        const err = e as ApiError;
        if (err.status === -1) throw err;
        if (err.message === "expired") this.urls.delete(n);
        if (attempt >= 3) throw new Error(`Part ${n} failed 3 times: ${err.message}`);
        await sleep(1000 * 2 ** attempt); // 1 s, 2 s, 4 s
      }
    }
  }

  private async pump() {
    const s = this.session!;
    this.state = "uploading";
    this.onChange();
    const queue: number[] = [];
    for (let n = 1; n <= s.total_chunks; n++) if (!this.done.has(n)) queue.push(n);
    let failure: Error | null = null;
    const running = new Set<Promise<void>>();
    while ((queue.length || running.size) && this.state === "uploading" && !failure) {
      this.adapt();
      while (queue.length && running.size < this.parallel && this.state === "uploading") {
        const n = queue.shift()!;
        const p: Promise<void> = this.sendPart(n).catch((e) => { if ((e as ApiError).status !== -1) failure = e as Error; else queue.unshift(n); })
          .finally(() => running.delete(p));
        running.add(p);
      }
      if (running.size) await Promise.race(running);
    }
    if (failure) throw failure;
    if (this.state !== "uploading") return;
    this.state = "completing";
    this.onChange();
    await api(`/api/uploads/${s.upload_id}/complete`, { method: "POST" });
    remember(this.file, null);
    this.state = "processing";
    this.onChange();
  }

  private abortAll() {
    this.inflight.forEach((x) => x.abort());
    this.inflight.clear();
    this.partLoaded.clear();
  }

  pause() {
    if (this.state !== "uploading" && this.state !== "starting") return;
    this.state = "paused";
    this.abortAll();
    if (this.session) api(`/api/uploads/${this.session.upload_id}/pause`, { method: "POST" }).catch(() => undefined);
    this.onChange();
  }

  resume() {
    if (this.state !== "paused" && this.state !== "error") return;
    this.state = "queued";
    // Hetzner is asked again which parts it holds (the browser's memory is not trusted).
    this.done.clear();
    this.sizes.clear();
    void this.start();
  }

  async cancel() {
    this.state = "cancelled";
    this.abortAll();
    this.hasher?.terminate();
    remember(this.file, null);
    if (this.session) await api(`/api/uploads/${this.session.upload_id}`, { method: "DELETE" }).catch(() => undefined);
    this.onChange();
  }
}

/** Runs up to 2 files at a time, the rest wait; lives outside React so uploads continue while the user moves around the app. */
class UploadManager {
  tasks: UploadTask[] = [];
  private listeners = new Set<() => void>();
  private initialParallel = 4;
  maxConcurrentFiles = 2;

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit = () => { this.listeners.forEach((f) => f()); this.schedule(); };

  setInitialParallel(n: number) { this.initialParallel = n; }

  add(files: File[]) {
    for (const f of files.slice(0, Math.max(0, 10 - this.active().length))) this.tasks.unshift(new UploadTask(f, this.emit, this.initialParallel));
    this.emit();
  }

  active() { return this.tasks.filter((t) => ["queued", "starting", "uploading", "paused", "completing"].includes(t.state)); }

  private schedule() {
    const running = this.tasks.filter((t) => ["starting", "uploading", "completing"].includes(t.state)).length;
    let slots = this.maxConcurrentFiles - running;
    for (const t of [...this.tasks].reverse()) {
      if (slots <= 0) break;
      if (t.state === "queued") { slots--; void t.start(); }
    }
  }

  remove(id: string) { this.tasks = this.tasks.filter((t) => t.id !== id); this.emit(); }
}

export const uploads = new UploadManager();

/** Times a 5 MB PUT straight to Hetzner to choose how many parts to send at once. */
export async function speedTest(): Promise<number> {
  const { url, bytes } = await api<{ url: string; bytes: number }>("/api/storage/speedtest", { method: "POST" });
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
  const t = performance.now();
  const r = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": "application/octet-stream" } });
  if (!r.ok) throw new Error(`speed test failed (${r.status})`);
  return bytes / ((performance.now() - t) / 1000);
}

export const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
export const fmtEta = (s: number | null) => (s == null || !isFinite(s) ? "—" : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s > 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
export { API_URL };
