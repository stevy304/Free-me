"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { startIngest } from "@/lib/live";

interface Invite { stream_id: number; title: string; host: string; kind: string; live: boolean }

/** A guest opens the invite link, allows camera and microphone, and joins the host's control room as "Guest". */
export default function GuestPage() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "joining" | "on">("idle");
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => { api<Invite>(`/api/live/guest/${encodeURIComponent(token)}`).then(setInvite, (e) => setError((e as Error).message)); }, [token]);
  useEffect(() => () => stop.current?.(), []);

  async function join() {
    setState("joining"); setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: { echoCancellation: true, noiseSuppression: true } });
      if (video.current) { video.current.srcObject = media; void video.current.play(); }
      stop.current = startIngest(media, token, (why) => { setState("idle"); setError(why); });
      setState("on");
    } catch (e) { setState("idle"); setError((e as Error).message || "Camera or microphone not allowed."); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 p-6 text-center">
      {invite ? (
        <>
          <h1 className="text-2xl font-semibold">Join “{invite.title}”</h1>
          <p className="text-muted-foreground">@{invite.host} invited you as a guest. You appear in their control room; they put you on air.</p>
          <video ref={video} muted playsInline className="aspect-video w-full rounded-lg bg-black" />
          {state === "on" ? (
            <div className="flex items-center gap-3"><span className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white">Connected to the studio</span>
              <Button variant="outline" onClick={() => { stop.current?.(); setState("idle"); }}>Leave</Button></div>
          ) : (
            <Button size="lg" onClick={join} disabled={state === "joining" || !invite.live}>{state === "joining" ? <Loader2 className="animate-spin" /> : <><Video /><Mic /></>}Join with camera and microphone</Button>
          )}
          {!invite.live && <p className="text-sm text-muted-foreground">The stream has not started yet. Keep this page open and try again when the host is live.</p>}
        </>
      ) : !error && <Loader2 className="animate-spin" />}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </main>
  );
}
