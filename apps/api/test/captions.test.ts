import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';
import { CaptionError, toWebVtt } from '../src/media/captions';

// Captions with the local storage driver, and automatic captions with a stand-in for whisper.cpp that behaves like
// it: writes <-of>.vtt and reports the language it detected. Jobs run inside the API (no Redis).
const dir = mkdtempSync(join(tmpdir(), 'freeme-captions-'));
const storageDir = join(dir, 'storage');
const fakeWhisper = join(dir, 'whisper-cli');
const model = join(dir, 'ggml-base.bin');
const argsLog = join(dir, 'whisper-args.txt');
let ctx: Awaited<ReturnType<typeof makeApp>>;

beforeAll(async () => {
  writeFileSync(model, 'not a real model');
  writeFileSync(fakeWhisper, `#!/bin/bash
echo "$@" > ${argsLog}
of=""; lang="auto"
while [ $# -gt 0 ]; do case "$1" in -of) of="$2"; shift;; -l) lang="$2"; shift;; esac; shift; done
[ "$lang" = "auto" ] && lang="sw"
echo "whisper_full_with_state: auto-detected language: $lang (p = 0.93)" >&2
printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nHabari za asubuhi\\n\\n00:00:02.000 --> 00:00:04.000\\n<font color="red">Karibu</font>\\n' > "$of.vtt"
`);
  chmodSync(fakeWhisper, 0o755);
  ctx = await makeApp({ redis: false, storageDir, env: { WHISPER_CPP_PATH: fakeWhisper, WHISPER_MODEL: model, WHISPER_THREADS: '2' } });
}, 60_000);
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); });

test('SRT and WebVTT become clean WebVTT: times normalised, markup and notes dropped, bad cues skipped', () => {
  const srt = '﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>world</i>\r\n<script>alert(1)</script>there\r\n\r\n2\r\n00:00:05,000 --> 00:00:04,000\r\nBackwards\r\n\r\n3\r\n1:02:03,4 --> 1:02:05,000\r\nLate line\r\n';
  const { vtt, cues } = toWebVtt(srt);
  expect(cues).toBe(2);
  expect(vtt).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello <i>world</i>\nalert(1)there\n\n01:02:03.400 --> 01:02:05.000\nLate line\n');
  const webvtt = 'WEBVTT - title\n\nNOTE a note\n\nSTYLE\n::cue { color: red }\n\nintro\n00:00.000 --> 00:02.000 align:start\nHi --> there <c.yellow>you</c>\n';
  expect(toWebVtt(webvtt).vtt).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHi → there you\n');
  expect(() => toWebVtt('just some text')).toThrow(CaptionError);
});

async function readyVideo(email = 'maker@example.com', handle = 'maker') {
  const c = await signIn(ctx.http, ctx.mail, email);
  const ch = (await c.agent.post('/api/channels').set('Origin', WEB).send({ handle, name: 'Maker' }).expect(201)).body.channel;
  const v = await ctx.prisma.video.create({ data: { channelId: ch.id, title: 'Talk', durationSeconds: 10, status: 'READY', visibility: 'PRIVATE', mediaLocation: 'PRIVATE', hlsMasterKey: 'hls/master.m3u8' } });
  return { agent: c.agent, id: v.id };
}

test('creators add, replace and remove captions per language; viewers get them with the video\'s own access rules', async () => {
  const { agent, id } = await readyVideo();
  const put = (lang: string, body: string | Buffer) => agent.put(`/api/hub/videos/${id}/captions/${lang}`).set('Origin', WEB).set('Content-Type', 'application/x-subrip').send(body);
  await put('xx', '1\n00:00:01,000 --> 00:00:02,000\nHi\n').expect(400);
  await put('en', 'nothing useful').expect(400);
  await put('en', Buffer.alloc(1024 * 1024 + 10, 'a')).expect(400);
  const other = await signIn(ctx.http, ctx.mail, 'other@example.com');
  const otherPut = () => other.agent.put(`/api/hub/videos/${id}/captions/en`).set('Origin', WEB).set('Content-Type', 'text/vtt').send('WEBVTT\n\n00:00.000 --> 00:01.000\nx\n');
  await otherPut().expect(403); // not a creator
  await other.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'other', name: 'Other' }).expect(201);
  await otherPut().expect(404); // another creator's video

  const saved = (await put('en', '1\n00:00:01,000 --> 00:00:02,000\nHello\n').expect(200)).body.video;
  expect(saved.captions).toEqual([expect.objectContaining({ language: 'en', source: 'UPLOADED', cues: 1, url: `/api/videos/${id}/captions/en.vtt` })]);
  expect(existsSync(join(storageDir, 'prv', id, 'captions', 'en.vtt'))).toBe(true);

  // Private: only the owner; the watch data lists the track.
  const own = await agent.get(`/api/videos/${id}/captions/en.vtt`).expect(200);
  expect(own.headers['content-type']).toContain('text/vtt');
  expect(own.text).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  await request(ctx.http).get(`/api/videos/${id}/captions/en.vtt`).expect(404);
  expect((await agent.get(`/api/videos/${id}`)).body.video.captions).toEqual([{ language: 'en', auto: false, url: `/api/videos/${id}/captions/en.vtt` }]);

  // Public: anyone, cacheable. Unknown language: 404.
  await ctx.prisma.video.update({ where: { id }, data: { visibility: 'PUBLIC', mediaLocation: 'PUBLIC', publishedAt: new Date() } });
  await put('en', 'WEBVTT\n\n00:00.000 --> 00:03.000\nHello again\n').expect(200);
  const pub = await request(ctx.http).get(`/api/videos/${id}/captions/en.vtt`).expect(200);
  expect(pub.headers['cache-control']).toBe('public, max-age=300');
  expect(pub.text).toContain('Hello again');
  await request(ctx.http).get(`/api/videos/${id}/captions/fr.vtt`).expect(404);
  await request(ctx.http).get(`/api/videos/${id}/captions/../../x`).expect(404);

  expect((await agent.delete(`/api/hub/videos/${id}/captions/en`).set('Origin', WEB).expect(200)).body.video.captions).toEqual([]);
  expect(existsSync(join(storageDir, 'pub', id, 'captions', 'en.vtt'))).toBe(false);
  await agent.delete(`/api/hub/videos/${id}/captions/en`).set('Origin', WEB).expect(404);
});

test('automatic captions after processing: language detected, stored as automatic; an upload replaces them; uploads are never overwritten', async () => {
  const clip = join(dir, 'talk.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', clip]);
  const c = await signIn(ctx.http, ctx.mail, 'maker@example.com');
  await c.agent.post('/api/channels').set('Origin', WEB).send({ handle: 'maker', name: 'Maker' }).expect(201);
  const data = readFileSync(clip);
  const start = (await c.agent.post('/api/uploads').set('Origin', WEB).send({ fileName: 'talk.mp4', sizeBytes: data.length }).expect(201)).body;
  const urls = (await c.agent.post(`/api/uploads/${start.videoId}/parts`).set('Origin', WEB).send({ partNumbers: [1] }).expect(200)).body.urls;
  const etag = (await c.agent.put(urls[1].replace(WEB, '')).set('Origin', WEB).set('Content-Type', 'application/octet-stream').send(data).expect(200)).headers.etag;
  await c.agent.post(`/api/uploads/${start.videoId}/complete`).set('Origin', WEB).send({ parts: [{ partNumber: 1, etag }] }).expect(200);
  const id = start.videoId as string;

  let caps: any[] = [];
  for (let i = 0; i < 200 && !caps.length; i++) { await new Promise((r) => setTimeout(r, 300)); caps = (await c.agent.get(`/api/hub/videos/${id}`)).body.video.captions; }
  expect(caps).toEqual([expect.objectContaining({ language: 'sw', source: 'AUTO', cues: 2 })]);
  expect(readFileSync(argsLog, 'utf8')).toContain('-l auto');
  const vtt = (await c.agent.get(`/api/videos/${id}/captions/sw.vtt`).expect(200)).text;
  expect(vtt).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHabari za asubuhi\n\n00:00:02.000 --> 00:00:04.000\nKaribu\n');
  expect(existsSync(join(storageDir, 'prv', id, 'captions', 'sw.auto.vtt'))).toBe(true);
  expect(existsSync(join(ctx.config.media.scratchDir, `${id}.speech.wav`))).toBe(false); // cleaned up
  expect((await c.agent.get(`/api/videos/${id}`)).body.video.captions).toEqual([{ language: 'sw', auto: true, url: `/api/videos/${id}/captions/sw.vtt` }]);

  // The creator's own file replaces the automatic one (and its file).
  await c.agent.put(`/api/hub/videos/${id}/captions/sw`).set('Origin', WEB).set('Content-Type', 'text/vtt').send('WEBVTT\n\n00:00.000 --> 00:04.000\nHabari, rafiki\n').expect(200);
  expect(existsSync(join(storageDir, 'prv', id, 'captions', 'sw.auto.vtt'))).toBe(false);

  // Running again (e.g. re-processing) with the video's language set: Whisper is told it, and the upload stays.
  await ctx.prisma.video.update({ where: { id }, data: { language: 'sw' } });
  const { MediaJobs } = await import('../src/media/jobs');
  const { STORAGE } = await import('../src/media/queue');
  await new MediaJobs(ctx.prisma, ctx.app.get(STORAGE), ctx.config, null).transcode(id, true);
  expect((await c.agent.get(`/api/videos/${id}/captions/sw.vtt`)).text).toContain('Habari, rafiki');
  await ctx.prisma.video.update({ where: { id }, data: { language: 'fr' } });
  await new MediaJobs(ctx.prisma, ctx.app.get(STORAGE), ctx.config, null).transcode(id, true);
  expect(readFileSync(argsLog, 'utf8')).toContain('-l fr');
  expect((await c.agent.get(`/api/hub/videos/${id}`)).body.video.captions.map((x: any) => `${x.language}:${x.source}`)).toEqual(['fr:AUTO', 'sw:UPLOADED']);
}, 180_000);
