"use client";

import { AlertCircle, Film, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { mediaUrl, type DisputeStatus, type MatchStatus, type Policy, type UploadStatus } from "@/lib/api";

export function Thumb({ url, className }: { url: string | null; className?: string }) {
  const src = mediaUrl(url);
  return (
    <div className={cn("relative aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-muted", className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground"><Film className="h-5 w-5" /></div>
      )}
    </div>
  );
}

const UPLOAD: Record<UploadStatus, "secondary" | "success" | "destructive" | "warning" | "outline"> = {
  Processing: "secondary", Approved: "success", Blocked: "destructive", Flagged: "warning", Failed: "outline",
};
export function UploadBadge({ status }: { status: UploadStatus }) {
  return (
    <Badge variant={UPLOAD[status]} className="gap-1">
      {status === "Processing" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
    </Badge>
  );
}

const MATCH: Record<MatchStatus, "destructive" | "info" | "warning" | "secondary" | "success" | "outline"> = {
  blocked: "destructive", muted: "info", flagged: "warning", tracked: "secondary", approved: "outline", released: "success",
};
export function MatchBadge({ status }: { status: MatchStatus }) {
  return <Badge variant={MATCH[status]} className="capitalize">{status}</Badge>;
}

const DISPUTE: Record<DisputeStatus, "warning" | "success" | "destructive"> = { Pending: "warning", Approved: "success", Rejected: "destructive" };
export function DisputeBadge({ status }: { status: DisputeStatus }) {
  return <Badge variant={DISPUTE[status]}>{status}</Badge>;
}

export const POLICY_HELP: Record<Policy, string> = {
  Block: "Matching uploads cannot be posted",
  Mute: "Matching uploads are posted without sound",
  Flag: "An administrator reviews matching uploads",
  Track: "Matching uploads are posted; you see them here",
};

export function PolicyBadge({ policy }: { policy: Policy }) {
  return <Badge variant="outline" title={POLICY_HELP[policy]}>{policy}</Badge>;
}

/** A score from 0 to 100 as a number and a bar coloured by the rule it falls under. */
export function Score({ label, value }: { label: string; value: number | null }) {
  const color = value === null ? "bg-muted" : value >= 85 ? "bg-red-500" : value >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="min-w-[88px]">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{value === null ? "—" : `${Math.round(value)}%`}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${value ?? 0}%` }} />
      </div>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="flex-1">{message}</div>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="aspect-video w-28" />
          <div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function timeLeft(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "deadline passed";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return d > 0 ? `${d}d ${h}h left` : `${h}h left`;
}
