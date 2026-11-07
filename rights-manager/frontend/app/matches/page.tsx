"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Check, Loader2, Search, Stamp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Empty, ErrorBox, MatchBadge, PolicyBadge, RowsSkeleton, Score, Thumb, when } from "@/components/shared";
import { api, type Match } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useData } from "@/lib/hooks";

const STATUSES = ["all", "blocked", "muted", "flagged", "tracked", "approved", "released"] as const;

function ReviewQueue() {
  const queue = useData(() => api<Match[]>("/api/matches/review"), []);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(m: Match, action: "approve" | "block") {
    setBusy(m.id); setError(null);
    try {
      await api(`/api/matches/${m.id}/review`, { method: "POST", json: { action } });
      await queue.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle>Review queue</CardTitle>
        <CardDescription>Uploads scoring 70–84%, or matching an original with the Flag policy. Approve to post, block to stop.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <ErrorBox message={error} />}
        {queue.loading && !queue.data ? <RowsSkeleton rows={2} /> : queue.error && !queue.data ? <ErrorBox message={queue.error} onRetry={queue.refresh} /> : !queue.data?.length ? (
          <p className="text-sm text-muted-foreground">Nothing waiting for review.</p>
        ) : (
          <ul className="divide-y">
            {queue.data.map((m) => (
              <li key={m.id} className="flex flex-col gap-3 py-3 md:flex-row md:items-center">
                <div className="flex gap-2"><Thumb url={m.upload_thumbnail_url} /><Thumb url={m.reference_thumbnail_url} /></div>
                <div className="min-w-0 flex-1 text-sm">
                  <div><span className="font-medium">@{m.uploader}</span> uploaded “{m.upload_title || `#${m.upload_id}`}”</div>
                  <div className="text-muted-foreground">looks like “{m.reference_title}” by @{m.reference_owner}</div>
                </div>
                <div className="flex gap-3"><Score label="Video" value={m.video_score} /><Score label="Audio" value={m.audio_score} /><Score label="Combined" value={m.combined_score} /></div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy === m.id} onClick={() => decide(m, "approve")}>{busy === m.id ? <Loader2 className="animate-spin" /> : <Check />}Approve</Button>
                  <Button size="sm" variant="destructive" disabled={busy === m.id} onClick={() => decide(m, "block")}><X />Block</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MatchesInner() {
  const { user } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const status = params.get("status") ?? "all";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== "all") next.set(key, value); else next.delete(key);
    router.replace(`${path}${next.toString() ? `?${next}` : ""}`);
  }

  // Search as you type, without a request per key press.
  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) setParam("q", search.trim()); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = new URLSearchParams();
  if (status !== "all") query.set("status", status);
  if (q) query.set("q", q);
  const matches = useData(() => api<Match[]>(`/api/matches${query.toString() ? `?${query}` : ""}`), [status, q]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Matches</h1>
        <p className="text-sm text-muted-foreground">
          {user?.role === "admin" ? "Every upload that matched a protected video." : "Uploads by other people that matched your protected videos."}
        </p>
      </div>

      {user?.role === "admin" && <ReviewQueue />}

      <Card>
        <CardHeader className="gap-4 md:flex-row md:items-end md:justify-between md:space-y-0">
          <div className="space-y-1.5"><CardTitle>All matches</CardTitle><CardDescription>Combined score = video × 0.6 + audio × 0.4. 85%+ applies your policy, 70–84% goes to review.</CardDescription></div>
          <div className="flex gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input className="w-48 pl-9" placeholder="Search username" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search by uploader username" />
            </div>
            <Select value={status} onValueChange={(v) => setParam("status", v)}>
              <SelectTrigger className="w-36 capitalize" aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s === "all" ? "All statuses" : s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {matches.loading && !matches.data ? <RowsSkeleton /> : matches.error && !matches.data ? <ErrorBox message={matches.error} onRetry={matches.refresh} /> : !matches.data?.length ? (
            <Empty title={q || status !== "all" ? "No matches for this filter" : "No matches yet"}>
              {q || status !== "all" ? "Try another status or username." : "When someone uploads a copy of a protected video, it appears here."}
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Upload</TableHead>
                  <TableHead>Uploader</TableHead>
                  <TableHead>Original</TableHead>
                  <TableHead>Scores</TableHead>
                  <TableHead>Policy</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.data.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Thumb url={m.upload_thumbnail_url} className="w-24" />
                        <div className="min-w-0">
                          <div className="max-w-[180px] truncate font-medium">{m.upload_title || `Upload #${m.upload_id}`}</div>
                          <div className="text-xs text-muted-foreground">{when(m.created_at)}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">@{m.uploader}</TableCell>
                    <TableCell>
                      <div className="max-w-[160px] truncate">{m.reference_title}</div>
                      {user?.role === "admin" && <div className="text-xs text-muted-foreground">by @{m.reference_owner}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-3">
                        <Score label="Video" value={m.video_score} />
                        <Score label="Audio" value={m.audio_score} />
                        <Score label="Combined" value={m.combined_score} />
                      </div>
                      <div className="mt-1 flex gap-1">
                        {m.exact && <Badge variant="destructive">Exact file</Badge>}
                        {m.has_watermark && <Badge variant="outline" className="gap-1"><Stamp className="h-3 w-3" />Watermark +10</Badge>}
                      </div>
                    </TableCell>
                    <TableCell><PolicyBadge policy={m.policy} /></TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <MatchBadge status={m.status} />
                        {m.dispute_id && <Link className="text-xs text-primary hover:underline" href={`/disputes?id=${m.dispute_id}`}>Disputed →</Link>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function MatchesPage() {
  return <Suspense fallback={<RowsSkeleton />}><MatchesInner /></Suspense>;
}
