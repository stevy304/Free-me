import type { PlannedRung } from './ladder';

/**
 * AV1 renditions for popular videos. AV1 carries the same picture in roughly a third fewer bytes than H.264, so for
 * a video watched often, encoding it once more pays for itself many times over in delivery (the largest cost at
 * scale) and in viewers' mobile data. It is several times slower to encode than H.264, so it is made only for
 * videos that reach AV1_MIN_VIEWS, after their H.264 ladder is complete, and only adds to it: every device keeps the
 * H.264 renditions, and a player that decodes AV1 well uses the AV1 ones instead (hls.js keeps to one codec per
 * playback, so it never switches codec mid-video).
 *
 * Files: hls/av1-<rung>/ beside hls/<rung>/, same 4-second fMP4 segments, same shared audio rendition.
 */
export const AV1_DIR = (rung: string) => `av1-${rung}`;

/** AV1 needs this share of the H.264 bitrate for a similar picture (conservative: SVT-AV1 at preset 8 does better). */
export const AV1_BITRATE_SHARE = 0.65;

/** The AV1 version of an H.264 rung: same size, lower bitrate ceiling. */
export function av1Rung(r: PlannedRung): PlannedRung {
  const videoKbps = Math.round(r.videoKbps * AV1_BITRATE_SHARE);
  return { ...r, copy: undefined, videoKbps, maxKbps: Math.round(r.maxKbps * AV1_BITRATE_SHARE) };
}

/**
 * SVT-AV1 settings for one rung: capped CRF (quality first, with a ceiling for players' bandwidth estimates), a
 * fixed 2-second keyframe interval with scene cuts off (every rung cuts its 4-second segments at the same times),
 * visual-quality tuning, and fast-decode, which makes playback easier for phones that decode AV1 in software.
 */
export function av1Args(r: PlannedRung, fps: number, settings: { preset: number; crf: number }): string[] {
  const gop = Math.max(1, Math.round(Math.min(60, fps) * 2));
  // Small pictures get a slightly lower CRF: each pixel matters more on a phone showing 240p or 360p.
  const crf = r.short <= 360 ? Math.max(10, settings.crf - 2) : settings.crf;
  return ['-c:v', 'libsvtav1', '-preset', String(settings.preset), '-crf', String(crf), '-g', String(gop), '-pix_fmt', 'yuv420p',
    '-svtav1-params', `tune=0:scd=0:fast-decode=1:mbr=${r.maxKbps}`];
}

/** RFC 6381 codec string for 8-bit 4:2:0 AV1 Main profile at the stream's level (seq_level_idx, as ffprobe reports it). */
export function av1Codecs(seqLevelIdx: number): string {
  return `av01.0.${String(Math.max(0, Math.min(31, seqLevelIdx))).padStart(2, '0')}M.08`;
}

/** The level a rung needs when the encoder's own level is not known (AV1 spec, Annex A: picture size and rate). */
export function av1LevelFor(width: number, height: number, fps: number): number {
  const px = width * height;
  const fast = fps > 30;
  if (px <= 147_456) return 0; // 2.0
  if (px <= 278_784) return 4; // 3.0
  if (px <= 665_856) return 5; // 3.1
  if (px <= 2_228_224) return fast ? 9 : 8; // 4.0 / 4.1
  return fast ? 13 : 12; // 5.0 / 5.1
}
