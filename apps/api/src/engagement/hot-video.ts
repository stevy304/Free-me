import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import type { AuthContext } from '../common/request';

/**
 * What the per-second endpoints of a playing video (view, watch time, resume position, playback health) need to
 * know about it, kept in this process for a few seconds. Every player of a popular video sends these, so without
 * it a video watched by 100,000 people at once is read from the database thousands of times a second for the same
 * row. Concurrent lookups of one video share a single query.
 *
 * Only for counting and progress: a change (made private, removed, deleted) is seen within TTL_MS here, which only
 * means a few more seconds of counting. Pages, playlists and comments keep reading the database.
 */
export interface HotVideo {
  id: string; status: string; visibility: string; takenDownAt: Date | null; reviewHoldAt: Date | null; safetyCheckedAt: Date | null;
  hlsMasterKey: string | null; durationSeconds: number; ownerId: string;
}
const TTL_MS = 10_000;
const MAX = 50_000;
const cache = new Map<string, { at: number; value: Promise<HotVideo | null> }>();

export function hotVideo(prisma: Pick<PrismaService, 'video'>, id: string, now = Date.now()): Promise<HotVideo | null> {
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = prisma.video.findUnique({ where: { id }, select: { id: true, status: true, visibility: true, takenDownAt: true, reviewHoldAt: true, safetyCheckedAt: true, hlsMasterKey: true, durationSeconds: true, channel: { select: { userId: true } } } })
    .then((v) => (v ? { id: v.id, status: v.status, visibility: v.visibility, takenDownAt: v.takenDownAt, reviewHoldAt: v.reviewHoldAt, safetyCheckedAt: v.safetyCheckedAt, hlsMasterKey: v.hlsMasterKey, durationSeconds: v.durationSeconds, ownerId: v.channel.userId } : null));
  // A failed query is not remembered: the next request asks again.
  value.catch(() => { if (cache.get(id)?.value === value) cache.delete(id); });
  cache.delete(id);
  cache.set(id, { at: now, value });
  // Oldest first (insertion order): drop the oldest when full.
  if (cache.size > MAX) for (const key of cache.keys()) { cache.delete(key); if (cache.size <= MAX * 0.9) break; }
  return value;
}

/** This process changed the video (visibility, removal, deletion): forget it at once here. */
export const forgetHotVideo = (id: string) => { cache.delete(id); };
export const clearHotVideos = () => cache.clear();

const unavailable = () => new NotFoundException('This video is not available.');

/** Same rules as `watchable`: ready, not removed, private ones only for their owner. */
export async function hotWatchable(prisma: Pick<PrismaService, 'video'>, id: string, auth: AuthContext | null): Promise<HotVideo> {
  const v = await hotVideo(prisma, id);
  if (!v || v.status !== 'READY' || v.takenDownAt) throw unavailable();
  if ((v.visibility === 'PRIVATE' || !v.safetyCheckedAt) && v.ownerId !== auth?.user.id) throw unavailable();
  return v;
}

/** Same rules as the playback controller's `viewable`: ready and playable; private or held ones only for their owner. */
export async function hotViewable(prisma: Pick<PrismaService, 'video'>, id: string, auth: AuthContext | null): Promise<HotVideo> {
  const v = await hotVideo(prisma, id);
  if (!v || v.status !== 'READY' || !v.hlsMasterKey) throw unavailable();
  if ((v.visibility === 'PRIVATE' || v.reviewHoldAt || !v.safetyCheckedAt) && v.ownerId !== auth?.user.id) throw unavailable();
  return v;
}
