"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { UploadCloud } from "lucide-react";
import { uploads } from "@/lib/uploader";

const subscribe = (fn: () => void) => uploads.subscribe(fn);
let cache = { key: "", value: [] as ReturnType<typeof uploads.tasks[number]["snapshot"]>[] };
function snapshot() {
  const list = uploads.active().map((t) => t.snapshot());
  const key = list.map((s) => `${s.id}:${s.state}:${Math.round(s.bytes / 1e5)}`).join("|");
  if (key !== cache.key) cache = { key, value: list };
  return cache.value;
}

/** Uploads keep going while the creator uses other pages; this shows them in the corner. */
export function UploadTray() {
  const list = useSyncExternalStore(subscribe, snapshot, () => cache.value);
  if (!list.length) return null;
  const bytes = list.reduce((a, s) => a + s.bytes, 0), total = list.reduce((a, s) => a + s.total, 0);
  return (
    <Link href="/upload" className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-full border bg-background px-4 py-2 text-sm shadow-lg">
      <UploadCloud className="h-4 w-4 text-primary" />
      Uploading {list.length} {list.length === 1 ? "video" : "videos"} · {total ? Math.floor((bytes / total) * 100) : 0}%
    </Link>
  );
}
