"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorBox } from "@/components/shared";
import { api, type Dispute } from "@/lib/api";

export function DisputeDialog({ matchId, title, onDone }: { matchId: number; title: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api<Dispute>("/api/disputes", { method: "POST", json: { match_id: matchId, reason: reason.trim() } });
      setOpen(false); setReason(""); onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Dispute</Button></DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Dispute the claim on “{title}”</DialogTitle>
            <DialogDescription>
              The owner of the original has 7 days to release or uphold the claim. If they uphold it, an administrator decides.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reason">Why may you post this video?</Label>
            <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={4000} required
              placeholder="For example: I made it myself, I have a licence from the owner, or it is commentary that uses a short part." />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
          {error && <ErrorBox message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy || reason.trim().length < 10}>{busy && <Loader2 className="animate-spin" />}Send dispute</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
