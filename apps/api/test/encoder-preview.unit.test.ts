import { encoderPlaylist, publicEncoderPlaylist } from '../src/live/encoder-playlist';
import { ingestHealth, type IngestSample } from '../src/live/ingest-health';

const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:40\n#EXTINF:2,\n40.ts\n#EXTINF:2,\n41.ts\n#EXTINF:2,\n42.ts\n#EXT-X-ENDLIST\n';
test('publication excludes every rehearsal segment and preserves HLS sequence numbers', () => {
  expect(encoderPlaylist(text).nextSequence).toBe(43);
  const result = publicEncoderPlaylist(text, 42)!;
  expect(result.segments.map((s) => s.name)).toEqual(['42.ts']);
  expect(result.text).toContain('#EXT-X-MEDIA-SEQUENCE:42');
  expect(result.text).not.toContain('40.ts');
  expect(result.text).not.toContain('41.ts');
  expect(result.text).toContain('#EXT-X-ENDLIST');
  expect(publicEncoderPlaylist(text, 43)).toBeNull();
});
test.each(['../40.ts', 'https://evil.example/40.ts', '40.ts?key=secret', 'subdir/40.ts'])('rejects unsafe media references: %s', (name) => {
  expect(() => encoderPlaylist(text.replace('40.ts', name))).toThrow();
});
test('rejects key URLs, invalid durations and invalid sequence numbers', () => {
  expect(() => encoderPlaylist(text.replace('#EXT-X-VERSION:3', '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"'))).toThrow();
  expect(() => encoderPlaylist(text.replace('#EXTINF:2,', '#EXTINF:NaN,'))).toThrow();
  expect(() => encoderPlaylist(text.replace('SEQUENCE:40', 'SEQUENCE:-1'))).toThrow();
});
test('health distinguishes fresh media, missing audio, stale video and dead callbacks', () => {
  const now = Date.now();
  const sample: IngestSample = { sampledAt: new Date(now).toISOString(), lastSegmentAt: new Date(now).toISOString(), width: 1280, height: 720, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, deliveredKbps: 2800, segments: 2 };
  expect(ingestHealth(sample, new Date(now), true, now)).toMatchObject({ state: 'healthy', ready: true, warnings: [] });
  expect(ingestHealth({ ...sample, hasAudio: false, audioCodec: null }, new Date(now), true, now).warnings).toContain('No audio track detected. Check your microphone or encoder audio output.');
  expect(ingestHealth(sample, new Date(now), true, now + 12_000)).toMatchObject({ state: 'warning', ready: true });
  expect(ingestHealth(sample, new Date(now + 35_000), true, now + 35_000)).toMatchObject({ state: 'lost', ready: false });
  expect(ingestHealth(sample, new Date(now), true, now + 21_000)).toMatchObject({ state: 'lost', ready: false });
  expect(ingestHealth(null, new Date(now), true, now)).toMatchObject({ state: 'waiting', ready: false, sample: null });
  expect(ingestHealth(sample, new Date(now), false, now)).toMatchObject({ state: 'offline', ready: false, sample: null });
});
