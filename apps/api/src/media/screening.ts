import type { PrismaClient, Video } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, type ProbeResult } from './probe';

/** Reason code of reports raised by the automatic upload check (not one people can choose). */
export const AUTOMATED_MATCH = 'AUTOMATED_MATCH';

/** SHA-256 and MD5 of a file in one pass (MD5 because shared industry lists still use it). */
export function fingerprint(path: string): Promise<{ sha256: string; md5: string }> {
  return new Promise((resolve, reject) => {
    const a = createHash('sha256'); const b = createHash('md5');
    createReadStream(path).on('data', (c) => { a.update(c); b.update(c); }).on('error', reject)
      .on('end', () => resolve({ sha256: a.digest('hex'), md5: b.digest('hex') }));
  });
}

/** How many pictures to take: one every `everySeconds`, at least what short videos always got, never more than `max`. */
export function frameCount(durationSeconds: number, everySeconds = 10, max = 48): number {
  const base = Math.max(1, Math.min(8, Math.floor(durationSeconds / 2)));
  return Math.max(base, Math.min(Math.max(1, max), Math.ceil(durationSeconds / Math.max(1, everySeconds))));
}

/**
 * Frames across the video, 640 px wide, for the safety check (the AI moderator, a picture classifier, an outside
 * matching service). Dense enough that a short explicit clip inside a long video is not stepped over: one every
 * `everySeconds` (default 10), at most `max` (default 48), taken 4 at a time so a long video is still checked in about a minute.
 */
export async function frames(ffmpeg: string, source: string, info: ProbeResult, dir: string, opts: { everySeconds?: number; max?: number } = {}): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const n = frameCount(info.durationSeconds, opts.everySeconds, opts.max);
  const out: Array<string | null> = new Array(n).fill(null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < n; i = next++) {
      const file = join(dir, `${i}.jpg`);
      try {
        await run(ffmpeg, ['-hide_banner', '-y', '-ss', ((info.durationSeconds * (i + 0.5)) / n).toFixed(2), '-i', source, '-frames:v', '1', '-vf', 'scale=640:-2,format=yuvj420p', '-q:v', '4', file]);
        out[i] = (await readFile(file)).toString('base64');
      } catch { /* a frame that cannot be read is skipped */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, n) }, worker));
  return out.filter((f): f is string => f !== null);
}

/**
 * The fingerprint check every upload passes first: records the file's SHA-256 and MD5 and holds the video when they
 * match blocked content (videos moderators removed, or an imported list such as an industry hash list). A video a
 * moderator released is not checked again. Returns why it is held, or null. What the video shows and says is checked
 * next, while it is being transcoded (safety/check.ts, which also calls the outside scanner, SAFETY_SCAN_URL).
 */
export async function screen(prisma: PrismaClient, video: Video, source: string): Promise<string | null> {
  const { sha256, md5 } = await fingerprint(source);
  await prisma.video.update({ where: { id: video.id }, data: { sourceSha256: sha256, sourceMd5: md5 } });
  if (video.screeningClearedAt) return null;
  const hit = await prisma.blockedHash.findFirst({ where: { OR: [{ algorithm: 'SHA256', value: sha256 }, { algorithm: 'MD5', value: md5 }] } });
  if (hit) return hit.source === 'TAKEDOWN' ? 'Same file as a video moderators removed' : `Matches a blocked-content list${hit.note ? ` (${hit.note})` : ''}`;
  return null;
}

/** Stops a held video before it is ever published and puts it in the moderators' queue. */
export async function hold(prisma: PrismaClient, videoId: string, why: string, priority = 40) {
  await prisma.$transaction(async (tx) => {
    await tx.video.update({ where: { id: videoId }, data: { status: 'FLAGGED', processingStage: 'Held for review', processingProgress: 0 } });
    const open = await tx.report.findFirst({ where: { videoId, reason: AUTOMATED_MATCH, status: { in: ['PENDING', 'INVESTIGATING'] } } });
    if (!open) await tx.report.create({ data: { videoId, reason: AUTOMATED_MATCH, details: why, priority } });
  });
}
