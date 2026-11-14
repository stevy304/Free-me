import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * One picture follows a person everywhere (their videos, comments, Moments, messages): a Space without a picture of
 * its own shows its owner's profile picture, and follows it when it changes or is removed. A Space picture uploaded
 * for the Space itself always wins. Returns whether the Space's picture changed (feeds then need refreshing).
 */
export async function syncSpacePicture(prisma: PrismaClient | Prisma.TransactionClient, userId: string): Promise<boolean> {
  const profile = await prisma.profile.findUnique({ where: { userId }, select: { avatarUrl: true } });
  const url = profile?.avatarUrl ?? null;
  const r = await prisma.channel.updateMany({
    where: { userId, OR: [{ avatarUrl: null }, { avatarFromProfile: true }], NOT: { avatarUrl: url, avatarFromProfile: !!url } },
    data: { avatarUrl: url, avatarFromProfile: !!url },
  });
  return r.count > 0;
}
