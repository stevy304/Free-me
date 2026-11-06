import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { publish, room } from '../realtime/publish';

/** Plain functions (no Nest), so the API and the media worker raise the same notifications. Never throw. */
const log = new Logger('Notify');
const safe = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { log.warn(`${what}: ${(e as Error).message}`); } };

/**
 * Tells a Space's followers about a video, once: the first time it is public, ready and not removed. Called when
 * processing finishes and when the creator publishes; whichever comes last does it.
 */
export function announceVideo(prisma: PrismaClient, videoId: string) {
  return safe(`announce ${videoId}`, async () => {
    const claimed = await prisma.video.updateMany({
      where: { id: videoId, announcedAt: null, status: 'READY', visibility: 'PUBLIC', takenDownAt: null, publishedAt: { not: null } },
      data: { announcedAt: new Date() },
    });
    if (!claimed.count) return;
    const v = await prisma.video.findUniqueOrThrow({ where: { id: videoId }, select: { channelId: true, channel: { select: { userId: true } } } });
    let cursor: string | undefined;
    for (;;) {
      const subs = await prisma.subscription.findMany({ where: { channelId: v.channelId }, select: { id: true, userId: true }, orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!subs.length) break;
      const to = subs.filter((s) => s.userId !== v.channel.userId);
      await prisma.notification.createMany({ data: to.map((s) => ({ userId: s.userId, type: 'NEW_VIDEO' as const, actorId: v.channel.userId, videoId })) });
      for (const s of to) publish(room.user(s.userId), 'notifications');
      cursor = subs.at(-1)!.id;
    }
  });
}

/** A new comment tells the video's creator; a reply tells the author of the comment it answers. Not for yourself. */
export function notifyComment(prisma: PrismaClient, c: { id: string; videoId: string; userId: string; parentId: string | null }, replyingTo: string | null) {
  return safe(`comment ${c.id}`, async () => {
    if (c.parentId && replyingTo && replyingTo !== c.userId) {
      await prisma.notification.create({ data: { userId: replyingTo, type: 'REPLY', actorId: c.userId, videoId: c.videoId, commentId: c.id } });
      publish(room.user(replyingTo), 'notifications');
    }
    const owner = (await prisma.video.findUnique({ where: { id: c.videoId }, select: { channel: { select: { userId: true } } } }))?.channel.userId;
    if (!c.parentId && owner && owner !== c.userId) {
      await prisma.notification.create({ data: { userId: owner, type: 'COMMENT', actorId: c.userId, videoId: c.videoId, commentId: c.id } });
      publish(room.user(owner), 'notifications');
    }
  });
}

/** Sparks on one video become one unread entry: "Ana and 12 others sparked …". */
export function notifySpark(prisma: PrismaClient, videoId: string, actorId: string) {
  return safe(`spark ${videoId}`, async () => {
    const owner = (await prisma.video.findUnique({ where: { id: videoId }, select: { channel: { select: { userId: true } } } }))?.channel.userId;
    if (!owner || owner === actorId) return;
    const open = await prisma.notification.findFirst({ where: { userId: owner, type: 'SPARK', videoId, readAt: null } });
    if (open) {
      if (open.actorId !== actorId) await prisma.notification.update({ where: { id: open.id }, data: { count: { increment: 1 }, actorId } });
    } else await prisma.notification.create({ data: { userId: owner, type: 'SPARK', actorId, videoId } });
    publish(room.user(owner), 'notifications');
  });
}
