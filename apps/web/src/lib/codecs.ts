'use client';

import { dataSaverActive } from './datasaver';

/**
 * Whether this device should play the AV1 versions of popular videos (about a third fewer bytes than H.264).
 * Yes when it decodes 720p AV1 smoothly in hardware; with data saver on (the viewer's choice, or a phone asking to
 * save data), smooth software decoding is enough, because the data saved matters more there than the battery.
 * Asked once per page load: MediaCapabilities is quick, but there is no reason to repeat it for every video.
 */
let answer: Promise<boolean> | null = null;
export function av1Preferred(): Promise<boolean> {
  answer ??= (async () => {
    try {
      const mc = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined;
      if (!mc?.decodingInfo) return false;
      const r = await mc.decodingInfo({ type: 'media-source', video: { contentType: 'video/mp4; codecs="av01.0.08M.08"', width: 1280, height: 720, bitrate: 1_800_000, framerate: 30 } });
      return r.supported && r.smooth && (r.powerEfficient || dataSaverActive());
    } catch { return false; }
  })();
  return answer;
}

/** The video codec family of an hls.js level ("av01", "avc1", …) from its codec set. */
export const codecFamily = (codecSet: string | undefined) => (codecSet ?? '').split(',').map((c) => c.trim().slice(0, 4)).find((c) => !c.startsWith('mp4a')) ?? '';
