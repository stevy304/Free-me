import { Logger } from '@nestjs/common';
import type { Comment, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/config';
import { checkText } from '../safety/check';
import { moderatorTerms, scoreText } from '../safety/rules';
import { notifyComment } from '../notifications/notify';
import { publish, room } from '../realtime/publish';

/**
 * Comments at scale (TRUST_AND_SAFETY.md). Waiting for the AI moderator on every comment would add seconds to posting
 * and cost the most of all checks, so comments are split by risk:
 *
 * - high risk (the word rules noticed something, or the account is under a week old): the AI decides before the
 *   comment is posted, as before;
 * - low risk: the word rules decide at once and the comment is shown; the AI checks it within seconds after, and
 *   removes it if it breaks the guidelines. Notifications (to the creator, or the person answered) wait for that check.
 *
 * A comment shown but not yet checked has `checkedAt` empty. If the API stops before checking it, the worker's sweep
 * checks it (sweepComments). Without an AI moderator every comment is decided by the rules at once.
 */
const log = new Logger('CommentCheck');
const NEW_ACCOUNT_MS = 7 * 86_400_000;
/** At most this many checks at once in one API process; the rest wait their turn. */
const CONCURRENCY = 8;

/** Whether a comment may be shown before the AI looks at it. */
export async function lowRisk(prisma: PrismaClient, text: string, author: { createdAt: Date }, now = Date.now()): Promise<boolean> {
  if (now - author.createdAt.getTime() < NEW_ACCOUNT_MS) return false;
  const { scores } = scoreText(text, await moderatorTerms(prisma));
  return Object.values(scores).every((v) => (v ?? 0) < 0.3);
}

/**
 * Removes a comment (its author, the creator, a moderator or the automatic check). A comment with replies stays as
 * "removed" so the thread still makes sense; one without is deleted.
 */
export async function removeComment(prisma: PrismaClient, c: Pick<Comment, 'id' | 'videoId' | 'parentId' | 'replyCount'>, reason: string | null = null) {
  await prisma.$transaction(async (tx) => {
    await tx.video.update({ where: { id: c.videoId }, data: { commentCount: { decrement: 1 } } });
    if (!c.parentId && c.replyCount > 0) { await tx.comment.update({ where: { id: c.id }, data: { deletedAt: new Date(), content: '', isPinned: false, removedReason: reason } }); return; }
    await tx.comment.delete({ where: { id: c.id } });
    if (c.parentId) {
      const p = await tx.comment.update({ where: { id: c.parentId }, data: { replyCount: { decrement: 1 } } });
      if (p.deletedAt && p.replyCount <= 0) await tx.comment.delete({ where: { id: p.id } });
    }
  });
  publish(room.video(c.videoId), 'comments', { videoId: c.videoId });
}

/**
 * The AI's check of a comment already shown. Returns what happened; 'retry' when the AI could not be asked (the
 * sweep tries again later).
 */
export async function checkCommentNow(prisma: PrismaClient, config: AppConfig, id: string, replyingTo?: string | null, signal?: AbortSignal): Promise<'kept' | 'removed' | 'retry' | 'gone'> {
  const c = await prisma.comment.findUnique({ where: { id } });
  if (!c || c.deletedAt || c.checkedAt) return 'gone';
  const verdict = await checkText(prisma, config, c.content, signal, { kind: 'comment' });
  if (!verdict.ai) return 'retry';
  // Claim it, so the sweep and this check never both act (the content may also have been edited meanwhile: an edit is
  // checked on its own, before it is saved).
  const claimed = await prisma.comment.updateMany({ where: { id, checkedAt: null, content: c.content }, data: { checkedAt: new Date() } });
  if (!claimed.count) return 'gone';
  if (verdict.hold) {
    await removeComment(prisma, c, verdict.ai.reason);
    log.log({ event: 'comment_removed_after_check', commentId: id, category: verdict.category, model: verdict.ai.model });
    return 'removed';
  }
  // The person answered (known when it was posted; for the sweep, the thread's author).
  const answered = replyingTo !== undefined ? replyingTo : c.parentId ? (await prisma.comment.findUnique({ where: { id: c.parentId }, select: { userId: true } }))?.userId ?? null : null;
  await notifyComment(prisma, c, answered);
  return 'kept';
}

let running = 0;
const waiting: Array<() => void> = [];

/** Checks a just-posted comment in the background, a few at a time. Failures are left to the sweep. */
export function checkCommentSoon(prisma: PrismaClient, config: AppConfig, id: string, replyingTo: string | null) {
  const go = async () => {
    running++;
    try { await checkCommentNow(prisma, config, id, replyingTo); }
    catch (e) { log.warn(`comment ${id}: ${(e as Error).message}`); }
    finally { running--; waiting.shift()?.(); }
  };
  if (running < CONCURRENCY) void go(); else waiting.push(() => void go());
}

/**
 * The worker's sweep: comments shown but not checked after 2 minutes (the API stopped, or the AI was unavailable).
 * After a day without a check they are left as the rules decided.
 */
export async function sweepComments(prisma: PrismaClient, config: AppConfig, now = Date.now()): Promise<{ checked: number; removed: number }> {
  const rows = await prisma.comment.findMany({ where: { checkedAt: null, deletedAt: null, createdAt: { lt: new Date(now - 2 * 60_000) } }, orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, createdAt: true } });
  let checked = 0; let removed = 0;
  for (const r of rows) {
    const result = await checkCommentNow(prisma, config, r.id).catch(() => 'retry' as const);
    if (result === 'retry' && now - r.createdAt.getTime() > 86_400_000) await prisma.comment.updateMany({ where: { id: r.id, checkedAt: null }, data: { checkedAt: new Date(now) } });
    if (result === 'kept' || result === 'removed') checked++;
    if (result === 'removed') removed++;
  }
  return { checked, removed };
}
