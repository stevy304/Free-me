"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarClock, Clapperboard, Loader2, Radio, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CopyField } from "@/components/copy-field";
import { DestinationsEditor } from "@/components/destinations-editor";
import { Empty, ErrorBox, RowsSkeleton, when } from "@/components/shared";
import { api, uploadWithProgress } from "@/lib/api";
import { useData } from "@/lib/hooks";
import { CATEGORIES, formatDuration, type LiveStream, type Privacy, type StreamKey } from "@/lib/live";
import { cn } from "@/lib/utils";

const STEPS = ["Details", "Destinations", "Encoder", "Go live"];

function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, new Date(to).getTime() - now) / 1000;
  return <span className="font-mono tabular-nums">{left > 0 ? formatDuration(left) : "now"}</span>;
}

function EncoderStep() {
  const key = useData(() => api<StreamKey>("/api/stream-keys/me"), []);
  const [busy, setBusy] = useState(false);
  async function reset() {
    if (!confirm("Make a new stream key? The old one stops working immediately; update it in your encoder.")) return;
    setBusy(true);
    try { key.setData(await api<StreamKey>("/api/stream-keys/reset", { method: "POST" })); } finally { setBusy(false); }
  }
  if (!key.data) return key.error ? <ErrorBox message={key.error} onRetry={key.refresh} /> : <RowsSkeleton rows={1} />;
  return (
    <div className="space-y-5">
      <CopyField label="Stream URL (server)" value={key.data.rtmp_url} />
      <div className="flex items-end gap-2">
        <div className="flex-1"><CopyField label="Stream key" value={key.data.key} secret /></div>
        <Button variant="outline" onClick={reset} disabled={busy}><RefreshCw className={cn(busy && "animate-spin")} />Reset key</Button>
      </div>
      <div className="grid gap-3 text-sm md:grid-cols-2">
        <div className="rounded-lg border p-3"><div className="font-medium">OBS Studio / Streamlabs</div><p className="text-muted-foreground">Settings → Stream → Service <b>Custom</b> → paste the Server and the Stream key → OK → Start Streaming.</p></div>
        <div className="rounded-lg border p-3"><div className="font-medium">vMix</div><p className="text-muted-foreground">Stream → Destination <b>Custom RTMP Server</b> → URL and Stream Name/Key → Start.</p></div>
        <div className="rounded-lg border p-3"><div className="font-medium">Larix Broadcaster (phone)</div><p className="text-muted-foreground">Connections → New → URL <span className="font-mono">{key.data.full_url.replace(/(live_\w{4})\w+/, "$1…")}</span> (server and key together).</p></div>
        <div className="rounded-lg border p-3"><div className="font-medium">More cameras (up to 4)</div><p className="text-muted-foreground">Another encoder uses the same server with the key plus <span className="font-mono">-cam2</span>, <span className="font-mono">-cam3</span> or <span className="font-mono">-cam4</span>. Switch between them in the control room.</p></div>
      </div>
      <p className="text-xs text-muted-foreground">Recommended: 1080p or 720p, 30 or 60 fps, H.264, 4,500–6,000 kbps, keyframe every 2 s, AAC 160 kbps. Keep the key secret: anyone with it can stream to your channel.</p>
    </div>
  );
}

export default function GoLivePage() {
  const router = useRouter();
  const streams = useData(() => api<LiveStream[]>("/api/live"), [], { every: 2000, poll: (d) => d.some((s) => s.armed || s.status === "Live") });
  const [step, setStep] = useState(0);
  const [current, setCurrent] = useState<LiveStream | null>(null);
  const [form, setForm] = useState({ title: "", category: "Technology", description: "", privacy: "Public" as Privacy, schedule: false, scheduled_for: "" });
  const [thumb, setThumb] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = streams.data?.find((s) => s.status === "Live");
  const fresh = current ? streams.data?.find((s) => s.id === current.id) ?? current : null;
  useEffect(() => { if (fresh && fresh.status === "Live" && current?.status !== "Live") setCurrent(fresh); }, [fresh, current]);

  async function createStream(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { title: form.title.trim(), category: form.category, description: form.description || null, privacy: form.privacy,
                     scheduled_for: form.schedule && form.scheduled_for ? new Date(form.scheduled_for).toISOString() : null };
      let s = current
        ? await api<LiveStream>(`/api/live/${current.id}`, { method: "PATCH", json: body })
        : await api<LiveStream>("/api/live", { method: "POST", json: body });
      if (thumb) {
        const f = new FormData(); f.append("file", thumb);
        s = await uploadWithProgress<LiveStream>(`/api/live/${s.id}/thumbnail`, f, () => undefined);
      }
      setCurrent(s); setStep(1); void streams.refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function goLive() {
    if (!current) return;
    setBusy(true); setError(null);
    try { setCurrent(await api<LiveStream>(`/api/live/${current.id}/go-live`, { method: "POST" })); void streams.refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const past = (streams.data ?? []).filter((s) => s.status === "Ended");
  const upcoming = (streams.data ?? []).filter((s) => s.status === "Scheduled" && s.id !== current?.id);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Go live</h1>
          <p className="text-sm text-muted-foreground">Stream from OBS, Streamlabs, vMix or Larix, run the show from the control room, and forward it to YouTube, Facebook and Twitch at once.</p>
        </div>
        {live && <Button asChild className="bg-red-600 hover:bg-red-700"><Link href={`/live-studio?id=${live.id}`}><Radio />You are live: open control room</Link></Button>}
      </div>

      <Card>
        <CardHeader>
          <ol className="flex flex-wrap gap-2" aria-label="Steps">
            {STEPS.map((label, i) => (
              <li key={label}>
                <button type="button" disabled={!current && i > 0} onClick={() => setStep(i)}
                  className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm", step === i ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground", !current && i > 0 && "opacity-50")}>
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">{i + 1}</span>{label}
                </button>
              </li>
            ))}
          </ol>
        </CardHeader>
        <CardContent>
          {step === 0 && (
            <form onSubmit={createStream} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2"><Label htmlFor="title">Title</Label><Input id="title" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What is this stream about?" /></div>
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                    <SelectTrigger aria-label="Category"><SelectValue /></SelectTrigger>
                    <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Privacy</Label>
                  <Select value={form.privacy} onValueChange={(v) => setForm({ ...form, privacy: v as Privacy })}>
                    <SelectTrigger aria-label="Privacy"><SelectValue /></SelectTrigger>
                    <SelectContent>{["Public", "Unlisted", "Private"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 md:col-span-2"><Label htmlFor="desc">Description</Label><Textarea id="desc" maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                <div className="space-y-2"><Label htmlFor="thumb">Thumbnail</Label><Input id="thumb" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setThumb(e.target.files?.[0] ?? null)} /></div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.checked })} />Schedule for later</label>
                  {form.schedule && <Input type="datetime-local" aria-label="Start time" required value={form.scheduled_for} onChange={(e) => setForm({ ...form, scheduled_for: e.target.value })} />}
                </div>
              </div>
              {error && <ErrorBox message={error} />}
              <Button disabled={busy}>{busy && <Loader2 className="animate-spin" />}{current ? "Save and continue" : "Continue"}</Button>
            </form>
          )}
          {step === 1 && current && (
            <div className="space-y-4">
              <CardDescription>Optional: the same stream goes to these services too. One failing never stops the others.</CardDescription>
              <DestinationsEditor streamId={current.id} />
              <Button onClick={() => setStep(2)}>Continue</Button>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <EncoderStep />
              <Button onClick={() => setStep(3)}>Continue</Button>
            </div>
          )}
          {step === 3 && fresh && (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              {fresh.status === "Live" ? (
                <>
                  <Badge className="bg-red-600 px-4 py-1 text-base text-white">LIVE</Badge>
                  <p className="text-sm text-muted-foreground">“{fresh.title}” is on air.</p>
                  <Button size="lg" onClick={() => router.push(`/live-studio?id=${fresh.id}`)}><Clapperboard />Open control room</Button>
                </>
              ) : fresh.armed ? (
                <>
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                  <p className="text-lg font-medium">Waiting for OBS…</p>
                  <p className="max-w-md text-sm text-muted-foreground">Press <b>Start Streaming</b> in your encoder. This page turns LIVE as soon as it connects.</p>
                </>
              ) : (
                <>
                  {fresh.scheduled_for && new Date(fresh.scheduled_for).getTime() > Date.now() && (
                    <p className="flex items-center gap-2 text-sm"><CalendarClock className="h-4 w-4" />Scheduled for {when(fresh.scheduled_for)} · starts in <Countdown to={fresh.scheduled_for} /></p>
                  )}
                  <Button size="lg" className="h-14 bg-red-600 px-10 text-lg hover:bg-red-700" onClick={goLive} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Radio />}GO LIVE</Button>
                  <p className="text-xs text-muted-foreground">You can also just start your encoder: the stream goes live when it connects.</p>
                </>
              )}
              {error && <ErrorBox message={error} />}
            </div>
          )}
        </CardContent>
      </Card>

      {upcoming.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Upcoming</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {upcoming.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-3 text-sm">
                  <span className="flex-1 font-medium">{s.title}</span>
                  {s.scheduled_for && <span className="text-muted-foreground">{when(s.scheduled_for)} · in <Countdown to={s.scheduled_for} /></span>}
                  <Button size="sm" variant="outline" onClick={() => { setCurrent(s); setStep(3); }}>Open</Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Past streams</CardTitle><CardDescription>Each stream is saved as a video when it ends.</CardDescription></CardHeader>
        <CardContent>
          {streams.loading && !streams.data ? <RowsSkeleton /> : !past.length ? <Empty title="No streams yet" /> : (
            <ul className="divide-y">
              {past.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 text-sm">
                  <span className="min-w-[200px] flex-1 font-medium">{s.title}</span>
                  <span className="text-muted-foreground">{s.started_at ? when(s.started_at) : "—"}</span>
                  <span>{s.vod?.duration ? formatDuration(s.vod.duration) : "—"}</span>
                  <span>{s.vod?.views ?? 0} views</span>
                  <span>peak {s.viewer_peak} viewers</span>
                  {s.vod ? <Link className="text-primary hover:underline" href={`/watch/${s.vod.id}`}>{s.vod.status === "Published" || s.vod.status === "Ready" ? "Watch" : s.vod.status}</Link> : <span className="text-muted-foreground">No recording</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
