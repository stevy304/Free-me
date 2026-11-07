import { API_URL, api } from "@/lib/api";

export type LiveStatus = "Scheduled" | "Live" | "Ended";
export type Privacy = "Public" | "Unlisted" | "Private";

export interface LiveStream {
  id: number; title: string; category: string | null; description: string | null; thumbnail_url: string | null;
  privacy: Privacy; status: LiveStatus; armed: boolean; scheduled_for: string | null; started_at: string | null; ended_at: string | null;
  viewer_peak: number; likes: number; creator: string; creator_id: number; hls_url: string; vod_video_id: string | null; created_at: string;
  viewers?: number; on_air?: boolean; slow_mode_seconds?: number;
  vod?: { id: string; status: string; views: number; duration: number | null } | null;
}
export interface StreamKey { id: number; key: string; rtmp_url: string; full_url: string; is_active: boolean; last_used_at: string | null }
export interface Destination { id: number; stream_id?: number; platform: string; rtmp_url?: string; stream_key_masked?: string; is_enabled: boolean; status: "Connected" | "Disconnected" | "Error"; error: string | null }
export interface Source { name: string; connected: boolean; status: "LIVE" | "READY" | "OFFLINE"; resolution: string | null; has_audio: boolean; snapshot: string | null; path_suffix: string | null }
export interface Scene { name: string; source?: string; card?: string; mute?: string[] }
export interface StudioState {
  scene: string; program: string; transition: "cut" | "fade" | "stinger"; scenes: Scene[];
  cards: Record<string, { title: string; subtitle: string }>;
  mixer: Record<string, { volume: number; muted: boolean }>; scene_mutes: string[];
  lower_third: { enabled: boolean; name: string; title: string }; chat_box: boolean; alerts: boolean; camera_off: string[];
  has_music: boolean; music_playing?: boolean;
}
export interface Health {
  label: string; level: "good" | "warn" | "bad"; bitrate_kbps?: number; fps?: number; resolution?: string | null; output_fps?: number;
  dropped_frames?: number; cpu_percent?: number; ram_percent?: number; net_in_kbps?: number; net_out_kbps?: number;
  reconnect_seconds_left?: number | null; low_bitrate_seconds?: number; encoder?: string; recording?: boolean; viewers?: number;
}
export interface Studio {
  stream: LiveStream; on_air: boolean; waiting_for_encoder: boolean; state: StudioState; sources: Source[];
  levels: Record<string, number>; health: Health; destinations: Destination[]; effects: string[];
  rights: { last_check: { score: number; reference: string | null; owner: string | null } | null; flagged: boolean; score: number | null; admin_muted: boolean };
  dashboard: { viewers: number; peak: number; likes: number; comments: number };
  moderation: { slow_mode_seconds: number; blocked_words: string[]; auto_moderate: boolean };
  channels: { id: string; label: string }[];
}
export interface ChatMessage { id: number; user_id: number | null; username: string; text: string; pinned: boolean; kind: string; amount_cents: number | null; created_at: string }

export const SOURCE_LABEL: Record<string, string> = {
  cam1: "Camera 1", cam2: "Camera 2", cam3: "Camera 3", cam4: "Camera 4", screen: "Screen Share", guest: "Guest", interview: "Interview", black: "Black",
};
export const CATEGORIES = ["Gaming", "Music", "Education", "Sports", "News", "Talk", "Technology", "Entertainment", "Other"];

export const studioApi = (id: number) => ({
  program: (source: string, transition: string) => api(`/api/live/${id}/studio/program`, { method: "POST", json: { source, transition } }),
  scene: (name: string) => api(`/api/live/${id}/studio/scene`, { method: "POST", json: { name } }),
  mixer: (channel: string, patch: { volume?: number; muted?: boolean }) => api(`/api/live/${id}/studio/mixer`, { method: "POST", json: { channel, ...patch } }),
  overlay: (patch: Record<string, unknown>) => api(`/api/live/${id}/studio/overlay`, { method: "POST", json: patch }),
  sfx: (name: string) => api(`/api/live/${id}/studio/sfx`, { method: "POST", json: { name } }),
});

/** ws(s)://… for the API. */
export function wsUrl(path: string) {
  return API_URL.replace(/^http/, "ws") + path;
}

export function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
}

/** Sends camera/microphone or screen to the stream through the API (MediaRecorder WebM pieces over a WebSocket). */
export function startIngest(stream: MediaStream, token: string, onClose: (reason: string) => void) {
  const ws = new WebSocket(wsUrl(`/api/live/ingest?token=${encodeURIComponent(token)}`));
  ws.binaryType = "arraybuffer";
  const mime = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
  rec.ondataavailable = (e) => { if (e.data.size && ws.readyState === WebSocket.OPEN) e.data.arrayBuffer().then((b) => ws.send(b)); };
  ws.onopen = () => rec.start(250);
  ws.onclose = (e) => { if (rec.state !== "inactive") rec.stop(); onClose(e.code === 4409 ? "The stream is not live yet." : e.code === 4401 ? "This link is not valid any more." : "Disconnected."); };
  return () => { if (rec.state !== "inactive") rec.stop(); ws.close(); stream.getTracks().forEach((t) => t.stop()); };
}
