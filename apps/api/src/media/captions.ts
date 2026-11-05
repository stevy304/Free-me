import type { PrismaClient } from '@prisma/client';
import { mediaPrefix } from './keys';
import type { PutOptions, Storage } from './storage';

/** A caption file people can fix: the message is shown to the creator. */
export class CaptionError extends Error {}

export const CAPTION_MAX_BYTES = 1024 * 1024;
const MAX_CUES = 20_000;
const TIME = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

const seconds = (t: string) => {
  const [hms, frac = '0'] = t.replace(',', '.').split('.');
  const parts = hms.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + Number(`0.${frac.padEnd(3, '0')}`);
};
const stamp = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000); const m = Math.floor((ms % 3_600_000) / 60_000); const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

/** Cue text players may style; any other markup (and anything that looks like HTML) is dropped. */
const clean = (line: string) => line.replace(/<(?!\/?(?:b|i|u)>)[^>]*>/gi, '').replace(/-->/g, '→').trim();

/**
 * Reads WebVTT or SRT (what editors and caption services export) and returns clean WebVTT: times normalised,
 * settings, styles, notes and unknown markup removed, empty or backwards cues dropped.
 */
export function toWebVtt(input: string): { vtt: string; cues: number } {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const out: string[] = ['WEBVTT', ''];
  let cues = 0;
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIME.test(l));
    if (at < 0 || at > 1) continue; // header, NOTE, STYLE, REGION, or not a cue
    const m = TIME.exec(lines[at])!;
    const start = seconds(m[1]); const end = seconds(m[2]);
    const body = lines.slice(at + 1).map(clean).filter(Boolean).slice(0, 4).join('\n').slice(0, 500);
    if (!(end > start) || !body) continue;
    out.push(`${stamp(start)} --> ${stamp(end)}`, body, '');
    if (++cues > MAX_CUES) throw new CaptionError(`A caption file can have up to ${MAX_CUES.toLocaleString('en')} lines of captions.`);
  }
  if (!cues) throw new CaptionError('No captions were found in this file. Use a WebVTT (.vtt) or SubRip (.srt) file.');
  return { vtt: out.join('\n'), cues };
}

/**
 * Writes one file of a video where its media is now, and makes sure it stays there: if the media moved while
 * writing, it is written again in the new place. Moves copy thumbs/ and captions/ once more after switching, so a
 * file recorded before the switch is never lost.
 */
export async function putMediaFile(prisma: PrismaClient, storage: Storage, videoId: string, rel: string, body: Buffer, opts: PutOptions) {
  for (let attempt = 0; ; attempt++) {
    const { mediaLocation } = await prisma.video.findUniqueOrThrow({ where: { id: videoId }, select: { mediaLocation: true } });
    await storage.putBuffer(mediaPrefix(videoId, mediaLocation) + rel, body, opts);
    const still = await prisma.video.updateMany({ where: { id: videoId, mediaLocation }, data: { mediaLocation } });
    if (still.count) return;
    if (attempt >= 2) throw new Error('The video is being moved. Try again in a moment.');
  }
}

/** Folders a move copies a second time after switching places (files that can be written while a video moves). */
export const LATE_FOLDERS = ['thumbs/', 'captions/'];
