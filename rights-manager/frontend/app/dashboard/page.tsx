"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2, Music, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { FileDrop, Progress } from "@/components/file-drop";
import { Empty, ErrorBox, POLICY_HELP, RowsSkeleton, Thumb, when } from "@/components/shared";
import { api, uploadWithProgress, type Match, type Policy, type Reference } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useData } from "@/lib/hooks";

const POLICIES: Policy[] = ["Block", "Mute", "Flag", "Track"];

function AddReference({ onAdded }: { onAdded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [policy, setPolicy] = useState<Policy>("Block");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setError("Choose a video first."); return; }
    const form = new FormData();
    form.append("file", file);
    form.append("title", title.trim() || file.name.replace(/\.[^.]+$/, ""));
    form.append("policy", policy);
    setError(null); setProgress(0);
    try {
      await uploadWithProgress<Reference>("/api/references", form, setProgress);
      setFile(null); setTitle("");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Protect a video</CardTitle>
        <CardDescription>Upload an original you own. It is fingerprinted (frames and sound) and every new upload is checked against it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <FileDrop file={file} onFile={setFile} onError={setError} disabled={progress !== null} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="title">Title</Label><Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? "My original video"} maxLength={200} /></div>
            <div className="space-y-2">
              <Label>When someone re-uploads it</Label>
              <Select value={policy} onValueChange={(v) => setPolicy(v as Policy)}>
                <SelectTrigger aria-label="Policy"><SelectValue /></SelectTrigger>
                <SelectContent>{POLICIES.map((p) => <SelectItem key={p} value={p}>{p} — {POLICY_HELP[p]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {progress !== null && <Progress value={progress} />}
          {error && <ErrorBox message={error} />}
          <Button disabled={progress !== null || !file}>{progress !== null && <Loader2 className="animate-spin" />}Protect video</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ReferenceRow({ r, onChange }: { r: Reference; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
      <Thumb url={r.thumbnail_url} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{r.title}</span>
          {r.status === "processing" && <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />Fingerprinting</Badge>}
          {r.status === "ready" && <Badge variant="success">Protected</Badge>}
          {r.status === "failed" && <Badge variant="destructive">Failed</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {r.duration !== null && <span>{Math.round(r.duration)} s</span>}
          {r.status === "ready" && <span>{r.frames} frame prints</span>}
          {r.status === "ready" && <span className="inline-flex items-center gap-1"><Music className="h-3 w-3" />{r.has_audio ? "sound print" : "no sound"}</span>}
          {r.file_hash_sha256 && <span title={r.file_hash_sha256} className="font-mono">SHA-256 {r.file_hash_sha256.slice(0, 10)}…</span>}
          <span>{when(r.created_at)}</span>
        </div>
        {r.error && <p className="mt-1 text-xs text-destructive">{r.error}</p>}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex items-center gap-2">
        <Select value={r.policy} disabled={busy} onValueChange={(v) => act(() => api(`/api/references/${r.id}`, { method: "PATCH", json: { policy: v } }))}>
          <SelectTrigger className="w-28" aria-label={`Policy for ${r.title}`}><SelectValue /></SelectTrigger>
          <SelectContent>{POLICIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
        </Select>
        <Button
          variant="ghost" size="icon" disabled={busy} aria-label={`Delete ${r.title}`}
          onClick={() => { if (confirm(`Stop protecting "${r.title}"? Its fingerprints are deleted.`)) void act(() => api(`/api/references/${r.id}`, { method: "DELETE" })); }}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const refs = useData(() => api<Reference[]>("/api/references"), [], { every: 2000, poll: (d) => d.some((r) => r.status === "processing") });
  const matches = useData(() => api<Match[]>("/api/matches"), []);
  const count = (s: string) => matches.data?.filter((m) => m.status === s).length ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your protected originals and what happened to copies of them.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ["Protected videos", refs.data?.filter((r) => r.status === "ready").length ?? 0, "/dashboard"],
          ["Blocked copies", count("blocked"), "/matches?status=blocked"],
          ["Muted copies", count("muted"), "/matches?status=muted"],
          ["Waiting for review", count("flagged"), "/matches?status=flagged"],
        ].map(([label, n, href]) => (
          <Link key={label as string} href={href as string}>
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="p-5">
                <div className="text-3xl font-semibold tabular-nums">{matches.loading || refs.loading ? "–" : n}</div>
                <div className="text-sm text-muted-foreground">{label}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <AddReference onAdded={refs.refresh} />

      <Card>
        <CardHeader>
          <CardTitle>{user?.role === "admin" ? "All protected videos" : "Your protected videos"}</CardTitle>
          <CardDescription>Change a policy at any time; it applies to uploads checked from then on.</CardDescription>
        </CardHeader>
        <CardContent>
          {refs.loading && !refs.data ? <RowsSkeleton /> : refs.error && !refs.data ? <ErrorBox message={refs.error} onRetry={refs.refresh} /> : !refs.data?.length ? (
            <Empty title="No protected videos yet">Upload an original above to start finding copies.</Empty>
          ) : (
            <ul className="divide-y">{refs.data.map((r) => <ReferenceRow key={r.id} r={r} onChange={refs.refresh} />)}</ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
