'use client';

/**
 * Makes a phone video smaller before it is uploaded, in the browser (WebCodecs, through Mediabunny): H.264 at a
 * bitrate that still looks the same after Free Me's own processing, keyframes every 2 seconds (so the server can use
 * the result as its top quality without encoding it again), the sound kept as it is when it can be.
 *
 * Returns null whenever compressing is not worth it or not possible (old browser, already small, HDR, very long, an
 * error): the original is then uploaded, exactly as before.
 */

/** Video bitrate by the short side of the picture, in bits per second. */
const TARGET: Array<[number, number]> = [[360, 1_000_000], [480, 1_800_000], [720, 3_500_000], [1080, 6_000_000], [1440, 11_000_000], [Infinity, 20_000_000]];
/** Smaller than this, the upload is quick anyway. */
const MIN_BYTES = 20 * 1024 * 1024;
/** The result is kept in memory: phones run out of it beyond this. */
const MAX_OUTPUT_BYTES = 450 * 1024 * 1024;

export interface CompressPlan { width: number; height: number; seconds: number; targetBitsPerSecond: number; estimatedBytes: number }

export function targetBitrate(width: number, height: number) {
  const short = Math.min(width, height);
  return TARGET.find(([s]) => short <= s)![1];
}

/** Whether this browser can encode video at all (WebCodecs). */
export const canCompress = () => typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoDecoder' in window;

export async function compressVideo(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<{ file: File; plan: CompressPlan } | null> {
  if (!canCompress() || file.size < MIN_BYTES || !file.type.startsWith('video/') && !/\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)) return null;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return null;
    const seconds = await input.computeDuration();
    const width = video.displayWidth; const height = video.displayHeight;
    if (!(seconds > 0) || !width || !height) return null;
    // HDR (many recent phones): the browser cannot keep its colours in H.264; the server converts it properly.
    if (await video.hasHighDynamicRange().catch(() => true)) return null;
    const target = targetBitrate(width, height);
    const current = (file.size * 8) / seconds;
    // Already close to the target: nothing to win.
    if (current < target * 1.6) return null;
    const estimatedBytes = Math.round(((target + 160_000) * seconds) / 8 * 1.05);
    if (estimatedBytes > MAX_OUTPUT_BYTES) return null;
    if (!(await mb.canEncodeVideo('avc', { width, height, bitrate: target }))) return null;
    signal.throwIfAborted();

    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({
      input, output,
      video: { codec: 'avc', bitrate: target, keyFrameInterval: 2, forceTranscode: true },
      // Sound is copied when MP4 can hold it as it is; otherwise it becomes AAC.
      audio: { codec: 'aac' },
    });
    // Never upload a copy that lost its picture (or its sound) because this browser cannot read that track.
    if (!conversion.isValid || conversion.discardedTracks.some((d) => d.track.isVideoTrack() || d.track.isAudioTrack())) return null;
    conversion.onProgress = (p) => onProgress(Math.min(1, p));
    const stop = () => { void conversion.cancel(); };
    signal.addEventListener('abort', stop, { once: true });
    try { await conversion.execute(); } finally { signal.removeEventListener('abort', stop); }
    const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
    if (!buffer || buffer.byteLength > file.size * 0.8) return null; // not worth it
    const name = file.name.replace(/\.[^.]+$/, '') + '.mp4';
    return { file: new File([buffer], name, { type: 'video/mp4', lastModified: file.lastModified }), plan: { width, height, seconds, targetBitsPerSecond: target, estimatedBytes } };
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn('Compressing before upload failed; uploading the original.', e);
    return null;
  } finally {
    input.dispose?.();
  }
}
