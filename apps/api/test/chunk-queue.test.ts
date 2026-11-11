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
  const task = { videoId: 'video', run: 'pass', index: 0, niceness: 0, args: ['-c:v', 'libx264'] } as ChunkTask;
  const onDone = jest.fn();

  await expect(runner.runAll([task], onDone, abort.signal)).rejects.toBe(reason);
  expect(job.remove).toHaveBeenCalledTimes(1);
  expect(job.waitUntilFinished).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

function destination() {
  const events = { waitUntilReady: jest.fn().mockResolvedValue(undefined) };
  const job = { waitUntilFinished: jest.fn().mockResolvedValue({ index: 0, remote: true }), remove: jest.fn() };
  const queue = { addBulk: jest.fn().mockResolvedValue([job]) };
  return { queue, events, job };
}

test.each(['h264_nvenc', 'h264_qsv', 'libx264'])('%s pieces reach only compatible workers, including CPU fallback', async (codec) => {
  const cpu = destination(); const nvidia = destination(); const intel = destination();
  const routes = { libx264: cpu, nvenc: nvidia, qsv: intel };
  const runner = new QueueChunks(cpu.queue as unknown as Queue, cpu.events as unknown as QueueEvents,
    routes as unknown as ConstructorParameters<typeof QueueChunks>[2]);
  const task = { videoId: 'v', run: 'r', index: 0, niceness: 0, args: ['-c:v', codec] } as ChunkTask;
  const done = jest.fn();
  await expect(runner.runAll([task], done)).resolves.toEqual([{ index: 0, remote: true }]);
  const expected = codec === 'h264_nvenc' ? nvidia : codec === 'h264_qsv' ? intel : cpu;
  for (const route of Object.values(routes)) expect(route.queue.addBulk).toHaveBeenCalledTimes(route === expected ? 1 : 0);
  expect(expected.job.waitUntilFinished).toHaveBeenCalledWith(expected.events);
  expect(done).toHaveBeenCalledWith(1);
});

test('empty passes return immediately and mixed hardware passes are rejected before submission', async () => {
  const d = destination();
  const runner = new QueueChunks(d.queue as unknown as Queue, d.events as unknown as QueueEvents);
  await expect(runner.runAll([], jest.fn())).resolves.toEqual([]);
  await expect(runner.runAll([{ args: ['h264_nvenc'] }, { args: ['libx264'] }] as ChunkTask[], jest.fn())).rejects.toThrow('one encoder');
  expect(d.queue.addBulk).not.toHaveBeenCalled();
});
