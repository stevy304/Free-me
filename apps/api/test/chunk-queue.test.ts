import type { Job, Queue, QueueEvents } from 'bullmq';
import { QueueChunks, type ChunkTask } from '../src/media/chunks';

test('cancellation during queue submission removes the submitted jobs without waiting for them', async () => {
  const abort = new AbortController();
  const reason = new Error('Processing canceled');
  const job = { remove: jest.fn().mockResolvedValue(undefined), waitUntilFinished: jest.fn() };
  const queue = {
    addBulk: jest.fn(async () => {
      abort.abort(reason);
      return [job as unknown as Job];
    }),
  };
  const events = { waitUntilReady: jest.fn().mockResolvedValue(undefined) };
  const runner = new QueueChunks(queue as unknown as Queue, events as unknown as QueueEvents);
  const task = { videoId: 'video', run: 'pass', index: 0, niceness: 0 } as ChunkTask;
  const onDone = jest.fn();

  await expect(runner.runAll([task], onDone, abort.signal)).rejects.toBe(reason);
  expect(job.remove).toHaveBeenCalledTimes(1);
  expect(job.waitUntilFinished).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});
