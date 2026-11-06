import { Logger } from '@nestjs/common';
import type { PrismaClient, Video } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/config';
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

/** Up to 8 frames across the video, 640 px wide, for an outside matching service (perceptual hashes need pictures). */
async function frames(ffmpeg: string, source: string, info: ProbeResult, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const n = Math.max(1, Math.min(8, Math.floor(info.durationSeconds / 2)));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const file = join(dir, `${i}.jpg`);
    try {
      await run(ffmpeg, ['-hide_banner', '-y', '-ss', ((info.durationSeconds * (i + 0.5)) / n).toFixed(2), '-i', source, '-frames:v', '1', '-vf', 'scale=640:-2,format=yuvj420p', '-q:v', '4', file]);
      out.push((await readFile(file)).toString('base64'));
    } catch { /* a frame that cannot be read is skipped */ }
  }
  return out;
}

/**
 * The check every upload passes before anyone can see it. Records the file's fingerprints; holds the video when they
 * match blocked content (videos moderators removed, or an imported list), or when the outside scanner
 * (SAFETY_SCAN_URL, e.g. a PDQ/TMK matching service or a vendor) says so. A video a moderator released is not
 * checked again. Returns why it is held, or null.
 */
export async function screen(prisma: PrismaClient, config: AppConfig, video: Video, source: string, info: ProbeResult, work: string): Promise<string | null> {
  const log = new Logger('Screening');
  const { sha256, md5 } = await fingerprint(source);
  await prisma.video.update({ where: { id: video.id }, data: { sourceSha256: sha256, sourceMd5: md5 } });
  if (video.screeningClearedAt) return null;

  const hit = await prisma.blockedHash.findFirst({ where: { OR: [{ algorithm: 'SHA256', value: sha256 }, { algorithm: 'MD5', value: md5 }] } });
  if (hit) return hit.source === 'TAKEDOWN' ? 'Same file as a video moderators removed' : `Matches a blocked-content list${hit.note ? ` (${hit.note})` : ''}`;

  const s = config.safety;
  if (!s.scanUrl) return null;
  try {
    const body = JSON.stringify({ videoId: video.id, sha256, md5, durationSeconds: info.durationSeconds, frames: await frames(config.media.ffmpegPath, source, info, join(work, 'screen')) });
    const res = await fetch(s.scanUrl, { method: 'POST', body, signal: AbortSignal.timeout(s.timeoutMs), headers: { 'content-type': 'application/json', ...(s.scanToken ? { authorization: `Bearer ${s.scanToken}` } : {}) } });
    if (!res.ok) throw new Error(`scanner answered ${res.status}`);
    const verdict = (await res.json()) as { match?: boolean; label?: string };
    return verdict.match ? `Flagged by the automatic scan${verdict.label ? `: ${String(verdict.label).slice(0, 200)}` : ''}` : null;
  } catch (e) {
    log.warn(`${video.id}: scanner unavailable: ${(e as Error).message}`);
    return s.failClosed ? 'The automatic scan could not run; held until a moderator checks it' : null;
  }
}

/** Stops a held video before it is ever published and puts it in the moderators' queue. */
export async function hold(prisma: PrismaClient, videoId: string, why: string) {
  await prisma.$transaction(async (tx) => {
    await tx.video.update({ where: { id: videoId }, data: { status: 'FLAGGED', processingStage: 'Held for review', processingProgress: 0 } });
    const open = await tx.report.findFirst({ where: { videoId, reason: AUTOMATED_MATCH, status: { in: ['PENDING', 'INVESTIGATING'] } } });
    if (!open) await tx.report.create({ data: { videoId, reason: AUTOMATED_MATCH, details: why } });
  });
}
