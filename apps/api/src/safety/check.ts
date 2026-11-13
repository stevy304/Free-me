import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/config';
import { POLICY, decide, type Decision, type Scores } from './policy';
import { moderatorTerms, scoreText } from './rules';
import { engineFrom, type Engine } from './engines';
import { feedsChanged } from '../catalog/feed-cache';

const log = new Logger('Safety');
const engines = new WeakMap<AppConfig, Engine | null>();
const engineOf = (config: AppConfig) => { if (!engines.has(config)) engines.set(config, engineFrom(config)); return engines.get(config)!; };

/** Text of a video a person would see: title, description, tags. */
export const videoText = (v: { title: string; description?: string | null; tags?: string[] }) => [v.title, v.description ?? '', ...(v.tags ?? [])].join('\n');

/**
 * A piece of text (a comment, a chat message, an edited title, a transcript): built-in rules, moderators' terms, and
 * the engine when there is one. An engine that cannot be reached leaves the rules' answer.
 */
export async function checkText(prisma: PrismaClient, config: AppConfig, text: string, signal?: AbortSignal, opts: { engine?: boolean } = {}): Promise<Decision> {
  const { scores } = scoreText(text, await moderatorTerms(prisma));
  const engine = engineOf(config);
  let engineScores: Scores = {};
  if (engine && opts.engine !== false && text.trim()) {
    try { engineScores = (await engine.check({ text }, signal)).scores; }
    catch (e) { if (signal?.aborted) throw e; log.warn(`text check: ${engine.name} unavailable: ${(e as Error).message}`); }
  }
  return decide(scores, engineScores);
}

/** The words of a WebVTT file, without numbers, timings and markup. */
export const vttText = (vtt: string) => vtt.split('\n').filter((l) => l.trim() && !/^WEBVTT|^\d+$|-->|^NOTE/.test(l.trim())).map((l) => l.replace(/<[^>]+>/g, '')).join('\n');

/**
 * What is said in a video (its automatic transcript, made after it is published): over the line, the video is hidden
 * (reviewHoldAt) and a moderator is asked, like a video many people reported. Returns whether it was held.
 */
export async function checkTranscript(prisma: PrismaClient, config: AppConfig, videoId: string, vtt: string, signal?: AbortSignal): Promise<boolean> {
  const verdict = await checkText(prisma, config, vttText(vtt).slice(0, 50_000), signal);
  if (!verdict.hold) return false;
  const held = await prisma.video.updateMany({ where: { id: videoId, reviewHoldAt: null, takenDownAt: null }, data: { reviewHoldAt: new Date() } });
  if (held.count) await prisma.report.create({ data: { videoId, reason: 'AUTOMATED_MATCH', details: `${verdict.reason} — in what is said (automatic transcript)`, priority: verdict.priority } });
  if (held.count) await feedsChanged();
  log.warn({ event: 'video_held_by_transcript', videoId, category: verdict.category });
  return true;
}

/** What a person is told when their comment or message is not posted. */
export const refusal = (d: Decision, what: 'comment' | 'message') =>
  `Your ${what} was not posted: it looks like ${d.category ? POLICY[d.category].label.toLowerCase() : 'it breaks the Community Guidelines'}, which the Community Guidelines do not allow. If this is a mistake, please change the wording.`;

export interface VideoVerdict extends Decision {
  /** Pictures were looked at by an engine (false: none configured, or it could not be reached). */
  scanned: boolean;
  /** Held only because no machine looked at the pictures and the uploader is new (SAFETY_UNSCANNED_REVIEW). */
  unscanned: boolean;
}

/**
 * The check a new video passes before anyone else can see it (run while it is being transcoded): its text, and its
 * pictures when an engine can look at them. Without one, the unscanned-video rule decides whether a person looks
 * first. `frames`: a few JPEGs across the video (base64), taken once and shared with the fingerprint scanner.
 */
export async function checkVideo(prisma: PrismaClient, config: AppConfig, video: { id: string; title: string; description: string | null; channelId: string; durationSeconds?: number },
  frames: () => Promise<string[]>, signal?: AbortSignal): Promise<VideoVerdict> {
  const tags = (await prisma.videoTag.findMany({ where: { videoId: video.id }, select: { tag: { select: { name: true } } } })).map((t) => t.tag.name);
  const text = videoText({ ...video, tags });
  const { scores } = scoreText(text, await moderatorTerms(prisma));
  const engine = engineOf(config);
  let pictures: Scores = {};
  let note: string | undefined;
  let scanned = false;
  if (engine?.images) {
    try {
      const fp = await prisma.video.findUnique({ where: { id: video.id }, select: { sourceSha256: true, sourceMd5: true, durationSeconds: true } });
      ({ scores: pictures, note } = await engine.check({ videoId: video.id, text, frames: await frames(), sha256: fp?.sourceSha256, md5: fp?.sourceMd5, durationSeconds: fp?.durationSeconds }, signal));
      scanned = true;
    }
    catch (e) {
      if (signal?.aborted) throw e;
      log.warn(`${video.id}: ${engine.name} unavailable: ${(e as Error).message}`);
      if (config.safety.failClosed) return { ...decide(scores), hold: true, category: null, score: 0, priority: 40, reason: 'The automatic check could not run; held until a moderator looks at it', scanned: false, unscanned: true };
    }
  }
  const d = decide(scores, pictures);
  if (d.hold && note) d.reason = note;
  if (d.hold || scanned) return { ...d, scanned, unscanned: false };
  if (await needsPerson(prisma, config, video.channelId)) {
    return { ...d, hold: true, priority: 30, reason: 'New Space: a moderator checks its first videos before they are shown (no automatic picture check is configured)', scanned: false, unscanned: true };
  }
  return { ...d, scanned: false, unscanned: false };
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
