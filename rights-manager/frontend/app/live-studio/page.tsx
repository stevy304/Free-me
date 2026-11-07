"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Ban, Bell, Camera, CameraOff, Circle, Clock, Cpu, Eye, Heart, Link2, Loader2, MessageSquare, Mic, MicOff, Monitor,
  Music, Pin, Plus, Radio, Settings, Share2, Shield, Square, Trash2, UserPlus, Users, Volume2, VolumeX, X,
} from "lucide-react";
import { RequireAuth } from "@/components/app-shell";
import { DestinationsEditor, StatusBadge } from "@/components/destinations-editor";
import { HlsPlayer } from "@/components/hls-player";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { API_URL, api, tokenStore, uploadWithProgress } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CATEGORIES, SOURCE_LABEL, formatDuration, startIngest, studioApi, type ChatMessage, type Studio } from "@/lib/live";
import { cn } from "@/lib/utils";

const panel = "rounded-lg border border-zinc-800 bg-zinc-900/70";
const h3 = "mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400";

function useStudio(id: number) {
  const [data, setData] = useState<Studio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api<Studio>(`/api/live/${id}/studio`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); const t = setInterval(load, 1000); return () => clearInterval(t); }, [load]);
  return { data, error, refresh: load };
}

function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!since) return <span className="font-mono">0:00</span>;
  return <span className="font-mono tabular-nums">{formatDuration((now - new Date(since).getTime()) / 1000)}</span>;
}

/** Snapshot of one input, refreshed every 2 s (with the session token, since snapshots are private). */
function Snapshot({ url }: { url: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) { setSrc(null); return; }
    let alive = true;
    let last: string | null = null;
    const load = async () => {
      try {
        const r = await fetch(`${API_URL}${url}`, { headers: { Authorization: `Bearer ${tokenStore.get()}` }, cache: "no-store" });
        if (!r.ok) return;
        const next = URL.createObjectURL(await r.blob());
        if (alive) { setSrc(next); if (last) URL.revokeObjectURL(last); last = next; }
      } catch { /* next tick */ }
    };
    void load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); if (last) URL.revokeObjectURL(last); };
  }, [url]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-zinc-500">No signal</div>;
}

function Meter({ db }: { db: number }) {
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="relative h-28 w-2 overflow-hidden rounded-sm bg-zinc-800" aria-label={`Level ${Math.round(db)} dB`}>
      <div className="absolute bottom-0 w-full bg-gradient-to-t from-emerald-500 via-yellow-400 to-red-500 transition-[height] duration-100" style={{ height: `${pct}%` }} />
    </div>
  );
}

function Fader({ id, label, level, value, muted, onChange, onMute, locked }: {
  id: string; label: string; level: number; value: number; muted: boolean; locked?: boolean;
  onChange: (v: number) => void; onMute: (m: boolean) => void;
}) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]);
  return (
    <div className={cn("flex w-[84px] shrink-0 flex-col items-center gap-1.5 rounded-md border border-zinc-800 p-2", id === "master" && "border-zinc-600 bg-zinc-800/50")}>
      <div className="w-full truncate text-center text-[11px] font-medium text-zinc-300" title={label}>{label}</div>
      <div className="flex items-end gap-2">
        <Meter db={muted ? -90 : level} />
        <input
          type="range" min={0} max={150} value={Math.round(local * 100)} aria-label={`${label} volume`}
          className="h-28 w-4 cursor-pointer accent-sky-500 [writing-mode:vertical-lr] [direction:rtl]"
          onPointerDown={() => { dragging.current = true; }}
          onChange={(e) => setLocal(Number(e.target.value) / 100)}
          onPointerUp={() => { dragging.current = false; onChange(local); }}
          onKeyUp={() => onChange(local)}
        />
      </div>
      <div className="font-mono text-[10px] text-zinc-400">{Math.round(local * 100)}% · {muted || level <= -89 ? "-∞" : Math.round(level)} dB</div>
      <button type="button" disabled={locked} onClick={() => onMute(!muted)} aria-label={`${muted ? "Unmute" : "Mute"} ${label}`}
        className={cn("flex w-full items-center justify-center gap-1 rounded py-1 text-[11px] font-semibold", muted ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700", locked && "opacity-60")}>
        {muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}{muted ? "MUTED" : "Mute"}
      </button>
    </div>
  );
}

function Chat({ streamId, hostId }: { streamId: number; hostId: number }) {
  const { user } = useAuth();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [pinned, setPinned] = useState<ChatMessage | null>(null);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const last = useRef(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api<{ messages: ChatMessage[]; pinned: ChatMessage | null }>(`/api/live/${streamId}/chat?after=${last.current}`);
        if (!alive) return;
        setPinned(r.pinned);
        if (r.messages.length) {
          last.current = r.messages[r.messages.length - 1].id;
          setMsgs((m) => [...m, ...r.messages].slice(-300));
          requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight }));
        }
      } catch { /* retry */ }
    };
    void load();
    const t = setInterval(load, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [streamId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try { await api(`/api/live/${streamId}/chat`, { method: "POST", json: { text } }); setText(""); setError(null); } catch (err) { setError((err as Error).message); }
  }
  async function act(fn: () => Promise<unknown>, hide?: number) {
    try { await fn(); if (hide) setMsgs((m) => m.filter((x) => x.id !== hide && x.user_id !== hide)); } catch (err) { setError((err as Error).message); }
  }
  const shown = filter ? msgs.filter((m) => `${m.username} ${m.text}`.toLowerCase().includes(filter.toLowerCase())) : msgs;

  return (
    <div className={cn(panel, "flex min-h-0 flex-1 flex-col p-3")}>
      <div className="mb-2 flex items-center justify-between"><div className={h3 + " mb-0"}>Live chat</div><MessageSquare className="h-3.5 w-3.5 text-zinc-500" /></div>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter messages" aria-label="Filter chat"
        className="mb-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600" />
      {pinned && <div className="mb-2 rounded bg-sky-950/60 p-2 text-xs text-sky-100"><Pin className="mr-1 inline h-3 w-3" /><b>{pinned.username}</b> {pinned.text}</div>}
      <div ref={box} className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" aria-live="polite">
        {shown.map((m) => (
          <div key={m.id} className={cn("group rounded px-1.5 py-1 text-xs hover:bg-zinc-800/70", m.kind === "superchat" && "bg-amber-500/20")}>
            <span className={cn("font-semibold", m.user_id === hostId ? "text-red-400" : "text-sky-300")}>{m.username}</span>{" "}
            {m.amount_cents ? <b className="text-amber-300">${(m.amount_cents / 100).toFixed(2)} </b> : null}
            <span className="text-zinc-200">{m.text}</span>
            {m.user_id !== user?.id && m.user_id !== null && (
              <span className="ml-1 hidden gap-1 group-hover:inline-flex">
                <button className="text-zinc-400 hover:text-white" title="Pin" aria-label="Pin" onClick={() => act(() => api(`/api/live/${streamId}/chat/${m.id}/pin`, { method: "POST" }))}><Pin className="h-3 w-3" /></button>
                <button className="text-zinc-400 hover:text-white" title="Timeout 5 minutes" aria-label="Timeout" onClick={() => act(() => api(`/api/live/${streamId}/bans`, { method: "POST", json: { user_id: m.user_id, minutes: 5 } }))}><Clock className="h-3 w-3" /></button>
                <button className="text-zinc-400 hover:text-red-400" title="Ban from this chat" aria-label="Ban" onClick={() => act(() => api(`/api/live/${streamId}/bans`, { method: "POST", json: { user_id: m.user_id } }), m.user_id!)}><Ban className="h-3 w-3" /></button>
                <button className="text-zinc-400 hover:text-red-400" title="Delete" aria-label="Delete message" onClick={() => act(() => api(`/api/live/${streamId}/chat/${m.id}`, { method: "DELETE" }), m.id)}><Trash2 className="h-3 w-3" /></button>
              </span>
            )}
          </div>
        ))}
        {!shown.length && <p className="pt-6 text-center text-xs text-zinc-500">No messages yet.</p>}
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      <form onSubmit={send} className="mt-2 flex gap-1">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Say something…" aria-label="Chat message"
          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600" />
        <button className="rounded bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-500">Send</button>
      </form>
    </div>
  );
}

function ModTools({ studio, streamId, onSaved }: { studio: Studio; streamId: number; onSaved: () => void }) {
  const [words, setWords] = useState(studio.moderation.blocked_words.join(", "));
  async function save(patch: Record<string, unknown>) {
    await api(`/api/live/${streamId}/moderation`, { method: "POST", json: patch }).catch(() => undefined);
    onSaved();
  }
  return (
    <div className={cn(panel, "space-y-2 p-3 text-xs")}>
      <div className={h3 + " flex items-center gap-1"}><Shield className="h-3 w-3" />Moderation</div>
      <label className="flex items-center justify-between gap-2 text-zinc-300">Slow mode
        <select value={studio.moderation.slow_mode_seconds} onChange={(e) => save({ slow_mode_seconds: Number(e.target.value) })} aria-label="Slow mode"
          className="rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5">
          {[0, 5, 10, 30, 60, 120].map((s) => <option key={s} value={s}>{s ? `${s} s` : "Off"}</option>)}
        </select>
      </label>
      <label className="flex items-center justify-between text-zinc-300">Auto-moderate (links, caps, spam)
        <input type="checkbox" checked={studio.moderation.auto_moderate} onChange={(e) => save({ auto_moderate: e.target.checked })} aria-label="Auto-moderate" />
      </label>
      <div className="flex gap-1">
        <input value={words} onChange={(e) => setWords(e.target.value)} placeholder="Blocked words, comma separated" aria-label="Blocked words"
          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200 placeholder:text-zinc-600" />
        <button className="rounded bg-zinc-700 px-2 text-zinc-100 hover:bg-zinc-600" onClick={() => save({ blocked_words: words.split(",").map((w) => w.trim()).filter(Boolean) })}>Save</button>
      </div>
    </div>
  );
}

function Studio_({ id }: { id: number }) {
  const { user } = useAuth();
  const router = useRouter();
  const { data: s, error, refresh } = useStudio(id);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [guestLink, setGuestLink] = useState<string | null>(null);
  const [addScene, setAddScene] = useState(false);
  const [lt, setLt] = useState({ name: "", title: "" });
  const [title, setTitle] = useState("");
  const [muted, setMuted] = useState(true);
  const stopScreen = useRef<(() => void) | null>(null);
  const [screenOn, setScreenOn] = useState(false);
  const api_ = studioApi(id);

  useEffect(() => { if (s) { setTitle((t) => t || s.stream.title); setLt((v) => v.name || v.title ? v : { name: s.state.lower_third.name, title: s.state.lower_third.title }); } }, [s]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setNotice(null);
    try { await fn(); await refresh(); } catch (e) { setNotice((e as Error).message); } finally { setBusy(null); }
  }

  if (!s) return <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">{error ? error : <Loader2 className="animate-spin" />}</div>;
  const st = s.state;
  const live = s.stream.status === "Live";
  const programLabel = SOURCE_LABEL[st.program] ?? st.program;
  const sceneCard = st.scenes.find((x) => x.name === st.scene)?.card;
  const m = (ch: string) => st.mixer[ch] ?? { volume: 1, muted: false };
  const camOff = st.camera_off.includes(st.program);
  const take = (src: string) => run(`take-${src}`, () => api_.program(src, st.transition)).then(() => setPreview(null));

  async function shareScreen() {
    if (screenOn) { stopScreen.current?.(); stopScreen.current = null; setScreenOn(false); return; }
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      const { token } = await api<{ token: string }>(`/api/live/${id}/screen-token`, { method: "POST" });
      stopScreen.current = startIngest(media, token, (why) => { setScreenOn(false); setNotice(`Screen share stopped: ${why}`); });
      media.getVideoTracks()[0].addEventListener("ended", () => { stopScreen.current?.(); setScreenOn(false); });
      setScreenOn(true);
    } catch (e) { setNotice((e as Error).message); }
  }

  const tiles = s.sources.filter((x) => ["cam1", "cam2", "cam3", "screen", "guest"].includes(x.name) || (x.name === "cam4" && x.connected) || (x.name === "interview" && x.connected));

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <Link href="/go-live" className="text-sm text-zinc-400 hover:text-white">← Studio</Link>
        <span className={cn("rounded px-2 py-0.5 text-xs font-bold tracking-wider", s.on_air ? "animate-pulse bg-red-600 text-white" : s.waiting_for_encoder ? "bg-amber-500 text-black" : "bg-zinc-700 text-zinc-300")}>
          {s.on_air ? "ON AIR" : s.waiting_for_encoder ? "WAITING FOR OBS" : live ? "CONNECTING" : s.stream.status.toUpperCase()}
        </span>
        <span className="flex items-center gap-1 text-sm"><Radio className="h-4 w-4 text-red-500" /><Elapsed since={live ? s.stream.started_at : null} /></span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Stream title" maxLength={200}
          onBlur={() => title.trim() && title !== s.stream.title && run("title", () => api(`/api/live/${id}`, { method: "PATCH", json: { title } }))}
          className="min-w-[180px] flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-zinc-700 focus:border-sky-600 focus:outline-none" />
        <select value={s.stream.category ?? ""} aria-label="Category" onChange={(e) => run("cat", () => api(`/api/live/${id}`, { method: "PATCH", json: { category: e.target.value } }))}
          className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        <select value={s.stream.privacy} aria-label="Privacy" onChange={(e) => run("priv", () => api(`/api/live/${id}`, { method: "PATCH", json: { privacy: e.target.value } }))}
          className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs">{["Public", "Unlisted", "Private"].map((c) => <option key={c}>{c}</option>)}</select>
        <div className="flex items-center gap-4 text-xs text-zinc-300">
          <span className="flex items-center gap-1" title="Viewers"><Users className="h-3.5 w-3.5" />{s.dashboard.viewers}</span>
          <span title="Incoming bitrate">{s.health.bitrate_kbps ?? 0} kbps</span>
          <span title="Incoming frame rate">{s.health.fps ?? 0} fps</span>
          <span title="Incoming resolution">{s.health.resolution ?? "—"}</span>
        </div>
      </header>

      {notice && <div className="flex items-center justify-between bg-amber-500/15 px-4 py-1.5 text-sm text-amber-200"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="h-4 w-4" /></button></div>}
      {s.health.level === "warn" && <div className="bg-yellow-500/15 px-4 py-1.5 text-sm text-yellow-200"><AlertTriangle className="mr-1 inline h-4 w-4" />{s.health.label}: {s.health.label === "Connection poor" ? `incoming bitrate under 2,000 kbps for ${Math.round(s.health.low_bitrate_seconds ?? 0)} s. Lower your encoder bitrate or check the upload connection.` : "the server is struggling to keep up."}</div>}
      {s.health.reconnect_seconds_left != null && <div className="bg-red-600/20 px-4 py-1.5 text-sm text-red-200">Encoder disconnected. Waiting {s.health.reconnect_seconds_left} s for it to reconnect before the stream ends.</div>}
      {s.rights.flagged && (
        <div className="flex flex-wrap items-center gap-3 bg-red-950/70 px-4 py-1.5 text-sm text-red-100">
          <Shield className="h-4 w-4" />Copyright match: this stream looks like “{s.rights.last_check?.reference ?? "a protected video"}” ({Math.round(s.rights.score ?? 0)}%). It stays live; an administrator may mute its sound.
          {user?.role === "admin" && (
            <button className="rounded bg-red-600 px-2 py-0.5 text-xs font-semibold" onClick={() => run("amute", () => api(`/api/live/${id}/admin-mute`, { method: "POST", json: { muted: !s.rights.admin_muted } }))}>
              {s.rights.admin_muted ? "Unmute audio" : "Mute audio"}
            </button>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3 p-3 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
        {/* Left: scenes, transitions, sources */}
        <aside className="space-y-3">
          <section className={cn(panel, "p-3")}>
            <div className={h3}>Scenes</div>
            <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-1">
              {st.scenes.map((sc) => (
                <button key={sc.name} onClick={() => run(`scene-${sc.name}`, () => api_.scene(sc.name))}
                  className={cn("rounded px-2 py-1.5 text-left text-sm", st.scene === sc.name ? "bg-red-600 font-semibold text-white" : "bg-zinc-800 hover:bg-zinc-700")}>
                  {sc.name}{sc.mute?.length ? <MicOff className="ml-1 inline h-3 w-3 opacity-70" /> : null}
                </button>
              ))}
              <button onClick={() => setAddScene(true)} className="flex items-center gap-1 rounded border border-dashed border-zinc-700 px-2 py-1.5 text-sm text-zinc-400 hover:text-white"><Plus className="h-3.5 w-3.5" />Add new scene</button>
            </div>
          </section>
          <section className={cn(panel, "p-3")}>
            <div className={h3}>Transitions</div>
            <div className="grid grid-cols-3 gap-1">
              {(["cut", "fade", "stinger"] as const).map((t) => (
                <button key={t} onClick={() => run(`tr-${t}`, () => api(`/api/live/${id}/studio/transition`, { method: "POST", json: { transition: t } }))}
                  className={cn("rounded py-1 text-xs capitalize", st.transition === t ? "bg-sky-600 text-white" : "bg-zinc-800 hover:bg-zinc-700")}>{t}</button>
              ))}
            </div>
          </section>
          <section className={cn(panel, "space-y-1.5 p-3 text-sm")}>
            <div className={h3}>Sources</div>
            <button className="flex w-full items-center justify-between rounded px-1 py-1 hover:bg-zinc-800" onClick={() => run("camoff", () => api_.overlay({ camera_off: camOff ? st.camera_off.filter((c) => c !== st.program) : [...st.camera_off, st.program] }))}>
              <span className="flex items-center gap-2">{camOff ? <CameraOff className="h-4 w-4 text-red-400" /> : <Camera className="h-4 w-4" />}Camera HD</span><span className="text-xs text-zinc-400">{camOff ? "Off" : "On"}</span>
            </button>
            <button className="flex w-full items-center justify-between rounded px-1 py-1 hover:bg-zinc-800" onClick={() => run("mic", () => api_.mixer("mic1", { muted: !m("mic1").muted }))}>
              <span className="flex items-center gap-2">{m("mic1").muted ? <MicOff className="h-4 w-4 text-red-400" /> : <Mic className="h-4 w-4" />}Mic</span><span className="text-xs text-zinc-400">{m("mic1").muted ? "Muted" : "On"}</span>
            </button>
            <button className="flex w-full items-center justify-between rounded px-1 py-1 hover:bg-zinc-800" onClick={shareScreen}>
              <span className="flex items-center gap-2"><Monitor className="h-4 w-4" />Screen Share</span><span className="text-xs text-zinc-400">{screenOn ? "Sharing" : "Start"}</span>
            </button>
            <button className="flex w-full items-center justify-between rounded px-1 py-1 hover:bg-zinc-800" onClick={() => run("chatbox", () => api_.overlay({ chat_box: !st.chat_box }))}>
              <span className="flex items-center gap-2"><MessageSquare className="h-4 w-4" />Overlay Chat Box</span><span className="text-xs text-zinc-400">{st.chat_box ? "On" : "Off"}</span>
            </button>
            <div className="space-y-1 rounded px-1 py-1">
              <button className="flex w-full items-center justify-between hover:text-white" onClick={() => run("lt", () => api_.overlay({ lower_third: { enabled: !st.lower_third.enabled, ...lt } }))}>
                <span className="flex items-center gap-2"><Square className="h-4 w-4" />Lower Third</span><span className="text-xs text-zinc-400">{st.lower_third.enabled ? "On" : "Off"}</span>
              </button>
              <input value={lt.name} onChange={(e) => setLt({ ...lt, name: e.target.value })} placeholder="Name" aria-label="Lower third name" maxLength={60} className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs" />
              <input value={lt.title} onChange={(e) => setLt({ ...lt, title: e.target.value })} placeholder="Title" aria-label="Lower third title" maxLength={60} className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs"
                onKeyDown={(e) => e.key === "Enter" && run("lt", () => api_.overlay({ lower_third: { enabled: true, ...lt } }))} />
            </div>
            <button className="flex w-full items-center justify-between rounded px-1 py-1 hover:bg-zinc-800" onClick={() => run("alerts", () => api_.overlay({ alerts: !st.alerts }))}>
              <span className="flex items-center gap-2"><Bell className="h-4 w-4" />Alerts</span><span className="text-xs text-zinc-400">{st.alerts ? "On" : "Off"}</span>
            </button>
            <button className="flex w-full items-center gap-2 rounded border border-dashed border-zinc-700 px-2 py-1 text-zinc-400 hover:text-white"
              onClick={() => run("guest", async () => { const r = await api<{ url: string }>(`/api/live/${id}/guest-invite`, { method: "POST" }); setGuestLink(r.url); })}>
              <Plus className="h-4 w-4" />Add source (guest, camera)
            </button>
          </section>
        </aside>

        {/* Center: program + multiview */}
        <main className="min-w-0 space-y-3">
          <div className={cn(panel, "relative overflow-hidden")}>
            <div className="absolute left-3 top-3 z-10 flex gap-2">
              <span className="rounded bg-zinc-950/80 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-zinc-300">PROGRAM</span>
              {s.on_air && <span className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">LIVE</span>}
              <span className="rounded bg-zinc-950/80 px-2 py-0.5 text-[11px] text-zinc-200">{sceneCard ? st.scene : programLabel}</span>
            </div>
            <div className="absolute right-3 top-3 z-10 flex gap-2">
              {m("master").muted && <span className="flex items-center gap-1 rounded bg-red-600/90 px-2 py-0.5 text-[11px] font-semibold"><VolumeX className="h-3 w-3" />MUTED</span>}
              {camOff && <span className="flex items-center gap-1 rounded bg-zinc-700 px-2 py-0.5 text-[11px] font-semibold"><CameraOff className="h-3 w-3" />CAMERA OFF</span>}
              <button className="rounded bg-zinc-950/80 px-2 py-0.5 text-[11px]" onClick={() => setMuted((v) => !v)}>{muted ? "Listen" : "Silence preview"}</button>
            </div>
            <div className="aspect-video bg-black">
              {s.on_air || live ? (
                <HlsPlayer src={s.stream.hls_url} live muted={muted} controls={false} className="h-full w-full" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-400">
                  {s.waiting_for_encoder ? <><Loader2 className="h-8 w-8 animate-spin" />Waiting for OBS to connect…</> : <>Start your encoder or press GO LIVE.</>}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 2xl:grid-cols-6">
            {tiles.map((t) => {
              const isProgram = st.program === t.name && t.connected;
              const isPreview = preview === t.name && !isProgram;
              return (
                <button key={t.name} disabled={!t.connected || !!busy}
                  onClick={() => (isPreview ? take(t.name) : setPreview(t.name))}
                  onDoubleClick={() => take(t.name)}
                  className={cn("group overflow-hidden rounded-md border-2 text-left transition", isProgram ? "border-red-600" : isPreview ? "border-emerald-500" : "border-zinc-800 hover:border-zinc-600", !t.connected && "opacity-50")}>
                  <div className="relative aspect-video bg-zinc-900">
                    {t.name === "interview" ? <div className="flex h-full items-center justify-center text-xs text-zinc-400">Side by side</div> : <Snapshot url={t.snapshot} />}
                    <span className={cn("absolute left-1 top-1 rounded px-1.5 text-[10px] font-bold", isProgram ? "bg-red-600 text-white" : isPreview ? "bg-emerald-500 text-black" : t.connected ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400")}>
                      {isProgram ? "LIVE" : isPreview ? "PREVIEW" : t.connected ? "READY" : "OFFLINE"}
                    </span>
                    {t.resolution && <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[10px]">{t.resolution}</span>}
                  </div>
                  <div className="flex items-center justify-between px-2 py-1 text-xs"><span>{SOURCE_LABEL[t.name]}</span>{isPreview && <span className="font-semibold text-emerald-400">Click to take</span>}</div>
                </button>
              );
            })}
          </div>
          {preview && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-zinc-400">Preview: {SOURCE_LABEL[preview]}</span>
              <button onClick={() => take(preview)} className="rounded bg-red-600 px-4 py-1 font-semibold text-white hover:bg-red-500">TAKE ({st.transition})</button>
              <button onClick={() => setPreview(null)} className="text-zinc-400 hover:text-white">Cancel</button>
            </div>
          )}
        </main>

        {/* Right: dashboard, chat, moderation */}
        <aside className="flex min-h-[520px] flex-col gap-3">
          <section className={cn(panel, "grid grid-cols-3 gap-2 p-3 text-center")}>
            <div><Eye className="mx-auto mb-1 h-4 w-4 text-zinc-400" /><div className="text-lg font-semibold tabular-nums">{s.dashboard.viewers}</div><div className="text-[10px] uppercase text-zinc-500">Viewers · peak {s.dashboard.peak}</div></div>
            <div><Heart className="mx-auto mb-1 h-4 w-4 text-zinc-400" /><div className="text-lg font-semibold tabular-nums">{s.dashboard.likes}</div><div className="text-[10px] uppercase text-zinc-500">Likes</div></div>
            <div><MessageSquare className="mx-auto mb-1 h-4 w-4 text-zinc-400" /><div className="text-lg font-semibold tabular-nums">{s.dashboard.comments}</div><div className="text-[10px] uppercase text-zinc-500">Comments</div></div>
          </section>
          {s.destinations.length > 0 && (
            <section className={cn(panel, "space-y-1 p-3 text-xs")}>
              <div className={h3}>Destinations</div>
              {s.destinations.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2"><span>{d.platform.replace("_", " ")}{!d.is_enabled && " (off)"}</span><StatusBadge status={d.status} /></div>
              ))}
            </section>
          )}
          <Chat streamId={id} hostId={s.stream.creator_id} />
          <ModTools studio={s} streamId={id} onSaved={refresh} />
        </aside>
      </div>

      {/* Bottom: audio mixer + controls */}
      <footer className="border-t border-zinc-800 p-3">
        <div className="flex flex-col gap-3 xl:flex-row">
          <section className={cn(panel, "flex-1 p-3")}>
            <div className={h3}>Audio mixer</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {s.channels.map((c) => (
                <Fader key={c.id} id={c.id} label={c.label} level={s.levels[c.id] ?? -90} value={m(c.id).volume}
                  muted={m(c.id).muted || st.scene_mutes.includes(c.id)} locked={c.id === "master" && s.rights.admin_muted && user?.role !== "admin"}
                  onChange={(v) => run(`vol-${c.id}`, () => api_.mixer(c.id, { volume: v }))}
                  onMute={(v) => run(`mute-${c.id}`, () => api_.mixer(c.id, { muted: v }))} />
              ))}
              <div className="flex min-w-[170px] flex-col gap-1.5 rounded-md border border-zinc-800 p-2">
                <div className="text-[11px] font-medium text-zinc-300">Sound effects</div>
                <div className="grid grid-cols-2 gap-1">
                  {s.effects.map((e) => <button key={e} onClick={() => run(`sfx-${e}`, () => api_.sfx(e))} className="rounded bg-zinc-800 px-1.5 py-1 text-[11px] hover:bg-zinc-700">{e}</button>)}
                </div>
                <div className="mt-1 text-[11px] font-medium text-zinc-300">Music</div>
                <div className="flex gap-1">
                  <label className="flex cursor-pointer items-center gap-1 rounded bg-zinc-800 px-1.5 py-1 text-[11px] hover:bg-zinc-700">
                    <Music className="h-3 w-3" />{st.has_music ? "Replace" : "Upload"}
                    <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const fd = new FormData(); fd.append("file", f); void run("music", () => uploadWithProgress(`/api/live/${id}/studio/music`, fd, () => undefined)); } }} />
                  </label>
                  {st.has_music && <button onClick={() => run("music", () => api(`/api/live/${id}/studio/music/play`, { method: "POST", json: { playing: !st.music_playing } }))} className="rounded bg-zinc-800 px-1.5 py-1 text-[11px] hover:bg-zinc-700">{st.music_playing ? "Stop" : "Play"}</button>}
                </div>
              </div>
            </div>
          </section>
          <section className={cn(panel, "flex flex-wrap content-start items-center gap-2 p-3 xl:w-[420px]")}>
            {live ? (
              <button onClick={() => { if (confirm("End the stream for everyone? It will be saved as a video.")) void run("end", () => api(`/api/live/${id}/end`, { method: "POST" })).then(() => router.push("/go-live")); }}
                className="rounded bg-zinc-100 px-4 py-2 text-sm font-bold text-zinc-900 hover:bg-white">END STREAM</button>
            ) : (
              <button onClick={() => run("golive", () => api(`/api/live/${id}/go-live`, { method: "POST" }))} disabled={s.stream.status === "Ended"}
                className="rounded bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-50">GO LIVE</button>
            )}
            <span className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs", s.health.recording ? "bg-red-950 text-red-300" : "bg-zinc-800 text-zinc-400")}>
              <Circle className={cn("h-2.5 w-2.5", s.health.recording && "animate-pulse fill-red-500 text-red-500")} />{s.health.recording ? "Recording" : "Not recording"}
            </span>
            <span className={cn("rounded px-2 py-1 text-xs font-semibold", s.health.level === "good" ? "bg-emerald-950 text-emerald-300" : s.health.level === "warn" ? "bg-yellow-950 text-yellow-300" : "bg-red-950 text-red-300")}>
              Stream health: {s.health.label}
            </span>
            <span className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300" title="Encoder used for the program">
              <Cpu className="h-3 w-3" />{(s.health.encoder ?? "").includes("nvenc") ? "Hardware encoding NVENC" : "Software encoding x264"} · {Math.round(s.health.output_fps ?? 0)} fps
            </span>
            <span className="text-[11px] text-zinc-500">CPU {Math.round(s.health.cpu_percent ?? 0)}% · RAM {Math.round(s.health.ram_percent ?? 0)}% · dropped {s.health.dropped_frames ?? 0} · up {s.health.net_out_kbps ?? 0} kbps</span>
            <div className="ml-auto flex gap-1">
              <button onClick={() => setSettings(true)} className="rounded bg-zinc-800 p-2 hover:bg-zinc-700" aria-label="Settings"><Settings className="h-4 w-4" /></button>
              <button onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/live/${id}`); setNotice("Watch link copied."); }} className="rounded bg-zinc-800 p-2 hover:bg-zinc-700" aria-label="Share"><Share2 className="h-4 w-4" /></button>
            </div>
          </section>
        </div>
      </footer>

      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Stream settings</DialogTitle><DialogDescription>Destinations can be added, turned off or changed while live; the others keep running.</DialogDescription></DialogHeader>
          <DestinationsEditor streamId={id} poll />
          <Link href="/go-live" className="text-sm text-primary hover:underline">Stream key and encoder setup →</Link>
        </DialogContent>
      </Dialog>
      <Dialog open={!!guestLink} onOpenChange={(o) => !o && setGuestLink(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle><UserPlus className="mr-2 inline h-5 w-5" />Invite a guest</DialogTitle><DialogDescription>Send this link. The guest joins with camera and microphone from the browser and appears as the Guest source; bring them to Program in one click. Valid for 6 hours.</DialogDescription></DialogHeader>
          <div className="flex gap-2"><input readOnly value={guestLink ?? ""} className="min-w-0 flex-1 rounded border px-2 py-1.5 font-mono text-xs" aria-label="Guest link" />
            <button className="rounded bg-primary px-3 text-sm text-primary-foreground" onClick={() => guestLink && navigator.clipboard.writeText(guestLink)}><Link2 className="inline h-4 w-4" /> Copy</button></div>
          <p className="text-xs text-muted-foreground">More cameras: another encoder streams to the same server with your key plus <span className="font-mono">-cam2</span>, <span className="font-mono">-cam3</span> or <span className="font-mono">-cam4</span>.</p>
        </DialogContent>
      </Dialog>
      <Dialog open={addScene} onOpenChange={setAddScene}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add a scene</DialogTitle></DialogHeader>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const kind = String(f.get("kind"));
            void run("addscene", () => api(`/api/live/${id}/studio/scenes`, { method: "POST", json: { name: f.get("name"), source: kind === "card" ? null : kind, card_title: kind === "card" ? f.get("card") : null, mute: f.get("mute") ? ["mic1", "mic2", "guest"] : [] } })).then(() => setAddScene(false));
          }}>
            <input name="name" required maxLength={40} placeholder="Scene name" aria-label="Scene name" className="w-full rounded border px-2 py-1.5 text-sm" />
            <select name="kind" aria-label="Scene shows" className="w-full rounded border px-2 py-1.5 text-sm">
              {["cam1", "cam2", "cam3", "cam4", "screen", "guest", "interview"].map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
              <option value="card">Full-screen card with text</option>
            </select>
            <input name="card" maxLength={60} placeholder="Card text (for a card scene)" aria-label="Card text" className="w-full rounded border px-2 py-1.5 text-sm" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="mute" />Mute microphones in this scene</label>
            <button className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground">Add scene</button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Inner() {
  const params = useSearchParams();
  const id = Number(params.get("id"));
  if (!id) return <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">No stream selected. <Link className="ml-1 text-sky-400" href="/go-live">Go live</Link></div>;
  return <Studio_ id={id} />;
}

export default function LiveStudioPage() {
  return <RequireAuth><Suspense fallback={null}><Inner /></Suspense></RequireAuth>;
}
