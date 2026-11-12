import { join } from 'node:path';

export const browserRenditions = [
  { playlist: '360p.m3u8', width: 640, height: 360, bitrate: 450, maxrate: 600, audio: 64, threads: 1, bandwidth: 740_000 },
  { playlist: '720p.m3u8', width: 1280, height: 720, bitrate: 2000, maxrate: 2500, audio: 96, threads: 2, bandwidth: 2_900_000 },
] as const;

/** `segmentSeconds`: 2 normally; 1 for low latency (a keyframe every segment, so players can start on any of them). */
export function browserLiveArgs(dir: string, segmentSeconds: 1 | 2 = 2) {
  const filters = browserRenditions.map(({ width, height }, i) =>
    `[v${i}]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[out${i}]`);
  return [
    '-hide_banner', '-loglevel', 'error', '-probesize', '256k', '-analyzeduration', '1000000', '-fflags', '+genpts', '-i', 'pipe:0',
    '-filter_complex_threads', '1', '-filter_complex', `[0:v]fps=30,split=2[v0][v1];${filters.join(';')}`,
    ...browserRenditions.flatMap((rendition, i) => [
      '-map', `[out${i}]`, '-map', '0:a:0?',
      '-c:v', 'libx264', '-threads:v', String(rendition.threads), '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-g', String(30 * segmentSeconds), '-keyint_min', String(30 * segmentSeconds), '-sc_threshold', '0', '-flags', '+cgop',
      '-b:v', `${rendition.bitrate}k`, '-maxrate', `${rendition.maxrate}k`, '-bufsize', `${rendition.maxrate * 2}k`,
      '-c:a', 'aac', '-b:a', `${rendition.audio}k`, '-ar', '48000', '-ac', '2',
      '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', join(dir, `${rendition.height}p_%05d.ts`), join(dir, rendition.playlist),
    ]),
  ];
}

export function browserLiveMaster() {
  return [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS',
    ...browserRenditions.flatMap(({ width, height, bandwidth, playlist }) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},FRAME-RATE=30.000`, playlist,
    ]),
    '',
  ].join('\n');
}
