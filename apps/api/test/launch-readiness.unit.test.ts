import { SystemController } from '../src/admin/system.controller';

jest.mock('../src/billing/settings', () => ({ loadStored: jest.fn(async () => ({})), effective: jest.fn(() => ({})) }));
jest.mock('../src/auth/google-settings', () => ({ loadGoogleSettings: jest.fn(async () => null) }));

function setup(options: { inline?: boolean; upgrades?: number; redis?: string; databaseDown?: boolean; queueError?: boolean } = {}) {
  const query = options.databaseDown ? jest.fn().mockRejectedValue(new Error('offline')) : jest.fn().mockResolvedValue([{ value: 1 }]);
  const prisma = {
    $queryRaw: query,
    user: { count: options.databaseDown ? jest.fn().mockRejectedValue(new Error('offline')) : jest.fn().mockResolvedValue(1) },
    channel: { findFirst: jest.fn().mockResolvedValue(null) },
    appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const queue = { getWorkers: options.queueError ? jest.fn().mockRejectedValue(new Error('offline')) : jest.fn().mockResolvedValue([{}]) };
  const media = options.inline ? { queue: null, upgradeQueue: null } : {
    queue, upgradeQueue: { getWorkers: jest.fn().mockResolvedValue(Array.from({ length: options.upgrades ?? 1 }, () => ({}))) },
  };
  const config = { appUrl: 'https://example.com', media: { driver: 'local' }, mail: { transport: 'smtp', from: 'hello@example.com' } };
  return new SystemController(prisma as never, { ping: async () => options.redis ?? 'ok' } as never, media as never, config as never, {} as never);
}

test('a configured pilot passes required checks without implying scale validation', async () => {
  const result = await setup().launch();
  expect(result.ready).toBe(true);
  expect(result.checks.find((c) => c.id === 'upgrade-workers')?.ok).toBe(true);
});

test('API inline processing cannot pass public pilot readiness', async () => {
  const result = await setup({ inline: true, redis: 'not configured' }).launch();
  expect(result.ready).toBe(false);
  for (const id of ['workers', 'upgrade-workers', 'redis']) expect(result.checks.find((c) => c.id === id)?.ok).toBe(false);
});

test('a missing HD/4K worker blocks readiness even with a foreground worker', async () => {
  const result = await setup({ upgrades: 0 }).launch();
  expect(result.ready).toBe(false);
  expect(result.checks.find((c) => c.id === 'workers')?.ok).toBe(true);
  expect(result.checks.find((c) => c.id === 'upgrade-workers')?.ok).toBe(false);
});

test.each([{ redis: 'down' }, { databaseDown: true }, { queueError: true }])('dependency failure blocks readiness: %o', async (options) => {
  expect((await setup(options).launch()).ready).toBe(false);
});
