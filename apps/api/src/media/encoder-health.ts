import type { ChunkEncoder } from './chunks';
import { run } from './probe';

/** Listing encoders is insufficient: FFmpeg can list NVENC without a working driver/device. */
export async function verifyEncoder(ffmpeg: string, encoder: ChunkEncoder): Promise<void> {
  if (encoder === 'libx264') return;
  const codec = encoder === 'nvenc' ? 'h264_nvenc' : 'h264_qsv';
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=128x128:rate=1',
      '-frames:v', '1', '-vf', 'format=nv12', '-c:v', codec, '-f', 'null', '-'], undefined, AbortSignal.timeout(15_000));
  } catch (error) {
    throw new Error(`VIDEO_ENCODER=${encoder} failed its startup encode. Check the GPU, driver and FFmpeg build before accepting jobs: ${(error as Error).message}`);
  }
}
