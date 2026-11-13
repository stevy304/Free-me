import type { PrismaClient, RightsPolicy } from '@prisma/client';
import { findMatches, minimumMatch, saveFingerprint, type Fingerprint, type Match } from '../media/content-id';

/**
 * Content ID decisions (RIGHTS.md): which works are protected, and what a match does.
 *
 * - Every published video is protected from other accounts automatically: a match is blocked. Its owner can turn
 *   that off (ContentReference.active = false).
 * - A verified rights holder (Channel.rightsVerifiedAt) can choose per work: block, monetize (ads on the copy, their
 *   money goes to the owner) or track (shown, the owner sees it). Private videos can be registered as reference works.
 * - Only works older than the upload count (the earlier one is the original), never the uploader's own Space.
 */

export interface ClaimView { referenceVideoId: string; title: string; ownerHandle: string; ownerName: string; policy: RightsPolicy; matched: string; seconds: number }

/** The protected works among these videos, with the policy that applies to each. */
async function protectedWorks(prisma: PrismaClient, ids: string[], uploader: { channelId: string; createdAt: Date }) {
  const rows = await prisma.video.findMany({
    where: { id: { in: ids }, channelId: { not: uploader.channelId }, createdAt: { lt: uploader.createdAt }, takenDownAt: null },
    select: { id: true, title: true, status: true, visibility: true, publishedAt: true, safetyCheckedAt: true, contentReference: true,
      channel: { select: { id: true, handle: true, name: true, rightsVerifiedAt: true } } },
  });
  return rows.flatMap((v) => {
    const ref = v.contentReference;
    if (ref && !ref.active) return [];
    const published = v.status === 'READY' && v.visibility !== 'PRIVATE' && !!v.publishedAt && !!v.safetyCheckedAt;
    if (!ref && !published) return [];
    // Only a verified rights holder may let copies through (monetize or track); anyone else's works are blocked.
    const policy: RightsPolicy = ref && v.channel.rightsVerifiedAt ? ref.policy : 'BLOCK';
    return [{ id: v.id, title: v.title, policy, owner: v.channel }];
  });
}

const describe = (m: Match) => (m.picture && m.sound ? 'picture and sound' : m.picture ? 'picture' : 'sound');
const seconds = (m: Match) => Math.max(m.picture?.seconds ?? 0, m.sound?.seconds ?? 0);

/**
 * Fingerprints an upload, finds the protected works it matches and records a claim for each (claims an owner released
 * for this video stay released). Returns the claim that blocks it, if any.
 */
export async function claimUpload(prisma: PrismaClient, video: { id: string; channelId: string; createdAt: Date; durationSeconds: number }, fp: Fingerprint): Promise<{ blocked: ClaimView | null; claims: ClaimView[] }> {
  await saveFingerprint(prisma, video.id, fp);
  const matches = await findMatches(prisma, fp, minimumMatch(video.durationSeconds || fp.frames.length), [video.id]);
  if (!matches.length) return { blocked: null, claims: [] };
  const works = await protectedWorks(prisma, matches.map((m) => m.videoId), video);
  const released = new Set((await prisma.contentClaim.findMany({ where: { videoId: video.id, status: 'RELEASED' }, select: { referenceVideoId: true } })).map((c) => c.referenceVideoId));
  const claims: ClaimView[] = [];
  for (const w of works) {
    if (released.has(w.id)) continue;
    const m = matches.find((x) => x.videoId === w.id)!;
    const part = m.picture && (!m.sound || m.picture.seconds >= m.sound.seconds) ? m.picture : m.sound!;
    const data = { ownerChannelId: w.owner.id, policy: w.policy, matched: describe(m), matchedSeconds: seconds(m), uploadStart: part.uploadStart, referenceStart: part.referenceStart };
    await prisma.contentClaim.upsert({ where: { videoId_referenceVideoId: { videoId: video.id, referenceVideoId: w.id } }, create: { videoId: video.id, referenceVideoId: w.id, ...data }, update: data });
    claims.push({ referenceVideoId: w.id, title: w.title, ownerHandle: w.owner.handle, ownerName: w.owner.name, policy: w.policy, matched: data.matched, seconds: data.matchedSeconds });
  }
  // Blocked unless every blocking claim is in dispute? No: a dispute does not publish; the owner decides.
  const blocked = claims.find((c) => c.policy === 'BLOCK') ?? null;
  return { blocked, claims };
}

/** What the uploader reads when a match blocks their video. */
export const blockedReason = (c: ClaimView) =>
  `This video uses ${c.seconds} seconds of the ${c.matched} of “${c.title}” by @${c.ownerHandle}, who does not allow it to be used. If it is your own work, or you have permission, you can dispute the claim in Creator Hub → Rights.`;
