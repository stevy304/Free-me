import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../media/probe';
import { encoderPlaylist } from './encoder-playlist';

export interface IngestSample {
  sampledAt: string; lastSegmentAt: string; width: number | null; height: number | null;
  fps: number | null; videoCodec: string | null; audioCodec: string | null; hasAudio: boolean | null;
  deliveredKbps: number; segments: number;
}
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
export async function sampleIngest(dir: string, ffprobe: string): Promise<IngestSample | null> {
  const text = await readFile(join(dir, 'index.m3u8'), 'utf8').catch(() => null);
  if (!text) return null;
  const { segments } = encoderPlaylist(text);
  if (!segments.length) return null;
  const last = segments.at(-1)!;
  const files = await Promise.all(segments.slice(-3).map(async (s) => ({ segment: s, file: await stat(join(dir, s.name)) })));
  let width: number | null = null, height: number | null = null, fps: number | null = null;
  let videoCodec: string | null = null, audioCodec: string | null = null, hasAudio: boolean | null = null;
  try {
    const result = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate', '-of', 'json', join(dir, last.name)], undefined, AbortSignal.timeout(5000));
    const streams = JSON.parse(result.stdout).streams as Array<Record<string, unknown>>;
    const video = streams.find((s) => s.codec_type === 'video'), audio = streams.find((s) => s.codec_type === 'audio');
    width = positive(video?.width); height = positive(video?.height);
    for (const rate of [video?.avg_frame_rate, video?.r_frame_rate]) {
      if (typeof rate !== 'string') continue;
      const [n, d] = rate.split('/').map(Number); fps = positive(n / d); if (fps) break;
    }
    videoCodec = typeof video?.codec_name === 'string' ? video.codec_name : null;
    audioCodec = typeof audio?.codec_name === 'string' ? audio.codec_name : null; hasAudio = !!audio;
  } catch { /* Media freshness still works when probing fails; unknown metrics stay unknown. */ }
  const duration = files.reduce((sum, f) => sum + f.segment.duration, 0);
  return { sampledAt: new Date().toISOString(), lastSegmentAt: files.at(-1)!.file.mtime.toISOString(), width, height, fps, videoCodec, audioCodec, hasAudio,
    deliveredKbps: Math.round(files.reduce((sum, f) => sum + f.file.size, 0) * 8 / duration / 1000), segments: segments.length };
}

export function ingestHealth(sample: IngestSample | null, heartbeat: Date | null, connected: boolean, now = Date.now()) {
  if (!connected) return { state: 'offline', ready: false, sample: null, warnings: [] as string[] };
  const warnings: string[] = [];
  const mediaAge = sample ? now - new Date(sample.lastSegmentAt).getTime() : Infinity;
  const heartbeatAge = heartbeat ? now - heartbeat.getTime() : Infinity;
  const state = heartbeatAge > 20_000 || (sample && mediaAge > 30_000) ? 'lost' : !sample ? 'waiting' : mediaAge > 10_000 ? 'warning' : 'healthy';
  if (state === 'lost') warnings.push('The encoder signal is stale. Check your encoder and internet connection.');
  if (state === 'waiting') warnings.push('Waiting for playable video. The media worker must be running.');
  if (state === 'warning') warnings.push('New video segments are arriving slowly.');
  if (sample?.hasAudio === false) warnings.push('No audio track detected. Check your microphone or encoder audio output.');
  if (sample && !sample.videoCodec) warnings.push('Video format could not be measured yet.');
  if (sample?.videoCodec && sample.videoCodec !== 'h264') warnings.push('Use H.264 video for this ingest server.');
  if (sample?.audioCodec && sample.audioCodec !== 'aac') warnings.push('Use AAC audio for this ingest server.');
  const ready = (state === 'healthy' || state === 'warning') && sample?.videoCodec === 'h264' && (!sample.hasAudio || sample.audioCodec === 'aac');
  return { state, ready, sample, warnings };
}
