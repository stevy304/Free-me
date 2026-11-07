"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2, Stamp, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DisputeDialog } from "@/components/dispute-dialog";
import { FileDrop, Progress } from "@/components/file-drop";
import { Empty, ErrorBox, RowsSkeleton, Thumb, UploadBadge, when } from "@/components/shared";
import { api, uploadWithProgress, type Upload } from "@/lib/api";
import { useData } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function Result({ u, onChange }: { u: Upload; onChange: () => void }) {
  const tone = u.status === "Blocked" ? "border-destructive/40 bg-destructive/5" : u.status === "Flagged" ? "border-amber-500/40 bg-amber-500/5" : "";
  return (
    <li className={cn("flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center", tone)}>
      <Thumb url={u.thumbnail_url} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{u.title || `Upload #${u.id}`}</span>
          <UploadBadge status={u.status} />
          {u.audio_removed && <Badge variant="info" className="gap-1"><VolumeX className="h-3 w-3" />Muted</Badge>}
          {u.has_watermark && <Badge variant="outline" className="gap-1"><Stamp className="h-3 w-3" />{u.watermark_text} watermark</Badge>}
        </div>
        {u.status === "Processing" && <p className="text-sm text-muted-foreground">Checking frames and sound against protected videos…</p>}
        {u.status === "Approved" && !u.message && <p className="text-sm text-muted-foreground">Posted. No protected content found.</p>}
        {u.message && <p className={cn("text-sm", u.status === "Blocked" && "font-medium text-destructive")}>{u.message}</p>}
        <p className="text-xs text-muted-foreground">{when(u.created_at)}</p>
      </div>
      <div className="flex gap-2">
        {u.can_dispute && u.match_id && <DisputeDialog matchId={u.match_id} title={u.title || `Upload #${u.id}`} onDone={onChange} />}
        {u.dispute_id && <Button asChild size="sm" variant="ghost"><Link href={`/disputes?id=${u.dispute_id}`}>View dispute</Link></Button>}
      </div>
    </li>
  );
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // While any upload is being checked, ask again every 2 seconds; the API never blocks on the check.
  const uploads = useData(() => api<Upload[]>("/api/uploads"), [], { every: 2000, poll: (d) => d.some((u) => u.status === "Processing") });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setError("Choose a video first."); return; }
    const form = new FormData();
    form.append("file", file);
    if (title.trim()) form.append("title", title.trim());
    setError(null); setProgress(0);
    try {
      const u = await uploadWithProgress<Upload>("/api/uploads", form, setProgress);
      uploads.setData((prev) => [u, ...(prev ?? [])]);
      setFile(null); setTitle("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload</h1>
        <p className="text-sm text-muted-foreground">Every video is checked against protected originals before it is posted.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Post a video</CardTitle>
          <CardDescription>You can keep using the page while it is checked.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <FileDrop file={file} onFile={setFile} onError={setError} disabled={progress !== null} />
            <div className="space-y-2"><Label htmlFor="title">Title</Label><Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? "My video"} maxLength={200} /></div>
            {progress !== null && <Progress value={progress} />}
            {error && <ErrorBox message={error} />}
            <Button disabled={progress !== null || !file}>{progress !== null && <Loader2 className="animate-spin" />}Upload and check</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Your uploads</CardTitle></CardHeader>
        <CardContent>
          {uploads.loading && !uploads.data ? <RowsSkeleton /> : uploads.error && !uploads.data ? <ErrorBox message={uploads.error} onRetry={uploads.refresh} /> : !uploads.data?.length ? (
            <Empty title="No uploads yet" />
          ) : (
            <ul className="space-y-3">{uploads.data.map((u) => <Result key={u.id} u={u} onChange={uploads.refresh} />)}</ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
