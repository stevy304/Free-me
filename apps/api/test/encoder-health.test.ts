import { verifyEncoder } from '../src/media/encoder-health';
import { run } from '../src/media/probe';
jest.mock('../src/media/probe', () => ({ run: jest.fn() }));
const encode = jest.mocked(run);
beforeEach(() => encode.mockReset());
test('CPU nodes need no GPU', async () => {
  await verifyEncoder('ffmpeg', 'libx264');
  expect(encode).not.toHaveBeenCalled();
});
test.each([['nvenc', 'h264_nvenc'], ['qsv', 'h264_qsv']] as const)('%s executes a real startup encode', async (encoder, codec) => {
  encode.mockResolvedValue({ stdout: '', stderr: '' });
  await verifyEncoder('ffmpeg', encoder);
  expect(encode).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining([codec, '-frames:v', '1']), undefined, expect.any(AbortSignal));
});
test('missing hardware fails before the worker consumes any jobs', async () => {
  encode.mockRejectedValue(new Error('Cannot load libcuda.so.1'));
  await expect(verifyEncoder('ffmpeg', 'nvenc')).rejects.toThrow('failed its startup encode');
});
