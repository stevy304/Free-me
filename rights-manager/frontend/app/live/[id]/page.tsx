"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Heart, Pin, Radio, Users } from "lucide-react";
import { HlsPlayer } from "@/components/hls-player";
import { Button } from "@/components/ui/button";
import { api, tokenStore } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useData } from "@/lib/hooks";
import type { ChatMessage, LiveStream } from "@/lib/live";

function viewerId() {
  try {
    let v = localStorage.getItem("viewer_id");
    if (!v) { v = crypto.randomUUID(); localStorage.setItem("viewer_id", v); }
    return v;
  } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

/** The public live page: player, viewers, likes and chat. */
export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const stream = useData(() => api<LiveStream>(`/api/live/${id}`), [id], { every: 5000, poll: () => true });
  const [viewers, setViewers] = useState(0);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [pinned, setPinned] = useState<ChatMessage | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vid = viewerId();
    const beat = () => api<{ viewers: number }>(`/api/live/${id}/heartbeat`, { method: "POST", json: { viewer_id: vid } }).then((r) => setViewers(r.viewers)).catch(() => undefined);
    void beat();
    const t = setInterval(beat, 15000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api<{ messages: ChatMessage[]; pinned: ChatMessage | null }>(`/api/live/${id}/chat?after=${last.current}`);
        if (!alive) return;
        setPinned(r.pinned);
        if (r.messages.length) {
          last.current = r.messages[r.messages.length - 1].id;
          setMsgs((m) => [...m, ...r.messages].slice(-200));
          requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight }));
        }
      } catch { /* retry */ }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    try { await api(`/api/live/${id}/chat`, { method: "POST", json: { text } }); setText(""); setNote(null); } catch (err) { setNote((err as Error).message); }
  }

  const s = stream.data;
  if (stream.error && !s) return <main className="flex min-h-screen items-center justify-center text-muted-foreground">{stream.error}</main>;
  if (!s) return <main className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</main>;

  return (
    <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="space-y-3">
        <div className="aspect-video overflow-hidden rounded-lg bg-black">
          {s.status === "Live" ? <HlsPlayer src={s.hls_url} live className="h-full w-full" /> : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-300">
              {s.status === "Ended" ? (s.vod_video_id ? <Link className="text-sky-400 underline" href={`/watch/${s.vod_video_id}`}>The stream has ended. Watch the recording.</Link> : "The stream has ended.") : "The stream has not started yet."}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{s.title}</h1>
            <p className="text-sm text-muted-foreground">@{s.creator} · {s.category}</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {s.status === "Live" && <span className="flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white"><Radio className="h-3 w-3" />LIVE</span>}
            <span className="flex items-center gap-1"><Users className="h-4 w-4" />{viewers} watching</span>
            <Button size="sm" variant="outline" disabled={!user} onClick={() => api<{ likes: number }>(`/api/live/${id}/like`, { method: "POST" }).then(() => stream.refresh())}><Heart className="h-4 w-4" />{s.likes}</Button>
          </div>
        </div>
        {s.description && <p className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm">{s.description}</p>}
      </section>
      <aside className="flex h-[70vh] flex-col rounded-lg border">
        <div className="border-b px-3 py-2 text-sm font-semibold">Live chat{s.slow_mode_seconds ? <span className="ml-2 text-xs font-normal text-muted-foreground">Slow mode {s.slow_mode_seconds}s</span> : null}</div>
        {pinned && <div className="border-b bg-sky-50 px-3 py-2 text-xs dark:bg-sky-950"><Pin className="mr-1 inline h-3 w-3" /><b>{pinned.username}</b> {pinned.text}</div>}
        <div ref={box} className="flex-1 space-y-1 overflow-y-auto p-3 text-sm">
          {msgs.map((m) => <div key={m.id} className={m.kind === "superchat" ? "rounded bg-amber-100 px-1 dark:bg-amber-900/40" : ""}><b className={m.user_id === s.creator_id ? "text-red-600" : ""}>{m.username}</b> {m.amount_cents ? <b>${(m.amount_cents / 100).toFixed(2)} </b> : null}{m.text}</div>)}
        </div>
        {user && tokenStore.get() ? (
          <form onSubmit={send} className="flex gap-2 border-t p-2">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Chat…" aria-label="Chat message" className="min-w-0 flex-1 rounded border px-2 py-1.5 text-sm" />
            <Button size="sm">Send</Button>
          </form>
        ) : <p className="border-t p-3 text-center text-sm"><Link className="text-primary underline" href="/login">Sign in</Link> to chat.</p>}
        {note && <p className="px-3 pb-2 text-xs text-destructive">{note}</p>}
      </aside>
    </main>
  );
}
