import { AUDIO, masterPlaylist } from '../src/media/ladder';

test('master playlists list the shared audio codec once, including for previously published renditions', () => {
  const codec = 'avc1.64001f';
  const text = masterPlaylist([
    { name: '360p', width: 640, height: 360, bandwidth: 800_000, codecs: `${codec},${AUDIO.codecs}`, frameRate: 30, playlist: '360p/index.m3u8' },
  ], true);
  expect(text).toContain(`CODECS="${codec},${AUDIO.codecs}"`);
});
