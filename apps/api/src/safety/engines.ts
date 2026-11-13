import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import { CATEGORIES, type Category, type Scores } from './policy';

/**
 * Engines that can look at what the built-in rules cannot: pictures (and text in any language). Each answers with
 * scores per category; the policy decides. Configured with SAFETY_ENGINE:
 *
 * - `openai`: OpenAI's moderation model (omni-moderation-latest), text and images, free with an account key
 *   (SAFETY_OPENAI_KEY). Video frames and text are sent to OpenAI.
 * - `http`: any service you run or buy (SAFETY_SCAN_URL), sent { videoId?, text?, frames: [base64 JPEG] }, answering
 *   { scores: { category: 0..1 } } and/or { match, label } (the older fingerprint-scanner form).
 * - `none` (default): text is checked by the built-in rules only; pictures are not looked at by a machine, so the
 *   unscanned-video rule (SAFETY_UNSCANNED_REVIEW) decides which videos a person checks first.
 */
export interface CheckInput { text?: string; frames?: string[]; videoId?: string; /** For fingerprint-matching services */ sha256?: string | null; md5?: string | null; durationSeconds?: number }
/** Scores, and the service's own words when it gives some (a fingerprint scanner's label): shown to moderators. */
export interface EngineResult { scores: Scores; note?: string }
export interface Engine { name: string; images: boolean; check(input: CheckInput, signal?: AbortSignal): Promise<EngineResult> }

const log = new Logger('SafetyEngine');

/** OpenAI moderation categories → ours (the most serious wins where several map to one). */
const OPENAI: Record<string, Category> = {
  'sexual/minors': 'sexual/minors', sexual: 'sexual', 'violence/graphic': 'violence/graphic', violence: 'violence',
  hate: 'hate', 'hate/threatening': 'hate', harassment: 'harassment', 'harassment/threatening': 'harassment',
  'self-harm': 'self-harm', 'self-harm/intent': 'self-harm', 'self-harm/instructions': 'self-harm', illicit: 'illicit', 'illicit/violent': 'illicit',
};

export class OpenAiEngine implements Engine {
  readonly name = 'openai'; readonly images = true;
  constructor(private readonly key: string, private readonly url = 'https://api.openai.com/v1/moderations', private readonly timeoutMs = 30_000) {}

  private async one(input: unknown, signal?: AbortSignal): Promise<Scores> {
    const res = await fetch(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: 'omni-moderation-latest', input }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`moderation answered ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ category_scores?: Record<string, number> }> };
    const out: Scores = {};
    for (const r of body.results ?? []) for (const [k, v] of Object.entries(r.category_scores ?? {})) {
      const c = OPENAI[k];
      if (c && Number.isFinite(v)) out[c] = Math.max(out[c] ?? 0, v);
    }
    return out;
  }

  async check(input: { text?: string; frames?: string[] }, signal?: AbortSignal): Promise<EngineResult> {
    // One request for the text, one per picture (at most 4 at a time), so a long list never hits a size limit.
    const parts: unknown[] = [];
    if (input.text?.trim()) parts.push(input.text.slice(0, 20_000));
    for (const f of input.frames ?? []) parts.push([{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f}` } }]);
    const all: Scores[] = [];
    for (let i = 0; i < parts.length; i += 4) all.push(...await Promise.all(parts.slice(i, i + 4).map((p) => this.one(p, signal))));
    return { scores: merge(all) };
  }
}

export class HttpEngine implements Engine {
  readonly name = 'http'; readonly images = true;
  constructor(private readonly url: string, private readonly token: string | null, private readonly timeoutMs: number) {}
  async check(input: CheckInput, signal?: AbortSignal): Promise<EngineResult> {
    const res = await fetch(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ videoId: input.videoId, sha256: input.sha256, md5: input.md5, durationSeconds: input.durationSeconds, text: input.text, frames: input.frames ?? [] }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`scanner answered ${res.status}`);
    const body = (await res.json()) as { scores?: Record<string, number>; match?: boolean; label?: string };
    const out: Scores = {};
    for (const [k, v] of Object.entries(body.scores ?? {})) if ((CATEGORIES as readonly string[]).includes(k) && Number.isFinite(v)) out[k as Category] = Math.max(0, Math.min(1, v));
    // The older form: a match means "a person must look", filed under the label's category when it names one.
    if (body.match) { const c = (CATEGORIES as readonly string[]).includes(body.label ?? '') ? body.label as Category : 'sexual/minors'; out[c] = 1; }
    return { scores: out, note: body.match ? `Flagged by the automatic scan${body.label ? `: ${String(body.label).slice(0, 200)}` : ''}` : undefined };
  }
}

const merge = (all: Scores[]): Scores => {
  const out: Scores = {};
  for (const s of all) for (const [k, v] of Object.entries(s) as Array<[Category, number]>) out[k] = Math.max(out[k] ?? 0, v);
  return out;
};

export function engineFrom(config: AppConfig): Engine | null {
  const s = config.safety;
  if (s.engine === 'openai' && s.openaiKey) return new OpenAiEngine(s.openaiKey, s.openaiUrl ?? undefined, s.timeoutMs);
  if (s.engine === 'http' && s.scanUrl) return new HttpEngine(s.scanUrl, s.scanToken, s.timeoutMs);
  if (s.engine !== 'none') log.warn(`SAFETY_ENGINE=${s.engine} is not fully configured; only the built-in text rules run.`);
  return null;
}
