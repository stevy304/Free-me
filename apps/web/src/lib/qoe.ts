'use client';

/**
 * One playback's experience (see the API's media/qoe.ts), measured in the player and sent when the viewer leaves
 * the video (or the page), and every 5 minutes of a long playback. Nothing that identifies the viewer is sent: the
 * server only adds it to counters per country, codec, device and connection.
 */
type Codec = 'av1' | 'h264' | 'native' | 'other';
const REPORT_EVERY_S = 300;

export function deviceKind(): 'phone' | 'tablet' | 'desktop' | 'tv' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/SmartTV|SMART-TV|Tizen|Web0S|HbbTV|CrKey|AFT[A-Z]|BRAVIA|TV Safari/i.test(ua)) return 'tv';
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'phone';
  return 'desktop';
}

export function networkKind(): 'slow-2g' | '2g' | '3g' | '4g' | 'unknown' {
  const t = (typeof navigator !== 'undefined' ? (navigator as { connection?: { effectiveType?: string } }).connection?.effectiveType : undefined) ?? '';
  return (['slow-2g', '2g', '3g', '4g'] as const).find((k) => k === t) ?? 'unknown';
}

export class QoeSession {
  private startupMs: number | null = null;
  private played = 0; private quality = 0; private stalls = 0; private stallMs = 0;
  private error = false; private errorSent = false; private stalledBefore = false; private firstSent = false;
  private codec: Codec = 'other';
  constructor(private readonly videoId: string) {}

  setCodec(c: Codec) { this.codec = c; }
  startup(ms: number) { if (this.startupMs === null && ms >= 0 && ms < 120_000) this.startupMs = Math.round(ms); }
  stall(ms: number) { if (ms > 0) { this.stalls++; this.stallMs += Math.min(ms, 3_600_000); } }
  failed() { this.error = true; }
  /** `seconds` of picture shown at `shortSide` pixels (the smaller side). */
  watched(seconds: number, shortSide: number) {
    if (!(seconds > 0) || seconds > 5) return; // a jump (seek, sleep) is not watching
    this.played += seconds; this.quality += seconds * shortSide;
    if (this.played >= REPORT_EVERY_S) this.send();
  }

  /** Sends what was measured since the last report (nothing when nothing happened). */
  send() {
    const nothing = !this.played && this.startupMs === null && !this.stalls && !(this.error && !this.errorSent);
    if (nothing) return;
    const firstStall = this.stalls > 0 && !this.stalledBefore;
    const body = {
      ...(this.startupMs !== null ? { startupMs: this.startupMs } : {}),
      playedSeconds: Math.min(3600, Math.round(this.played)), stalls: Math.min(1000, this.stalls), stallMs: Math.min(3_600_000, Math.round(this.stallMs)),
      shortSide: this.played ? Math.min(4320, Math.round(this.quality / this.played)) : 0,
      codec: this.codec, device: deviceKind(), network: networkKind(), error: this.error && !this.errorSent, first: !this.firstSent, firstStall,
    };
    if (firstStall) this.stalledBefore = true;
    if (this.error) this.errorSent = true;
    this.firstSent = true;
    // Startup is only ever sent once: after the first report, a later one has none.
    this.startupMs = null; this.played = 0; this.quality = 0; this.stalls = 0; this.stallMs = 0;
    void fetch(`/api/videos/${this.videoId}/qoe`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
  }
}
