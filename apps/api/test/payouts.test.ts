import request from 'supertest';
import { makeApp, resetDb, signIn, WEB } from './helpers';

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { ctx = await makeApp({ redis: false, adminEmails: ['payout-admin@example.com'], env: { PAYOUT_RWF_PER_USD: '1450', PAYOUT_FEE_RWF: '50', PAYOUT_MINIMUM_USD_CENTS: '100' } }); });
beforeEach(async () => { await resetDb(ctx.prisma); ctx.mail.outbox.length = 0; await ctx.clearLimits(); });
afterAll(async () => { await ctx.app.close(); });

async function setup() {
  const maker = (await signIn(ctx.http, ctx.mail, 'payout-maker@example.com')).agent;
  const admin = (await signIn(ctx.http, ctx.mail, 'payout-admin@example.com')).agent;
  const channel = (await maker.post('/api/channels').set('Origin', WEB).send({ handle: 'payout-maker', name: 'Maker' }).expect(201)).body.channel;
  await ctx.prisma.creatorBalance.create({ data: { channelId: channel.id, currency: 'USD', confirmedBalanceCents: 1000n, lifetimeEarningsCents: 1000n } });
  await maker.put('/api/hub/monetisation/payout-account').set('Origin', WEB).send({ country: 'RW', phone: '+254712345678', accountHolderName: 'Maker' }).expect(400);
  const account = (await maker.put('/api/hub/monetisation/payout-account').set('Origin', WEB).send({ country: 'RW', phone: '0788555444', accountHolderName: 'Maker' }).expect(200)).body.account;
  await maker.get('/api/hub/monetisation/payout-quote').expect(400);
  await maker.post(`/api/admin/billing/payout-accounts/${account.id}`).set('Origin', WEB).send({ version: 1, approve: true, note: 'Ownership checked.' }).expect(403);
  await admin.post(`/api/admin/billing/payout-accounts/${account.id}`).set('Origin', WEB).send({ version: 1, approve: true, note: 'Ownership checked.' }).expect(200);
  return { maker, admin, channel, account };
}

test('concurrent confirmations reserve once and concurrent rejection returns the balance once', async () => {
  const { maker, admin, channel } = await setup();
  const quote = (await maker.get('/api/hub/monetisation/payout-quote').expect(200)).body.quote;
  expect(quote).toMatchObject({ receiveRwf: '14450', feeRwf: 50, rwfPerUsd: 1450 });
  const replies = await Promise.all([1, 2].map(() => maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: quote.token })));
  expect(replies.map((r) => r.status)).toEqual([201, 201]);
  const id = replies[0].body.payout.id;
  expect(replies[1].body.payout.id).toBe(id);
  expect(await ctx.prisma.payout.count({ where: { channelId: channel.id } })).toBe(1);
  expect((await maker.get('/api/hub/monetisation')).body.balance).toMatchObject({ availableCents: 0, reservedCents: 1000, paidCents: 0 });
  const decisions = await Promise.all([1, 2].map(() => admin.post(`/api/admin/billing/payouts/${id}`).set('Origin', WEB).send({ action: 'reject', reason: 'Requested by creator.' })));
  expect(decisions.map((r) => r.status).sort()).toEqual([200, 400]);
  const balance = await ctx.prisma.creatorBalance.findUniqueOrThrow({ where: { channelId: channel.id } });
  expect(balance.confirmedBalanceCents).toBe(1000n);
  expect(await ctx.prisma.revenueLedger.count({ where: { sourceType: 'PAYOUT_REVERSAL', referenceId: id } })).toBe(1);
});

test('an account edit invalidates its review and previous quotes; other creators cannot use a quote', async () => {
  const { maker, admin, account } = await setup();
  const quote = (await maker.get('/api/hub/monetisation/payout-quote').expect(200)).body.quote;
  const other = (await signIn(ctx.http, ctx.mail, 'payout-other@example.com')).agent;
  await other.post('/api/channels').set('Origin', WEB).send({ handle: 'other-payout', name: 'Other' }).expect(201);
  await other.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: quote.token }).expect(403);
  const changed = (await maker.put('/api/hub/monetisation/payout-account').set('Origin', WEB).send({ country: 'RW', phone: '0788555444', accountHolderName: 'Maker Updated' }).expect(200)).body.account;
  expect(changed).toMatchObject({ status: 'PENDING', version: 2 });
  await admin.post(`/api/admin/billing/payout-accounts/${account.id}`).set('Origin', WEB).send({ version: 1, approve: true, note: 'Old review.' }).expect(400);
  await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: quote.token }).expect(400);
  expect((await request(ctx.http).get('/api/monetisation/availability')).body.countries[0]).toMatchObject({ code: 'RW', quotesEnabled: true });
});

test('expired quotes do not debit a balance and sandbox is administrator-only', async () => {
  const { maker, admin, channel } = await setup();
  const quote = (await maker.get('/api/hub/monetisation/payout-quote').expect(200)).body.quote;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  try { await maker.post('/api/hub/monetisation/payouts').set('Origin', WEB).send({ quoteToken: quote.token }).expect(400); }
  finally { clock.mockRestore(); }
  expect((await ctx.prisma.creatorBalance.findUniqueOrThrow({ where: { channelId: channel.id } })).confirmedBalanceCents).toBe(1000n);
  await maker.get('/api/admin/billing/payout-sandbox').expect(403);
  expect((await admin.get('/api/admin/billing/payout-sandbox').expect(200)).body).toMatchObject({ enabled: false, changesBalances: false });
});
