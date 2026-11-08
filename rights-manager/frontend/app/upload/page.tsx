"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle2, Copy, Gauge, Loader2, Pause, Play, UploadCloud, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorBox } from "@/components/shared";
import { api } from "@/lib/api";
import { useData } from "@/lib/hooks";
import { CATEGORIES } from "@/lib/live";
import { fmtBytes, fmtEta, speedTest, uploads, type Snapshot } from "@/lib/uploader";
import { cn } from "@/lib/utils";

const EXT = [".mp4", ".mov", ".webm", ".mkv"];
interface Limits { max_bytes: number; tier: string; can_upload: boolean }
interface Unfinished { upload_id: string; file_name: string; file_size: number; bytes_uploaded: number; status: string }

let cache = { key: "", value: [] as Snapshot[] };
function snap() {
  const list = uploads.tasks.map((t) => t.snapshot());
  const key = list.map((s) => `${s.id}:${s.state}:${s.bytes}:${s.parallel}:${s.hashProgress.toFixed(2)}:${Math.round(s.speed)}`).join("|");
  if (key !== cache.key) cache = { key, value: list };
  return cache.value;
}

function Details({ videoId }: { videoId: string }) {
  const [form, setForm] = useState({ title: "", description: "", tags: "", category: "" });
  const [saved, setSaved] = useState<string | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api<{ id: string; title: string; description: string | null; tags: string[]; category: string | null }[]>("/api/videos/mine").then((vs) => {
      const v = vs.find((x) => x.id === videoId);
      if (v) setForm({ title: v.title, description: v.description ?? "", tags: v.tags.join(", "), category: v.category ?? "" });
    }).catch(() => undefined);
  }, [videoId]);
  async function save() {
    try {
      await api(`/api/videos/${videoId}`, { method: "PATCH", json: { title: form.title || undefined, description: form.description, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean), category: form.category || null } });
      setSaved("Draft saved");
    } catch (e) { setSaved((e as Error).message); }
  }
  return (
    <div className="grid gap-3 border-t pt-3 md:grid-cols-2" onBlur={save}>
      <div className="space-y-1"><Label htmlFor={`t-${videoId}`}>Title</Label><Input id={`t-${videoId}`} value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="space-y-1">
        <Label htmlFor={`c-${videoId}`}>Category</Label>
        <select id={`c-${videoId}`} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="h-10 w-full rounded-md border bg-background px-2 text-sm">
          <option value="">Choose…</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div className="space-y-1 md:col-span-2"><Label htmlFor={`d-${videoId}`}>Description</Label><Textarea id={`d-${videoId}`} value={form.description} maxLength={5000} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor={`g-${videoId}`}>Tags (comma separated)</Label><Input id={`g-${videoId}`} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></div>
      <div className="flex items-end text-xs text-muted-foreground">{saved ?? "Saved as a draft while you type; publish from Videos."}</div>
    </div>
  );
}

function Row({ s }: { s: Snapshot }) {
  const task = uploads.tasks.find((t) => t.id === s.id);
  const pct = s.total ? (s.bytes / s.total) * 100 : 0;
  const label: Record<string, string> = {
    queued: "Waiting", starting: "Starting…", uploading: "Uploading", paused: "Paused", completing: "Upload complete, joining parts…",
    processing: "Upload complete · Processing…", duplicate: "Already uploaded", error: "Stopped", cancelled: "Cancelled",
  };
  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{s.file.name}</div>
          <div className="text-xs text-muted-foreground">{fmtBytes(s.total)}{s.parts ? ` · ${s.parts} parts of ${fmtBytes(s.chunkSize)}` : ""}{s.resumedFrom ? ` · resumed at ${Math.round((s.resumedFrom / s.total) * 100)}%` : ""}</div>
        </div>
        <Badge variant={s.state === "error" ? "destructive" : s.state === "processing" ? "success" : s.state === "duplicate" ? "info" : "secondary"} className="gap-1">
          {(s.state === "uploading" || s.state === "completing" || s.state === "starting") && <Loader2 className="h-3 w-3 animate-spin" />}
          {s.state === "processing" && <CheckCircle2 className="h-3 w-3" />}{s.state === "duplicate" && <Copy className="h-3 w-3" />}{label[s.state]}
        </Badge>
        <div className="flex gap-1">
          {(s.state === "uploading" || s.state === "starting") && <Button size="sm" variant="outline" onClick={() => task?.pause()}><Pause />Pause</Button>}
          {(s.state === "paused" || s.state === "error") && <Button size="sm" variant="outline" onClick={() => task?.resume()}><Play />Resume</Button>}
          {["queued", "starting", "uploading", "paused", "error"].includes(s.state) && <Button size="sm" variant="ghost" onClick={() => { void task?.cancel(); }}><X />Cancel</Button>}
          {["processing", "duplicate", "cancelled"].includes(s.state) && <Button size="sm" variant="ghost" onClick={() => uploads.remove(s.id)} aria-label="Dismiss"><X /></Button>}
        </div>
      </div>
      <div className="space-y-1">
        <div className="h-2 overflow-hidden rounded-full bg-muted"><div className={cn("h-full transition-all", s.state === "paused" ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{pct.toFixed(1)}% · {fmtBytes(s.bytes)} of {fmtBytes(s.total)}</span>
          {s.state === "uploading" && <span>{(s.speed / 1024 / 1024).toFixed(1)} MB/s · {fmtEta(s.eta)} left · {s.parallel} parallel</span>}
          {s.hashProgress > 0 && s.hashProgress < 1 && <span>Checking for duplicates {Math.round(s.hashProgress * 100)}%</span>}
        </div>
      </div>
      {s.error && <ErrorBox message={s.error} />}
      {s.state === "duplicate" && <p className="text-sm">You uploaded this file before{s.duplicateTitle ? ` (“${s.duplicateTitle}”)` : ""}. Nothing was sent again; this video uses the stored copy.</p>}
      {s.videoId && s.state !== "cancelled" && <Details videoId={s.videoId} />}
      {(s.state === "processing" || s.state === "duplicate") && s.videoId && <Link className="text-sm text-primary hover:underline" href="/studio/videos">See processing in Videos →</Link>}
    </li>
  );
}

export default function UploadPage() {
  const list = useSyncExternalStore((f) => uploads.subscribe(f), snap, () => cache.value);
  const limits = useData(() => api<Limits>("/api/uploads/limits"), []);
  const unfinished = useData(() => api<Unfinished[]>("/api/uploads"), []);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [speed, setSpeed] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function runSpeedTest() {
    try {
      const bps = await speedTest();
      setSpeed(bps);
      uploads.setInitialParallel(bps < 1024 * 1024 ? 1 : bps > 10 * 1024 * 1024 ? 6 : 4);
    } catch (e) { setError((e as Error).message); }
  }

  function add(files: FileList | File[]) {
    setError(null);
    const max = limits.data?.max_bytes ?? Infinity;
    const ok: File[] = [];
    for (const f of Array.from(files).slice(0, 10)) {
      const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
      if (!EXT.includes(ext)) { setError(`${f.name}: only MP4, MOV, WebM and MKV.`); continue; }
      if (f.size > max) { setError(`${f.name} is ${fmtBytes(f.size)}; your ${limits.data?.tier} account allows ${fmtBytes(max)}.`); continue; }
      ok.push(f);
    }
    if (files.length > 10) setError("Up to 10 files at once.");
    if (ok.length) uploads.add(ok);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
        <p className="text-sm text-muted-foreground">Videos go straight to storage in parallel parts. Pause, close the tab or lose your connection: choose the same file again and it continues where it stopped.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Choose videos</CardTitle>
          <CardDescription>
            Up to 10 files at once · MP4, MOV, WebM, MKV · {limits.data ? `your ${limits.data.tier} account: up to ${fmtBytes(limits.data.max_bytes)} per video` : "…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <button type="button" onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
            className={cn("flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-10 text-sm hover:border-primary/60", over && "border-primary bg-primary/5")}>
            <UploadCloud className="h-10 w-10 text-muted-foreground" />
            <span><span className="font-medium text-primary">Select files</span> or drag and drop them here</span>
          </button>
          <input ref={input} type="file" multiple accept=".mp4,.mov,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska" className="hidden" data-testid="file-input"
            onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button variant="outline" size="sm" onClick={runSpeedTest}><Gauge />Test upload speed</Button>
            {speed != null && <span className="text-muted-foreground">{(speed / 1024 / 1024).toFixed(1)} MB/s to storage · will send {speed < 1024 * 1024 ? 1 : speed > 10 * 1024 * 1024 ? 6 : 4} parts at a time</span>}
          </div>
          {error && <ErrorBox message={error} />}
        </CardContent>
      </Card>

      {!!unfinished.data?.length && (
        <Card>
          <CardHeader><CardTitle>Unfinished uploads</CardTitle><CardDescription>Choose the same file again to continue; only the missing parts are sent.</CardDescription></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {unfinished.data.map((u) => (
                <li key={u.upload_id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="flex-1 font-medium">{u.file_name}</span>
                  <span className="text-muted-foreground">{Math.round((u.bytes_uploaded / u.file_size) * 100)}% of {fmtBytes(u.file_size)}</span>
                  <Button size="sm" variant="ghost" onClick={() => api(`/api/uploads/${u.upload_id}`, { method: "DELETE" }).then(unfinished.refresh)}>Discard</Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {list.length > 0 && <ul className="space-y-3" aria-label="Uploads">{list.map((s) => <Row key={s.id} s={s} />)}</ul>}
    </div>
  );
}
