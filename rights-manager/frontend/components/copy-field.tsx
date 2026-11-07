"use client";

import { useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  async function copy() {
    await navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex gap-2">
        <Input readOnly value={shown ? value : "•".repeat(Math.min(value.length, 28))} className="font-mono" aria-label={label} />
        {secret && <Button type="button" variant="outline" size="icon" onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide" : "Show"}>{shown ? <EyeOff /> : <Eye />}</Button>}
        <Button type="button" variant="outline" onClick={copy} aria-label={`Copy ${label}`}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
      </div>
    </div>
  );
}
