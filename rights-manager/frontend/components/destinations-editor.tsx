"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorBox } from "@/components/shared";
import { api } from "@/lib/api";
import { useData } from "@/lib/hooks";
import type { Destination } from "@/lib/live";

const PLATFORMS = [
  { id: "YouTube", url: "rtmp://a.rtmp.youtube.com/live2", hint: "YouTube Studio > Go live > Stream key" },
  { id: "Facebook", url: "rtmps://live-api-s.facebook.com:443/rtmp", hint: "Facebook Live Producer > Streaming software" },
  { id: "Twitch", url: "rtmp://live.twitch.tv/app", hint: "Twitch Creator Dashboard > Settings > Stream" },
  { id: "Custom_RTMP", url: "", hint: "Any RTMP/RTMPS server" },
];

export function StatusBadge({ status }: { status: string }) {
  const v = status === "Connected" ? "success" : status === "Error" ? "destructive" : "secondary";
  return <Badge variant={v as "success" | "destructive" | "secondary"}>{status}</Badge>;
}

/** Add YouTube / Facebook / Twitch / any RTMP server; the live program is copied to each enabled one. */
export function DestinationsEditor({ streamId, poll }: { streamId: number; poll?: boolean }) {
  const list = useData(() => api<Destination[]>(`/api/live/${streamId}/destinations`), [streamId], { every: 3000, poll: () => !!poll });
  const [platform, setPlatform] = useState("YouTube");
  const [url, setUrl] = useState(PLATFORMS[0].url);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = PLATFORMS.find((p) => p.id === platform)!;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/api/live/${streamId}/destinations`, { method: "POST", json: { platform, rtmp_url: url, stream_key: key } });
      setKey("");
      await list.refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function act(fn: () => Promise<unknown>) {
    try { await fn(); await list.refresh(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="space-y-4">
      {list.data?.length ? (
        <ul className="divide-y rounded-lg border">
          {list.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <span className="w-24 font-medium">{d.platform.replace("_", " ")}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{d.rtmp_url} · {d.stream_key_masked}</span>
              <StatusBadge status={d.status} />
              {d.error && <span className="w-full text-xs text-destructive">{d.error}</span>}
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={d.is_enabled} onChange={(e) => act(() => api(`/api/destinations/${d.id}`, { method: "PATCH", json: { is_enabled: e.target.checked } }))} /> On
              </label>
              <Button size="icon" variant="ghost" aria-label={`Remove ${d.platform}`} onClick={() => act(() => api(`/api/destinations/${d.id}`, { method: "DELETE" }))}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">No destinations yet: the stream plays here only.</p>}
      <form onSubmit={add} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[150px_1fr_1fr_auto] md:items-end">
        <div className="space-y-1.5">
          <Label>Platform</Label>
          <Select value={platform} onValueChange={(v) => { setPlatform(v); setUrl(PLATFORMS.find((p) => p.id === v)!.url); }}>
            <SelectTrigger aria-label="Platform"><SelectValue /></SelectTrigger>
            <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p.id} value={p.id}>{p.id.replace("_", " ")}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5"><Label htmlFor="dest-url">Server URL</Label><Input id="dest-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtmp://…" required /></div>
        <div className="space-y-1.5"><Label htmlFor="dest-key">Stream key</Label><Input id="dest-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={meta.hint} /></div>
        <Button disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Plus />}Add</Button>
      </form>
      {error && <ErrorBox message={error} />}
    </div>
  );
}
