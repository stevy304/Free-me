import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { ProgressBuffer } from '../media/progress';
import { KEY } from './signals';
import type { Taste } from './rank';

/**
 * A viewer's taste, from what they did (see ALGORITHM.md), kept in Redis for 30 minutes:
 *
 * - each of their last 200 videos counts by how much of it they watched (finished = 1, a 5% look = 0.05) and how
 *   recently (half as much after about three weeks): towards its topic, its Space and its tags;
 * - a "Spark" (like) adds to the video's topic and Space; "Not for me" hides the video and lowers its Space and topic;
 * - picked topics and followed Spaces always count.
 *
 * With personalisation turned off in Settings, only picked topics and followed Spaces are used.
 * Changing any of these (a like, a follow, new topics, the setting, clearing History) forgets the cached taste.
 */
const TTL = 30 * 60;
const DAY = 86_400_000;

const normalise = (m: Map<string, number>, keep: number) => {
  const top = [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, keep);
  const max = top[0]?.[1] ?? 1;
  return Object.fromEntries(top.map(([k, v]) => [k, Math.round((v / max) * 1000) / 1000]));
};
const add = (m: Map<string, number>, k: string | null | undefined, v: number) => { if (k) m.set(k, (m.get(k) ?? 0) + v); };

export async function buildTaste(prisma: PrismaClient, redis: Redis | null, userId: string, now = Date.now()): Promise<Taste> {
  const [profile, picked, follows] = await Promise.all([
    prisma.profile.findUnique({ where: { userId }, select: { personalizedRecommendations: true, preferredLanguage: true, country: true } }),
    prisma.userInterest.findMany({ where: { userId }, select: { categoryId: true } }),
    prisma.subscription.findMany({ where: { userId }, select: { channelId: true }, take: 500 }),
  ]);
  const taste: Taste = {
    topics: {}, channels: {}, tags: {}, picked: picked.map((p) => p.categoryId), follows: follows.map((f) => f.channelId),
    avoidChannels: {}, avoidTopics: {}, hidden: [], finished: [], started: [], seeds: [],
    language: profile?.preferredLanguage ?? null, country: profile?.country ?? null,
  };
  if (profile && !profile.personalizedRecommendations) return taste;

  // Flat rows in two queries (tags as an array): this runs for every viewer whose taste is not cached.
  type VideoBits = { categoryId: string | null; channelId: string; durationSeconds: number; tags: { tagId: string }[] };
  const bits = (r: { categoryId: string | null; channelId: string; durationSeconds: number; tags: string[] | null }): VideoBits => ({ categoryId: r.categoryId, channelId: r.channelId, durationSeconds: r.durationSeconds, tags: (r.tags ?? []).map((tagId) => ({ tagId })) });
  const [historyRows, reactionRows] = await Promise.all([
    prisma.$queryRaw<Array<{ videoId: string; progressSeconds: number; completed: boolean; lastWatchedAt: Date; categoryId: string | null; channelId: string; durationSeconds: number; tags: string[] | null }>>`
      SELECT h."videoId", h."progressSeconds", h."completed", h."lastWatchedAt", v."categoryId", v."channelId", v."durationSeconds",
        (SELECT array_agg(t."tagId") FROM (SELECT "tagId" FROM "VideoTag" WHERE "videoId" = v.id LIMIT 10) t) AS tags
      FROM (SELECT * FROM "WatchHistory" WHERE "userId" = ${userId} ORDER BY "lastWatchedAt" DESC LIMIT 200) h JOIN "Video" v ON v.id = h."videoId"
      ORDER BY h."lastWatchedAt" DESC`,
    prisma.$queryRaw<Array<{ videoId: string; isLike: boolean; categoryId: string | null; channelId: string; durationSeconds: number; tags: string[] | null }>>`
      SELECT l."videoId", l."isLike", v."categoryId", v."channelId", v."durationSeconds",
        (SELECT array_agg(t."tagId") FROM (SELECT "tagId" FROM "VideoTag" WHERE "videoId" = v.id LIMIT 10) t) AS tags
      FROM (SELECT * FROM "Like" WHERE "userId" = ${userId} ORDER BY "createdAt" DESC LIMIT 200) l JOIN "Video" v ON v.id = l."videoId"`,
  ]);
  const history = historyRows.map((r) => ({ videoId: r.videoId, progressSeconds: r.progressSeconds, completed: r.completed, lastWatchedAt: r.lastWatchedAt, video: bits(r) }));
  const reactions = reactionRows.map((r) => ({ videoId: r.videoId, isLike: r.isLike, video: bits(r) }));
  const video = { select: { categoryId: true, channelId: true, durationSeconds: true, tags: { select: { tagId: true }, take: 10 } } } as const;
  // Positions saved in the last seconds are not in the database yet: the newest of all, so they matter most.
  const pending = redis ? await new ProgressBuffer(prisma, redis).recent(userId) : new Map();
  const extra = [...pending.keys()].filter((id) => !history.some((h) => h.videoId === id));
  const extraVideos = extra.length ? await prisma.video.findMany({ where: { id: { in: extra } }, select: { id: true, ...video.select } }) : [];
  const watches = [
    ...extraVideos.map((v) => { const p = pending.get(v.id)!; return { videoId: v.id, progressSeconds: p.seconds, completed: p.completed, lastWatchedAt: p.at, video: v }; }),
    ...history.map((h) => { const p = pending.get(h.videoId); return p ? { ...h, progressSeconds: p.seconds, completed: p.completed, lastWatchedAt: p.at } : h; }),
  ].sort((a, b) => b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime());

  const topics = new Map<string, number>(); const channels = new Map<string, number>(); const tags = new Map<string, number>();
  for (const w of watches) {
    const watched = w.completed ? 1 : Math.min(1, w.progressSeconds / Math.max(1, w.video.durationSeconds));
    const weight = watched * Math.exp(-(now - w.lastWatchedAt.getTime()) / (30 * DAY));
    add(topics, w.video.categoryId, weight); add(channels, w.video.channelId, weight);
    for (const t of w.video.tags) add(tags, t.tagId, weight * 0.5);
    // Watched to 60% or more: done for "For you" (it is not offered again; "Continue watching" still has it).
    (w.completed || watched >= 0.6 ? taste.finished : taste.started).push(w.videoId);
    if (watched >= 0.3 && taste.seeds.length < 10) taste.seeds.push(w.videoId);
  }
  const avoidChannels = new Map<string, number>(); const avoidTopics = new Map<string, number>();
  for (const r of reactions) {
    if (r.isLike) { add(topics, r.video.categoryId, 1); add(channels, r.video.channelId, 1.5); for (const t of r.video.tags) add(tags, t.tagId, 0.5); }
    else { taste.hidden.push(r.videoId); add(avoidChannels, r.video.channelId, 1); add(avoidTopics, r.video.categoryId, 0.5); }
  }
  taste.topics = normalise(topics, 20); taste.channels = normalise(channels, 50); taste.tags = normalise(tags, 50);
  // "Not for me" twice for a Space counts fully; once, half.
  taste.avoidChannels = Object.fromEntries([...avoidChannels].map(([k, v]) => [k, Math.min(1, v / 2)]));
  taste.avoidTopics = Object.fromEntries([...avoidTopics].map(([k, v]) => [k, Math.min(1, v / 3)]));
  return taste;
}

export async function tasteFor(prisma: PrismaClient, redis: Redis | null, userId: string): Promise<Taste> {
  if (!redis) return buildTaste(prisma, null, userId);
  const cached = await redis.get(KEY.profile(userId));
  if (cached) return JSON.parse(cached) as Taste;
  const taste = await buildTaste(prisma, redis, userId);
  await redis.set(KEY.profile(userId), JSON.stringify(taste), 'EX', TTL);
  return taste;
}

/** Something that shapes a viewer's taste changed: their next "For you" is worked out again. */
export async function tasteChanged(redis: Redis | null, userId: string) {
  if (redis) await redis.del(KEY.profile(userId), KEY.feed(`u:${userId}`));
}
