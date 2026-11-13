/** One playback's counting state. Position jumps, pauses and ads never add watch time. */
export class PlaybackCounts {
  private ticket: Promise<string | null> | null = null;
  private watched = 0;
  private pending = 0;
  private accepted = false;
  private busy = false;
  private sending = false;
  private retryAt = 0;
  private position = 0;
  private sampledAt = 0;
  private lastBeat = 0;
  private viewSeconds = 0;
  constructor(private readonly id: string) {}

  sample(position: number, duration: number, playing: boolean, rate = 1) {
    const now = performance.now();
    const elapsed = this.sampledAt ? (now - this.sampledAt) / 1000 : 0;
    const delta = position - this.position;
    this.position = position; this.sampledAt = now;
    if (!playing || !Number.isFinite(duration) || duration <= 0) return;
    if (!this.ticket) this.ticket = fetch(`/api/videos/${this.id}/play`, { method: 'POST', credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : null).then((d) => d?.ticket ?? null).catch(() => null);
    if (delta > 0 && elapsed > 0 && delta <= elapsed * Math.min(2, rate) + 0.5) {
      this.watched += delta;
      if (this.accepted) this.pending += delta;
    }
    if (!this.accepted && !this.busy && now >= this.retryAt && this.watched >= Math.min(30, duration / 2)) void this.view();
    if (this.accepted && now - this.lastBeat >= 30_000) void this.flush();
  }

  private async view() {
    this.busy = true;
    // Keep a stable initial claim across retries: a lost response must not count the initial time twice.
    this.viewSeconds ||= Math.max(1, Math.round(this.watched));
    try {
      const ticket = await this.ticket;
      if (!ticket) { this.ticket = null; return; }
      const r = await fetch(`/api/videos/${this.id}/views`, { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, watchedSeconds: this.viewSeconds }) });
      if (!r.ok) return;
      const d = await r.json();
      if (d.counted || d.reason === 'duplicate' || d.reason === 'ticket-used') {
        this.accepted = true;
        this.pending += Math.max(0, this.watched - this.viewSeconds);
        this.lastBeat = performance.now();
        void this.flush();
      }
    } catch { /* Retry after temporary network failures. */ }
    finally { this.busy = false; this.retryAt = performance.now() + 2000; }
  }

  async flush() {
    const seconds = Math.min(150, Math.floor(this.pending));
    if (!this.accepted || this.sending || seconds < 1) return;
    this.sending = true; this.pending -= seconds; this.lastBeat = performance.now();
    try {
      const r = await fetch(`/api/videos/${this.id}/watch`, { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchedSeconds: seconds }) });
      if (!r.ok) this.pending += seconds;
    } catch { this.pending += seconds; }
    finally { this.sending = false; }
  }
}
