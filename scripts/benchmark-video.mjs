import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [phone, hd, uhd] = process.argv.slice(2);
const origin = new URL(process.env.BENCH_ORIGIN || 'http://localhost:4000').origin;
const cookie = process.env.BENCH_COOKIE;
const logs = [process.env.BENCH_API_LOG, process.env.BENCH_WORKER_LOG].filter(Boolean);
const timeout = Number(process.env.BENCH_TIMEOUT_MS || 900_000);
if (!phone || !hd || !uhd || !cookie || !logs.length || !Number.isFinite(timeout) || timeout <= 0) {
  console.error('Set BENCH_COOKIE and BENCH_API_LOG, then run npm run bench:video -- phone.mp4 hd.mp4 uhd.mp4.');
  process.exit(1);
}

async function request(path, options = {}, authenticate = true) {
  const url = new URL(path, origin);
  const headers = new Headers(options.headers);
  // Keep account credentials off signed storage URLs, including local storage.
  if (authenticate && url.origin === origin) headers.set('Cookie', cookie);
  headers.set('Origin', origin);
  const result = await fetch(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!result.ok) throw new Error(`${options.method ?? 'GET'} ${authenticate ? url.pathname : 'storage'} returned ${result.status}`);
  return result;
}

const post = (path, body) => request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

async function upload(file, label) {
  const { size } = await stat(file);
  const started = performance.now();
  const { videoId, partSize, partCount, parallelLimit } = await post('/api/uploads', {
    fileName: `bench-${label}-${basename(file)}`, sizeBytes: size,
  });
  const width = Math.min(parallelLimit ?? 4, 4);
  const parts = [];
  for (let first = 1; first <= partCount; first += width) {
    const partNumbers = Array.from({ length: Math.min(width, partCount - first + 1) }, (_, i) => first + i);
    const { urls } = await post(`/api/uploads/${videoId}/parts`, { partNumbers });
    const batch = await Promise.all(partNumbers.map(async (partNumber) => {
      const start = (partNumber - 1) * partSize;
      const length = Math.min(partSize, size - start);
      const body = createReadStream(file, { start, end: start + length - 1 });
      try {
        const result = await request(urls[partNumber], {
          method: 'PUT', body, duplex: 'half',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
        }, false);
        const etag = result.headers.get('etag');
        await result.arrayBuffer();
        if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);
        return { partNumber, etag };
      } finally {
        body.destroy();
      }
    }));
    parts.push(...batch);
  }
  const transferMs = Math.max(1, Math.round(performance.now() - started));
  const finalizedAt = Date.now();
  await post(`/api/uploads/${videoId}/complete`, {
    parts, transfer: { bytes: size, durationMs: transferMs, retries: 0, peakParallel: Math.min(width, partCount) },
  });
  return { videoId, sourceBytes: size, transferMs, finalizedAt, finalizeRoundTripMs: Date.now() - finalizedAt };
}

async function eventsFor(videoId) {
  const contents = await Promise.all(logs.map((log) => readFile(log, 'utf8')));
  const events = [];
  for (const line of contents.join('\n').split('\n')) {
    if (!line.includes(videoId)) continue;
    try {
      const { message, timestamp } = JSON.parse(line);
      if (message?.videoId === videoId) events.push({ ...message, timestamp });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return events;
}

async function waitFor(label, check) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const result = await check();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const inspect = (id) => request(`/api/hub/videos/${id}`).then((r) => r.json()).then(({ video }) => {
  if (video.status === 'FAILED' || video.processingError) {
    throw new Error(`Video ${id} failed: ${video.processingError || video.processingStage}`);
  }
  return video;
});
const uri = (playlist) => playlist.split(/\r?\n/).find((line) => line && !line.startsWith('#'));

async function verifyPlayback(playbackUrl) {
  const masterUrl = new URL(playbackUrl, origin);
  const master = await request(masterUrl).then((r) => r.text());
  if (!master.startsWith('#EXTM3U') || !uri(master)) throw new Error('Missing HLS video variant');
  const variantUrl = new URL(uri(master), masterUrl);
  const variant = await request(variantUrl).then((r) => r.text());
  if (!variant.startsWith('#EXTM3U') || !uri(variant)) throw new Error('Missing HLS video segment');
  const segment = await request(new URL(uri(variant), variantUrl), {}, false).then((r) => r.arrayBuffer());
  if (!segment.byteLength) throw new Error('Empty HLS video segment');
}

async function measure(label, file, hdTarget) {
  const result = await upload(file, label);
  let firstHdObservedMs;
  let targetObservedMs;
  let playbackVerifiedMs;
  const video = await waitFor(`${label} processing`, async () => {
    const video = await inspect(result.videoId);
    if (firstHdObservedMs === undefined && video.renditions.includes('720p')) firstHdObservedMs = Date.now() - result.finalizedAt;
    if (targetObservedMs === undefined && video.renditions.includes(hdTarget)) targetObservedMs = Date.now() - result.finalizedAt;
    if (playbackVerifiedMs === undefined && video.playbackUrl) {
      await verifyPlayback(video.playbackUrl);
      playbackVerifiedMs = Date.now() - result.finalizedAt;
    }
    return video.processingStage === 'Ready' && video.processingProgress === 100 ? video : null;
  });
  if (targetObservedMs === undefined || firstHdObservedMs === undefined || playbackVerifiedMs === undefined) throw new Error(`${label} never reached verified playback and ${hdTarget}`);
  const allQualitiesObservedMs = Date.now() - result.finalizedAt;
  const events = await waitFor(`${label} completion log`, async () => {
    const entries = await eventsFor(result.videoId);
    return entries.some((entry) => entry.event === 'video_processing_complete') ? entries : null;
  });
  const started = events.find((e) => e.event === 'transcode_started' && e.attempt === 1);
  const playable = events.find((e) => e.event === 'video_first_playable');
  const complete = events.find((e) => e.event === 'video_processing_complete');
  if (!started || !playable || !complete) throw new Error(`Missing JSON pipeline events for ${result.videoId}; check BENCH_API_LOG and BENCH_WORKER_LOG`);
  const { finalizedAt, ...timing } = result;
  return {
    label, ...timing, transferMiBps: Number((result.sourceBytes / 1048576 / (result.transferMs / 1000)).toFixed(2)),
    queueWaitMs: started.queueWaitMs, processingToPlayableMs: playable.processingToPlayableMs,
    sdEncodeMs: playable.sdEncodeMs, playbackVerifiedMs, firstHdObservedMs, target: hdTarget, targetObservedMs,
    allQualitiesObservedMs, renditions: video.renditions,
    copiedRendition: complete.copied, encodePassMs: Object.fromEntries(Object.entries(complete).filter(([key]) => key.startsWith('encode_'))),
  };
}

try {
  const load = await upload(uhd, 'background');
  await waitFor('background HD processing', async () => {
    const video = await inspect(load.videoId);
    if (video.processingStage === 'Ready') throw new Error('Background video finished before measurements started; use a longer UHD fixture');
    if (process.env.BENCH_WORKER_LOG) return (await eventsFor(load.videoId)).some((e) => e.event === 'upgrade_started');
    return video.playbackUrl;
  });
  const start = Date.now();
  const results = await Promise.allSettled([
    measure('phone', phone, '720p'), measure('1080p', hd, '1080p'), measure('4k', uhd, '2160p'),
  ]);
  const backgroundEvents = await eventsFor(load.videoId);
  const backgroundEnd = backgroundEvents.find((e) => e.event === 'video_processing_complete')?.timestamp;
  if (backgroundEnd && backgroundEnd <= start) throw new Error('Background encoding did not overlap benchmark start');
  const failures = results.filter((result) => result.status === 'rejected');
  console.log(JSON.stringify({
    queueMode: process.env.BENCH_WORKER_LOG ? 'redis-worker' : 'inline-api',
    backgroundVideoId: load.videoId,
    backgroundOverlapMs: backgroundEnd ? backgroundEnd - start : null,
    results: results.filter((result) => result.status === 'fulfilled').map((result) => result.value),
    failures: failures.map((result) => result.reason.message),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
