import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/config';
import { POLICY, decide, type Decision, type Scores } from './policy';
import { moderatorTerms, scoreText } from './rules';
import { engineFrom, type Engine } from './engines';
import { aiModerator, type AiVerdict } from './ai';
import { secret } from '../settings/secrets';
import { feedsChanged } from '../catalog/feed-cache';

/**
 * The safety checks (TRUST_AND_SAFETY.md). With an Anthropic key (Administration → Secrets) the AI moderator decides
 * (safety/ai.ts): publish, limit or reject, with a reason, and no person is needed. Without one, the built-in rules,
 * an optional picture classifier and the unscanned-video rule decide, and anything over a line waits for a moderator.
 */
const log = new Logger('Safety');
/** A picture classifier's score from which it decides alone (without the AI moderator) that a video is not published. */
const SURE = 0.9;

/** The picture classifier or outside scanner, with keys from Administration → Secrets (else the environment). */
async function engineOf(prisma: PrismaClient, config: AppConfig): Promise<Engine | null> {
  const [openai, token] = await Promise.all([secret(prisma, config, 'SAFETY_OPENAI_KEY'), secret(prisma, config, 'SAFETY_SCAN_TOKEN')]);
  return engineFrom({ ...config, safety: { ...config.safety, openaiKey: openai ?? config.safety.openaiKey, scanToken: token ?? config.safety.scanToken,
    // A saved OpenAI key turns the classifier on even when SAFETY_ENGINE was not set.
    engine: config.safety.engine === 'none' && openai ? 'openai' : config.safety.engine } });
}

/** Text of a video a person would see: title, description, tags. */
export const videoText = (v: { title: string; description?: string | null; tags?: string[] }) => [v.title, v.description ?? '', ...(v.tags ?? [])].join('\n');

/** What the rules and classifier noticed, in words, for the AI moderator to weigh. */
const hintsOf = (scores: Scores) => (Object.entries(scores) as Array<[keyof typeof POLICY, number]>).filter(([, v]) => v >= 0.3).map(([k, v]) => `${POLICY[k].label.toLowerCase()} (${Math.round(v * 100)}%)`);

export interface TextVerdict extends Decision { ai: AiVerdict | null }

/**
 * A piece of text (a comment, a chat message, edited words). With the AI moderator (and `opts.ai` not false) it decides:
 * a rejection holds; publish and limit pass. Otherwise the rules (and the classifier, unless `opts.engine` is false).
 */
export async function checkText(prisma: PrismaClient, config: AppConfig, text: string, signal?: AbortSignal,
  opts: { engine?: boolean; ai?: boolean; kind?: 'comment' | 'edit' } = {}): Promise<TextVerdict> {
  const { scores } = scoreText(text, await moderatorTerms(prisma));
  if (opts.ai !== false && opts.engine !== false && text.trim()) {
    const ai = await aiModerator(prisma, config);
    if (ai) {
      try {
        const v = await ai.decide({ kind: opts.kind ?? 'comment', text, hints: hintsOf(scores) }, signal);
        const category = v.category === 'none' ? null : v.category;
        return { hold: v.decision === 'reject', category, score: v.confidence, priority: category ? POLICY[category].priority : 0, reason: v.reason, scores, ai: v };
      } catch (e) { if (signal?.aborted) throw e; log.warn(`AI moderator unavailable for text: ${(e as Error).message}`); }
    }
  }
  const engine = opts.engine === false ? null : await engineOf(prisma, config);
  let engineScores: Scores = {};
  if (engine && text.trim()) {
    try { engineScores = (await engine.check({ text }, signal)).scores; }
    catch (e) { if (signal?.aborted) throw e; log.warn(`text check: ${engine.name} unavailable: ${(e as Error).message}`); }
  }
  return { ...decide(scores, engineScores), ai: null };
}

/** The words of a WebVTT file, without numbers, timings and markup. */
export const vttText = (vtt: string) => vtt.split('\n').filter((l) => l.trim() && !/^WEBVTT|^\d+$|-->|^NOTE/.test(l.trim())).map((l) => l.replace(/<[^>]+>/g, '')).join('\n');

/**
 * What is said in a video (its automatic transcript, made after it is published). With the AI moderator: rejected,
 * the video is hidden and the creator told why (they can appeal); limited, it leaves feeds and search. Without it,
 * over a line the video is hidden for a moderator. Returns whether the video was hidden.
 */
export async function checkTranscript(prisma: PrismaClient, config: AppConfig, videoId: string, vtt: string, signal?: AbortSignal): Promise<boolean> {
  const video = await prisma.video.findUnique({ where: { id: videoId }, select: { title: true } });
  const words = vttText(vtt).slice(0, 50_000);
  const ai = await aiModerator(prisma, config);
  if (ai && video) {
    try {
      const v = await ai.decide({ kind: 'transcript', text: `Title: ${video.title}\n\n${words}`, hints: hintsOf(scoreText(words, await moderatorTerms(prisma)).scores) }, signal);
      if (v.decision === 'publish') return false;
      const now = new Date();
      if (v.decision === 'limit') {
        await prisma.video.updateMany({ where: { id: videoId, safetyLimitedAt: null }, data: { safetyLimitedAt: now, safetyDecision: 'limit', safetyReason: v.reason, safetyModel: v.model } });
        await feedsChanged();
        return false;
      }
      const held = await prisma.video.updateMany({ where: { id: videoId, reviewHoldAt: null, takenDownAt: null }, data: { reviewHoldAt: now, safetyDecision: 'reject', safetyReason: v.reason, safetyModel: v.model } });
      if (held.count) {
        await recordAutomatic(prisma, videoId, `Hidden automatically by ${v.model} (what is said): ${v.reason}`, v.category);
        await feedsChanged();
      }
      log.warn({ event: 'video_rejected_by_transcript', videoId, category: v.category, model: v.model });
      return held.count > 0;
    } catch (e) { if (signal?.aborted) throw e; log.warn(`${videoId}: AI moderator unavailable for the transcript: ${(e as Error).message}`); }
  }
  const verdict = await checkText(prisma, config, words, signal, { ai: false });
  if (!verdict.hold) return false;
  const held = await prisma.video.updateMany({ where: { id: videoId, reviewHoldAt: null, takenDownAt: null }, data: { reviewHoldAt: new Date() } });
  if (held.count) await prisma.report.create({ data: { videoId, reason: 'AUTOMATED_MATCH', details: `${verdict.reason} — in what is said (automatic transcript)`, priority: verdict.priority } });
  if (held.count) await feedsChanged();
  log.warn({ event: 'video_held_by_transcript', videoId, category: verdict.category });
  return true;
}

/** A decision the AI made alone, kept for the record (and for moderators who want to look): already resolved. */
export async function recordAutomatic(prisma: PrismaClient, videoId: string, details: string, category: string | null) {
  await prisma.report.create({ data: { videoId, reason: 'AUTOMATED_MATCH', details, priority: category && category in POLICY ? POLICY[category as keyof typeof POLICY].priority : 0,
    status: 'RESOLVED', resolution: details, resolvedAt: new Date() } });
}

/** What a person is told when their comment or message is not posted. */
export const refusal = (d: Decision & { ai?: AiVerdict | null }, what: 'comment' | 'message' | 'title') =>
  d.ai ? `Your ${what} was not ${what === 'title' ? 'saved' : 'posted'}: ${d.ai.reason}`
    : `Your ${what} was not ${what === 'title' ? 'saved' : 'posted'}: it looks like ${d.category ? POLICY[d.category].label.toLowerCase() : 'it breaks the Community Guidelines'}, which the Community Guidelines do not allow. If this is a mistake, please change the wording.`;

export interface VideoVerdict extends Decision {
  /** publish; limit (by link only); reject (not shown, creator told why); hold (a person must decide). */
  action: 'publish' | 'limit' | 'reject' | 'hold';
  model: string | null;
  /** Pictures were looked at by a machine (the AI moderator or a classifier). */
  scanned: boolean;
  /** Held only because nothing looked at the pictures and the uploader is new (SAFETY_UNSCANNED_REVIEW). */
  unscanned: boolean;
}

/**
 * The check a new video passes before anyone else can see it (run while it is being transcoded). `frames`: a few
 * JPEGs across the video (base64), taken once and shared by every engine.
 */
export async function checkVideo(prisma: PrismaClient, config: AppConfig, video: { id: string; title: string; description: string | null; channelId: string; durationSeconds?: number },
  frames: () => Promise<string[]>, signal?: AbortSignal, file: { madeBy?: string | null; aiLater?: boolean } = {}): Promise<VideoVerdict> {
  const tags = (await prisma.videoTag.findMany({ where: { videoId: video.id }, select: { tag: { select: { name: true } } } })).map((t) => t.tag.name);
  const text = videoText({ ...video, tags });
  const { scores } = scoreText(text, await moderatorTerms(prisma));
  // Downloaded from another app: its marks are in the file. Certain, so decided at once (no AI, no person), and the
  // creator is told how to fix it. They can appeal (e.g. when it is their own video: then they upload the original).
  if (file.madeBy) {
    const reason = `This video was downloaded from ${file.madeBy}: the file carries ${file.madeBy}'s marks, and usually its logo and the original account's name. Free Me does not publish videos taken from other apps. If it is your own video, upload the original from your phone's camera or editing app, without ${file.madeBy}'s logo.`;
    return { hold: true, category: 'reupload', score: 1, priority: POLICY.reupload.priority, reason, scores: { ...scores, reupload: 1 }, action: 'reject', model: null, scanned: true, unscanned: false };
  }
  let pictures: string[] | null = null;
  const pics = async () => (pictures ??= await frames());

  // A classifier or partner scanner, when configured: its child-safety findings go to a person, never to an AI.
  const engine = await engineOf(prisma, config);
  let engineScores: Scores = {};
  let note: string | undefined;
  let scanned = false;
  if (engine?.images) {
    try {
      const fp = await prisma.video.findUnique({ where: { id: video.id }, select: { sourceSha256: true, sourceMd5: true, durationSeconds: true } });
      ({ scores: engineScores, note } = await engine.check({ videoId: video.id, text, frames: await pics(), sha256: fp?.sourceSha256, md5: fp?.sourceMd5, durationSeconds: fp?.durationSeconds }, signal));
      scanned = true;
    } catch (e) {
      if (signal?.aborted) throw e;
      log.warn(`${video.id}: ${engine.name} unavailable: ${(e as Error).message}`);
    }
  }
  const combined = decide(scores, engineScores);
  if ((engineScores['sexual/minors'] ?? 0) >= POLICY['sexual/minors'].hold) {
    return { ...combined, hold: true, action: 'hold', reason: note ?? combined.reason, model: null, scanned, unscanned: false };
  }

  // The AI moderator decides when there is one (unless it looks after publishing: reviewPublishedVideo).
  const ai = file.aiLater ? null : await aiModerator(prisma, config);
  if (ai) {
    try {
      const v = await ai.decide({ kind: 'video', text, frames: await pics(), hints: [...hintsOf(combined.scores), ...(note ? [note] : [])] }, signal);
      const category = v.category === 'none' ? null : v.category;
      return { ...combined, hold: v.decision === 'reject', action: v.decision, category, score: v.confidence, priority: category ? POLICY[category].priority : 0, reason: v.reason, model: v.model, scanned: true, unscanned: false };
    } catch (e) {
      if (signal?.aborted) throw e;
      log.warn(`${video.id}: AI moderator unavailable: ${(e as Error).message}`);
    }
  }

  // Without it: a classifier that is very sure of gore or explicit sexual content rejects at once (the creator is told
  // why and can appeal); anything else over a line waits for a person.
  const sure = (['violence/graphic', 'sexual'] as const).find((c) => (engineScores[c] ?? 0) >= SURE);
  if (sure) {
    const what = sure === 'sexual' ? 'explicit sexual content or nudity' : 'graphic injuries, blood or gore';
    return { ...combined, hold: true, action: 'reject', category: sure, score: engineScores[sure]!, priority: POLICY[sure].priority, model: null, scanned, unscanned: false,
      reason: `The automatic check found ${what} in this video, which the Community Guidelines do not allow. If this is a mistake, you can ask for another look.` };
  }
  if (combined.hold) return { ...combined, action: 'hold', reason: note ?? combined.reason, model: null, scanned, unscanned: false };
  if (!scanned && !file.aiLater && engine?.images && config.safety.failClosed) {
    return { ...combined, hold: true, action: 'hold', priority: 40, reason: 'The automatic check could not run; held until a moderator looks at it', model: null, scanned: false, unscanned: true };
  }
  if (!scanned && !file.aiLater && await needsPerson(prisma, config, video.channelId)) {
    return { ...combined, hold: true, action: 'hold', priority: 30, reason: 'New Space: a moderator checks its first videos before they are shown (no automatic picture check is configured)', model: null, scanned: false, unscanned: true };
  }
  return { ...combined, action: 'publish', model: null, scanned, unscanned: false };
}

/** The unscanned-video rule: which uploads a person looks at first when no machine can see the pictures. */
async function needsPerson(prisma: PrismaClient, config: AppConfig, channelId: string): Promise<boolean> {
  const rule = config.safety.unscannedReview;
  if (rule === 'none') return false;
  if (rule === 'all') return true;
  const ch = await prisma.channel.findUnique({ where: { id: channelId }, select: { createdAt: true, _count: { select: { videos: { where: { status: 'READY', publishedAt: { not: null }, safetyCheckedAt: { not: null }, takenDownAt: null } } } } } });
  if (!ch) return true;
  return Date.now() - ch.createdAt.getTime() < 7 * 86_400_000 || ch._count.videos < 3;
}

/**
 * With the unscanned-video rule off (SAFETY_UNSCANNED_REVIEW=none, the default), videos it held earlier are let go
 * when the worker starts: processed again and published as their creators chose. Holds for anything else (blocked
 * files, the text rules, reports, a scanner's findings) stay for a moderator.
 */
export async function releaseUnscannedHolds(prisma: PrismaClient, config: AppConfig, enqueue: (videoId: string) => Promise<void>): Promise<number> {
  if (config.safety.unscannedReview !== 'none') return 0;
  const open = { status: { in: ['PENDING', 'INVESTIGATING'] as ('PENDING' | 'INVESTIGATING')[] } };
  const held = await prisma.report.findMany({ where: { reason: 'AUTOMATED_MATCH', ...open, details: { startsWith: 'New Space:' }, video: { status: 'FLAGGED', takenDownAt: null } }, select: { videoId: true } });
  let released = 0;
  for (const videoId of [...new Set(held.map((r) => r.videoId).filter((x): x is string => !!x))]) {
    // Only when this rule is the sole open reason.
    const others = await prisma.report.count({ where: { videoId, ...open, NOT: { reason: 'AUTOMATED_MATCH', details: { startsWith: 'New Space:' } } } });
    if (others) continue;
    const now = new Date();
    await prisma.$transaction([
      prisma.video.update({ where: { id: videoId }, data: { status: 'PROCESSING', processingStage: 'Queued' } }),
      prisma.report.updateMany({ where: { videoId, ...open }, data: { status: 'DISMISSED', resolution: 'Released: new Spaces’ videos no longer wait for a person.', resolvedAt: now } }),
    ]);
    await enqueue(videoId);
    released++;
  }
  return released;
}

/**
 * The AI moderator's look at a video just published (TRUST_AND_SAFETY.md): the creator sees it published at once, and
 * Claude looks at a few frames and its words straight after. Rejected: hidden from everyone but its creator, who sees
 * "Not published" and why, and can appeal. Limited: kept out of feeds and search. Returns the decision, or null when
 * the AI moderator is not set up or could not answer (the video then stays published).
 */
export async function reviewPublishedVideo(prisma: PrismaClient, config: AppConfig, videoId: string,
  frames: () => Promise<string[]>, signal?: AbortSignal): Promise<'publish' | 'limit' | 'reject' | null> {
  const ai = await aiModerator(prisma, config);
  if (!ai) return null;
  const v = await prisma.video.findUnique({ where: { id: videoId }, select: { title: true, description: true, tags: { select: { tag: { select: { name: true } } } } } });
  if (!v) return null;
  const text = videoText({ title: v.title, description: v.description, tags: v.tags.map((t) => t.tag.name) });
  let verdict: AiVerdict;
  try {
    verdict = await ai.decide({ kind: 'video', text, frames: await frames(), hints: hintsOf(scoreText(text, await moderatorTerms(prisma)).scores) }, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn(`${videoId}: AI moderator unavailable, the video stays published: ${(e as Error).message}`);
    return null;
  }
  const now = new Date();
  const base = { safetyDecision: verdict.decision, safetyReason: verdict.reason, safetyModel: verdict.model };
  log.log({ event: 'video_ai_reviewed', videoId, decision: verdict.decision, category: verdict.category, model: verdict.model, confidence: verdict.confidence });
  if (verdict.decision === 'publish') { await prisma.video.update({ where: { id: videoId }, data: base }); return 'publish'; }
  if (verdict.decision === 'limit') {
    await prisma.video.update({ where: { id: videoId }, data: { ...base, safetyLimitedAt: now } });
    await feedsChanged();
    return 'limit';
  }
  await prisma.video.updateMany({ where: { id: videoId, takenDownAt: null }, data: { ...base, reviewHoldAt: now } });
  await recordAutomatic(prisma, videoId, `Not published, decided by ${verdict.model} after upload: ${verdict.reason}`, verdict.category === 'none' ? null : verdict.category);
  await feedsChanged();
  return 'reject';
}
