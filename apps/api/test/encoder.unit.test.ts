import { encoderCallback, validEncoderUrl } from '../src/live/encoder';

it('accepts nginx form metadata without trusting it', () => {
  expect(encoderCallback({ name: 'fm_valid-key', call: 'publish', app: 'live', flashver: 'FMLE/3.0', tcurl: 'rtmps://live.example/live', pageurl: '', swfurl: '', clientid: '7', time: '12', timestamp: '12000', customEncoderArgument: 'unused' })).toEqual({ name: 'fm_valid-key' });
});
it.each([undefined, null, [], {}, { name: ['key'] }, { name: '../key' }, { name: 'key\r\nLocation: bad' }, { name: 'k'.repeat(129) }])('rejects invalid stream names: %p', (body) => {
  expect(() => encoderCallback(body)).toThrow();
});
it.each(['rtmps://live.example:443/live', 'rtmp://127.0.0.1:1935/live'])('accepts an encoder server address: %s', (url) => expect(validEncoderUrl(url)).toBe(true));
it.each(['https://live.example/live', 'rtmp://live.example', 'rtmp://user:secret@live.example/live', 'rtmps://live.example/live?key=secret', 'rtmps://live.example/live#secret', 'rtmp://live .example/live', 'rtmp://live.example:wrong/live'])('rejects an invalid or credential-bearing address: %s', (url) => expect(validEncoderUrl(url)).toBe(false));
