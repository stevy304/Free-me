import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import type { AppConfig } from '../config/config';
import { putMediaFile, toWebVtt } from './captions';
import { run } from './probe';
import type { Storage } from './storage';

/** Languages Whisper writes (ISO 639-1, plus a few 639-3 codes some builds use); anything else is not stored. */
const CODE = /^[a-z]{2,3}$/;

/** The speech track for Whisper: 16 kHz mono PCM, the input it expects. */
export async function extractSpeech(ffmpeg: string, source: string, out: string, signal?: AbortSignal) {
  await run(ffmpeg, ['-hide_banner', '-y', '-i', source, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], undefined, signal);
}

/** Runs whisper.cpp; returns the language it heard (or was told) and the WebVTT it wrote. */
function whisper(bin: string, args: string[], signal?: AbortSignal): Promise<{ language: string | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let language: string | null = null;
    let tail = '';
    const watch = (d: Buffer) => {
      const s = d.toString();
      language ??= /auto-detected language:\s*([a-z]{2,3})\b/.exec(s)?.[1] ?? null;
      tail = (tail + s).slice(-4000);
    };
    p.stdout.on('data', watch); p.stderr.on('data', watch);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ language }) : reject(new Error(`whisper exited with ${code}: ${tail.slice(-1000)}`))));
  });
}

/**
 * Automatic captions for one video from its extracted speech, with whisper.cpp on the media server (no outside
 * service). The video's language is used when the creator set one; otherwise Whisper detects it. Captions the
 * creator uploaded are never replaced. Failures are logged and never affect the video itself.
 */
export async function autoCaptions(prisma: PrismaClient, storage: Storage, config: AppConfig, videoId: string, speech: string, signal?: AbortSignal) {
  const log = new Logger('Captions');
  const w = config.media.whisper;
  if (!w) return null;
  const outBase = speech.replace(/\.wav$/, '');
  try {
    const video = await prisma.video.findUnique({ where: { id: videoId }, select: { language: true, captions: { select: { language: true, source: true } } } });
    if (!video) return null;
    const told = video.language && CODE.test(video.language) ? video.language : null;
    if (told && video.captions.some((c) => c.language === told && c.source === 'UPLOADED')) return null;
    const { language: heard } = await whisper(w.bin, ['-m', w.model, '-f', speech, '-l', told ?? 'auto', '-t', String(w.threads), '-ovtt', '-of', outBase], signal);
    const language = told ?? heard;
    if (!language || !CODE.test(language)) { log.warn(`${videoId}: language not recognised; no automatic captions`); return null; }
    if (video.captions.some((c) => c.language === language && c.source === 'UPLOADED')) return null;
    const { vtt, cues } = toWebVtt(await readFile(`${outBase}.vtt`, 'utf8'));
    // Its own file name, so it can never overwrite captions the creator uploads at the same moment.
    const key = `captions/${language}.auto.vtt`;
    await putMediaFile(prisma, storage, videoId, key, Buffer.from(vtt), { contentType: 'text/vtt; charset=utf-8', cacheControl: 'public, max-age=300' });
    // Upload and automatic run can race: an upload that landed meanwhile wins.
    await prisma.$transaction(async (tx) => {
      const now = await tx.caption.findUnique({ where: { videoId_language: { videoId, language } } });
      if (now?.source === 'UPLOADED') return;
      await tx.caption.upsert({ where: { videoId_language: { videoId, language } }, create: { videoId, language, source: 'AUTO', key, cueCount: cues }, update: { source: 'AUTO', key, cueCount: cues } });
    });
    log.log(`${videoId}: automatic captions (${language}, ${cues} cues)`);
    return { language, cues };
  } catch (e) {
    log.warn(`${videoId}: automatic captions failed: ${(e as Error).message.slice(0, 300)}`);
    return null;
  } finally {
    await Promise.all([rm(speech, { force: true }), rm(`${outBase}.vtt`, { force: true })]).catch(() => undefined);
  }
}
