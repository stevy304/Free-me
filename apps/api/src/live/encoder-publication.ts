import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { encoderPlaylist } from './encoder-playlist';

/** Capture the boundary on the ingest host, not from a possibly delayed storage playlist. */
export async function beginEncoderPublication(prisma: PrismaClient, id: string, dir: string): Promise<number | null> {
  const text = await readFile(join(dir, 'index.m3u8'), 'utf8');
  // Also skip the segment currently being written: it may already contain rehearsal frames.
  const from = encoderPlaylist(text).nextSequence + 1;
  await prisma.liveStream.updateMany({ where: { id, status: 'LIVE', encoderStartSequence: null }, data: { encoderStartSequence: from } });
  return (await prisma.liveStream.findUnique({ where: { id }, select: { encoderStartSequence: true } }))?.encoderStartSequence ?? null;
}
