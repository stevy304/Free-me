import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import type { AuthContext } from '../common/request';

/** A video the viewer may watch and interact with: ready, not removed, and public/unlisted or their own. */
export async function watchable(prisma: PrismaService, id: string, auth: AuthContext | null) {
  const v = await prisma.video.findUnique({ where: { id }, include: { channel: { select: { id: true, userId: true, handle: true, name: true } } } });
  if (!v || v.status !== 'READY' || v.takenDownAt) throw new NotFoundException('This video is not available.');
  if (v.visibility === 'PRIVATE' && v.channel.userId !== auth?.user.id) throw new NotFoundException('This video is not available.');
  return v;
}

/** Keyset cursor "<ISO date>_<id>" for lists ordered by a date and then id. */
export function parseDateCursor(cursor?: string) {
  if (!cursor) return null;
  const i = cursor.lastIndexOf('_');
  const at = new Date(cursor.slice(0, i));
  if (i < 0 || Number.isNaN(at.getTime())) return null;
  return { at, id: cursor.slice(i + 1) };
}
export const dateCursor = (at: Date, id: string) => `${at.toISOString()}_${id}`;
