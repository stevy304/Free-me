/** nginx's MPEG-TS media playlist. Reject external URLs and paths before signing or copying any object. */
export interface EncoderSegment { name: string; duration: number; sequence: number; tags: string[] }
export function encoderPlaylist(text: string) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Invalid encoder playlist.');
  const sequenceLine = lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  const start = sequenceLine ? Number(sequenceLine.split(':')[1]) : 0;
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid media sequence.');
  const headers: string[] = ['#EXTM3U'];
  const segments: EncoderSegment[] = [];
  let tags: string[] = [], duration = 0;
  for (const line of lines.slice(1)) {
    if (/^#EXT-X-(VERSION|TARGETDURATION|INDEPENDENT-SEGMENTS)(:|$)/.test(line)) { headers.push(line); continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:') || line === '#EXT-X-ENDLIST') continue;
    if (/^#EXT-X-(KEY|MAP|STREAM-INF|BYTERANGE)/.test(line)) throw new Error('Unsupported encoder playlist.');
    if (line.startsWith('#')) {
      tags.push(line);
      if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+\.ts$/.test(line) || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid encoder segment.');
    segments.push({ name: line, duration, sequence: start + segments.length, tags });
    tags = []; duration = 0;
  }
  return { headers, segments, nextSequence: start + segments.length, ended: lines.includes('#EXT-X-ENDLIST') };
}

export function publicEncoderPlaylist(text: string, from: number): { text: string; segments: EncoderSegment[] } | null {
  const parsed = encoderPlaylist(text);
  const segments = parsed.segments.filter((segment) => segment.sequence >= from);
  if (!segments.length) return null;
  return { segments, text: [...parsed.headers, `#EXT-X-MEDIA-SEQUENCE:${segments[0].sequence}`, ...segments.flatMap((s) => [...s.tags, s.name]), ...(parsed.ended ? ['#EXT-X-ENDLIST'] : [])].join('\n') + '\n' };
}
