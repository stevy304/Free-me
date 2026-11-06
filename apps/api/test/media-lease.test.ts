import type { AppConfig } from '../src/config/config';
import { MediaJobs, VideoBusy } from '../src/media/jobs';

test('a worker renews its short lease and stops processing if ownership is lost', async () => {
  jest.useFakeTimers();
  try {
    const redis = { set: jest.fn(async () => 'OK'), eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0) };
    const prisma = { video: { updateMany: jest.fn() } };
    const jobs = new MediaJobs(prisma as never, {} as never, {} as AppConfig, redis as never);
    jest.spyOn(jobs.processor, 'process').mockImplementation(async (_id, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return { speech: null };
    });

    const failed = expect(jobs.transcode('video', true)).rejects.toBeInstanceOf(VideoBusy);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(redis.set).toHaveBeenCalledWith('fm:lock:video:video', expect.any(String), 'PX', 60_000, 'NX');
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('pexpire'), 1, 'fm:lock:video:video', expect.any(String), 60_000);
    await jest.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(redis.eval).toHaveBeenLastCalledWith(expect.stringContaining('del'), 1, 'fm:lock:video:video', expect.any(String));
    expect(prisma.video.updateMany).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
