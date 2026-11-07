"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DisputeBadge, Empty, ErrorBox, RowsSkeleton, Thumb, timeLeft, when } from "@/components/shared";
import { api, type Dispute, type LogEntry, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useData } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const ACTIONS: Record<string, string> = {
  opened: "opened the dispute",
  creator_released: "released the claim",
  creator_upheld: "upheld the claim",
  admin_approved: "approved the dispute",
  admin_rejected: "rejected the dispute",
};

function needsMe(d: Dispute, user: User) {
  if (d.status !== "Pending") return false;
  if (user.role === "admin") return true;
  return d.reference_owner === user.username && !d.creator_action;
}

function ActionForm({ label, hint, actions, onSubmit }: {
  label: string; hint: string;
  actions: { value: string; text: string; variant: "default" | "destructive" | "outline" }[];
  onSubmit: (action: string, text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(action: string) {
    setBusy(action); setError(null);
    try { await onSubmit(action, text.trim()); setText(""); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <Label htmlFor="action-text">{label}</Label>
      <Textarea id="action-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={hint} maxLength={4000} />
      {error && <ErrorBox message={error} />}
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button key={a.value} variant={a.variant} disabled={!!busy || text.trim().length < 3} onClick={() => go(a.value)}>
            {busy === a.value && <Loader2 className="animate-spin" />}{a.text}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Detail({ id, user, onChanged }: { id: number; user: User; onChanged: () => void }) {
  const d = useData(() => api<Dispute>(`/api/disputes/${id}`), [id]);
  const log = useData(() => api<LogEntry[]>(`/api/disputes/${id}/log`), [id]);

  async function after() { await Promise.all([d.refresh(), log.refresh()]); onChanged(); }

  if (d.loading && !d.data) return <RowsSkeleton rows={2} />;
  if (d.error || !d.data) return <ErrorBox message={d.error ?? "Not found."} onRetry={d.refresh} />;
  const x = d.data;
  const isOwner = x.reference_owner === user.username;

  return (
    <div className="space-y-5">
      <div className="flex gap-4">
        <Thumb url={x.upload_thumbnail_url} className="w-36" />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">Dispute #{x.id}</span><DisputeBadge status={x.status} /></div>
          <p className="text-sm">
            <span className="font-medium">@{x.uploader}</span>’s “{x.upload_title || `upload #${x.upload_id}`}” matched “{x.reference_title}” by <span className="font-medium">@{x.reference_owner}</span> ({Math.round(x.combined_score)}%).
          </p>
          {x.status === "Pending" && !x.creator_action && (
            <p className={cn("inline-flex items-center gap-1 text-xs", x.overdue ? "text-destructive" : "text-muted-foreground")}>
              <Clock className="h-3 w-3" />Owner response: {timeLeft(x.respond_by)} (by {when(x.respond_by)})
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3 text-sm">
        <div><div className="text-xs font-medium uppercase text-muted-foreground">Uploader’s reason</div><p className="whitespace-pre-wrap">{x.reason}</p></div>
        {x.creator_response && (
          <div>
            <div className="text-xs font-medium uppercase text-muted-foreground">Owner {x.creator_action === "release" ? "released the claim" : "upheld the claim"}</div>
            <p className="whitespace-pre-wrap">{x.creator_response}</p>
          </div>
        )}
        {x.admin_note && <div><div className="text-xs font-medium uppercase text-muted-foreground">Administrator’s note</div><p className="whitespace-pre-wrap">{x.admin_note}</p></div>}
      </div>

      {x.status === "Pending" && isOwner && !x.creator_action && (
        <ActionForm
          label="Your response"
          hint="Explain your decision to the uploader (at least 3 characters)."
          actions={[{ value: "release", text: "Release claim (allow the video)", variant: "outline" }, { value: "uphold", text: "Uphold claim", variant: "destructive" }]}
          onSubmit={async (action, response) => { await api(`/api/disputes/${x.id}/respond`, { method: "POST", json: { action, response } }); await after(); }}
        />
      )}
      {x.status === "Pending" && user.role === "admin" && (
        <ActionForm
          label="Administrator decision"
          hint="A note for both sides (at least 3 characters)."
          actions={[{ value: "approve", text: "Approve (post the video)", variant: "default" }, { value: "reject", text: "Reject (keep it blocked)", variant: "destructive" }]}
          onSubmit={async (action, note) => { await api(`/api/disputes/${x.id}/decide`, { method: "POST", json: { approve: action === "approve", admin_note: note } }); await after(); }}
        />
      )}

      <div>
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">History</div>
        {log.data ? (
          <ol className="relative space-y-3 border-l pl-4">
            {log.data.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border bg-background" />
                <span className="font-medium">{e.actor ? `@${e.actor}` : "System"}</span> {ACTIONS[e.action] ?? e.action}
                <span className="block text-xs text-muted-foreground">{when(e.created_at)}</span>
              </li>
            ))}
          </ol>
        ) : <RowsSkeleton rows={1} />}
      </div>
    </div>
  );
}

function DisputesInner() {
  const { user } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const selected = Number(params.get("id")) || null;
  const [tab, setTab] = useState("action");
  const list = useData(() => api<Dispute[]>("/api/disputes"), []);
  if (!user) return null;

  const rows = (list.data ?? []).filter((d) =>
    tab === "action" ? needsMe(d, user) : tab === "mine" ? d.uploader === user.username : tab === "against" ? d.reference_owner === user.username : true,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Disputes</h1>
        <p className="text-sm text-muted-foreground">Uploaders contest a claim, owners answer within 7 days, administrators decide. Every step is logged.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader className="space-y-3">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full">
                <TabsTrigger value="action">Needs action</TabsTrigger>
                <TabsTrigger value="against">On my videos</TabsTrigger>
                <TabsTrigger value="mine">Opened by me</TabsTrigger>
                {user.role === "admin" && <TabsTrigger value="all">All</TabsTrigger>}
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            {list.loading && !list.data ? <RowsSkeleton /> : list.error && !list.data ? <ErrorBox message={list.error} onRetry={list.refresh} /> : !rows.length ? (
              <Empty title="Nothing here" />
            ) : (
              <ul className="space-y-2">
                {rows.map((d) => (
                  <li key={d.id}>
                    <button
                      onClick={() => router.replace(`${path}?id=${d.id}`)}
                      className={cn("flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors hover:bg-muted/50", selected === d.id && "border-primary bg-primary/5")}
                    >
                      <Thumb url={d.upload_thumbnail_url} className="w-20" />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="truncate font-medium">{d.upload_title || `Upload #${d.upload_id}`}</div>
                        <div className="truncate text-xs text-muted-foreground">@{d.uploader} vs @{d.reference_owner}</div>
                        {d.status === "Pending" && !d.creator_action && <div className={cn("text-xs", d.overdue ? "text-destructive" : "text-muted-foreground")}>{timeLeft(d.respond_by)}</div>}
                        {d.status === "Pending" && d.creator_action === "uphold" && <div className="text-xs text-muted-foreground">Waiting for an administrator</div>}
                      </div>
                      <DisputeBadge status={d.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Details</CardTitle>{!selected && <CardDescription>Choose a dispute to see it.</CardDescription>}</CardHeader>
          <CardContent>{selected && <Detail id={selected} user={user} onChanged={list.refresh} />}</CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function DisputesPage() {
  return <Suspense fallback={<RowsSkeleton />}><DisputesInner /></Suspense>;
}
