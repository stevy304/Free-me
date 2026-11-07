export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");
export const MAX_MB = 500;
export const VIDEO_TYPES = [".mp4", ".mov", ".webm"];

export type Role = "creator" | "admin";
export type Policy = "Block" | "Mute" | "Flag" | "Track";
export type UploadStatus = "Processing" | "Approved" | "Blocked" | "Flagged" | "Failed";
export type MatchStatus = "blocked" | "muted" | "flagged" | "tracked" | "approved" | "released";
export type DisputeStatus = "Pending" | "Approved" | "Rejected";

export interface User { id: number; username: string; email: string; role: Role; created_at: string }
export interface Reference {
  id: number; title: string; policy: Policy; status: "processing" | "ready" | "failed"; error: string | null;
  duration: number | null; file_hash_sha256: string | null; thumbnail_url: string | null; frames: number; has_audio: boolean;
  owner: string; created_at: string;
}
export interface Upload {
  id: number; title: string | null; status: UploadStatus; message: string | null; duration: number | null; thumbnail_url: string | null;
  audio_removed: boolean; has_watermark: boolean; watermark_text: string | null; uploader: string; created_at: string;
  match_id: number | null; can_dispute: boolean; dispute_id: number | null;
}
export interface Match {
  id: number; upload_id: number; reference_id: number; reference_title: string; reference_owner: string; reference_thumbnail_url: string | null;
  upload_title: string | null; uploader: string; upload_thumbnail_url: string | null; upload_status: UploadStatus;
  video_score: number; audio_score: number | null; combined_score: number; exact: boolean; has_watermark: boolean;
  status: MatchStatus; policy: Policy; created_at: string; dispute_id: number | null;
}
export interface Dispute {
  id: number; match_id: number; upload_id: number; upload_title: string | null; upload_thumbnail_url: string | null;
  reference_title: string; reference_owner: string; uploader: string; reason: string; status: DisputeStatus;
  creator_response: string | null; creator_action: "release" | "uphold" | null; admin_note: string | null;
  respond_by: string; overdue: boolean; created_at: string; decided_at: string | null; combined_score: number;
}
export interface LogEntry { id: number; action: string; note: string | null; actor: string | null; created_at: string }
export interface Notification { id: number; text: string; link: string | null; read: boolean; created_at: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TOKEN = "rm_token";
export const tokenStore = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN)),
  set: (t: string) => window.localStorage.setItem(TOKEN, t),
  clear: () => window.localStorage.removeItem(TOKEN),
};

function message(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0]?.msg) {
    const d = detail[0] as { loc?: string[]; msg: string };
    const field = d.loc?.[d.loc.length - 1];
    return field ? `${field}: ${d.msg}` : d.msg;
  }
  if (status === 0) return "The server cannot be reached. Check your connection.";
  if (status >= 500) return "Something went wrong on the server. Try again.";
  return `Request failed (${status}).`;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, message(0, null));
  }
  if (res.status === 401 && token) {
    tokenStore.clear();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) window.location.href = "/login";
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, message(res.status, data));
  return data as T;
}

/** Checks a video before sending it: type and size. Returns an error message or null. */
export function checkVideo(file: File): string | null {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!VIDEO_TYPES.includes(ext)) return "Only MP4, MOV and WebM videos can be uploaded.";
  if (file.size > MAX_MB * 1024 * 1024) return `Videos can be at most ${MAX_MB} MB.`;
  if (file.size === 0) return "The file is empty.";
  return null;
}

/** Multipart upload with progress (fetch cannot report upload progress). */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
    const token = tokenStore.get();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, message(xhr.status, data)));
    };
    xhr.onerror = () => reject(new ApiError(0, message(0, null)));
    xhr.send(form);
  });
}

export const mediaUrl = (u: string | null) => (u ? `${API_URL}${u}` : null);
