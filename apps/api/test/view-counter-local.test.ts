import { ViewCounter } from '../src/media/views';

test('without Redis, duplicate views are ignored and video, daily and channel totals commit together', async () => {
  let now = 1000; jest.spyOn(Date, 'now').mockImplementation(() => now);
  const tx = { video: { update: jest.fn(async () => ({ channelId: 'channel' })) }, channel: { update: jest.fn() }, $executeRaw: jest.fn() };
  const prisma = { $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
  const counter = new ViewCounter(prisma as never, null);
  expect(await counter.addWatch('v', 'viewer', 20, 120)).toBe(0);
  expect(await counter.record('v', 'viewer', 30)).toBe(true);
  expect(await counter.record('v', 'viewer', 30)).toBe(false);
  expect(tx.channel.update).toHaveBeenCalledTimes(1);
  now += 10_000;
  expect(await counter.addWatch('v', 'viewer', 100, 120)).toBe(20);
  expect(await counter.addWatch('v', 'viewer', 100, 120)).toBe(0);
  expect(tx.video.update).toHaveBeenCalledWith({ where: { id: 'v' }, data: { watchTimeSeconds: { increment: 20 } } });
  jest.restoreAllMocks();
});
