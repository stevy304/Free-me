"use client";

import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { checkVideo, MAX_MB } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Pick or drop one video; type and size are checked before anything is sent. */
export function FileDrop({ file, onFile, onError, disabled }: { file: File | null; onFile: (f: File | null) => void; onError: (m: string | null) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function take(f: File | undefined) {
    if (!f) return;
    const problem = checkVideo(f);
    onError(problem);
    onFile(problem ? null : f);
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center text-sm transition-colors hover:border-primary/60 disabled:opacity-50",
        over && "border-primary bg-primary/5",
      )}
    >
      <UploadCloud className="h-8 w-8 text-muted-foreground" />
      {file ? (
        <span className="font-medium">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
      ) : (
        <span><span className="font-medium text-primary">Choose a video</span> or drop it here</span>
      )}
      <span className="text-xs text-muted-foreground">MP4, MOV or WebM · up to {MAX_MB} MB</span>
      <input ref={input} type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" className="hidden" onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} />
    </button>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="space-y-1">
      <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${value}%` }} /></div>
      <p className="text-xs text-muted-foreground">{value < 100 ? `Uploading… ${value}%` : "Uploaded. Processing…"}</p>
    </div>
  );
}
