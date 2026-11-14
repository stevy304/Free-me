import { AUDIO, masterPlaylist } from '../src/media/ladder';

test('master playlists list the shared audio codec once, including for previously published renditions', () => {
  const codec = 'avc1.64001f';
  const text = masterPlaylist([
    { name: '360p', width: 640, height: 360, bandwidth: 800_000, codecs: `${codec},${AUDIO.codecs}`, frameRate: 30, playlist: '360p/index.m3u8' },
  ], true);
  expect(text).toContain(`CODECS="${codec},${AUDIO.codecs}"`);
});

test('weak connections: the smallest rungs take the lighter audio only when the video has it', () => {
  const rung = (name: string, short: number, kbps: number) => ({ name, width: Math.round((short * 16) / 9), height: short, bandwidth: kbps * 1000, codecs: 'avc1.64001e', frameRate: 30, playlist: `${name}/index.m3u8` });
  const ladder = [rung('144p', 144, 200), rung('240p', 240, 500), rung('360p', 360, 1000)];
  const withLow = masterPlaylist(ladder, true, true);
  expect(withLow).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-low",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio-low/index.m3u8"');
  expect(withLow).toMatch(/BANDWIDTH=264000,[^\n]*NAME="144p",AUDIO="aud-low"/);
  expect(withLow).toMatch(/BANDWIDTH=1128000,[^\n]*NAME="360p",AUDIO="aud"/);
  // An older video without the lighter audio: one audio group for every rung, as before.
  const without = masterPlaylist(ladder, true, false);
  expect(without).not.toContain('aud-low');
  expect(without).toMatch(/BANDWIDTH=328000,[^\n]*NAME="144p",AUDIO="aud"/);
  // No audio at all: no groups.
  expect(masterPlaylist(ladder, false, true)).not.toContain('EXT-X-MEDIA');
});
