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

/**
 * Frames across the video, for an outside matching service (perceptual hashes need pictures; up to 8, 640 px wide) or
 * the AI moderator (fewer and smaller, to keep its cost down: `opts`).
 */
export async function frames(ffmpeg: string, source: string, info: ProbeResult, dir: string, opts: { max?: number; size?: number } = {}): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const n = Math.max(1, Math.min(opts.max ?? 8, Math.floor(info.durationSeconds / 2)));
  // Longest side at most `size` px (vertical videos too), else 640 px wide.
  const scale = opts.size ? `scale=${opts.size}:${opts.size}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2` : 'scale=640:-2';
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const file = join(dir, `${i}.jpg`);
    try {
      await run(ffmpeg, ['-hide_banner', '-y', '-ss', ((info.durationSeconds * (i + 0.5)) / n).toFixed(2), '-i', source, '-frames:v', '1', '-vf', `${scale},format=yuvj420p`, '-q:v', '4', file]);
      out.push((await readFile(file)).toString('base64'));
    } catch { /* a frame that cannot be read is skipped */ }
  }
  return out;
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
