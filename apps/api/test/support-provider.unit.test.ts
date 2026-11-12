import { FlutterwaveProvider } from '../src/billing/providers';

test('a provider response for another reference cannot fulfil a support checkout', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: {
    status: 'successful', amount: 3, currency: 'USD', tx_ref: 'another-checkout',
  } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const provider = new FlutterwaveProvider({ secretKey: 'test-key', baseUrl: 'https://provider.test', webhookHash: 'hash' });
    expect((await provider.check('expected-checkout', { amountMinor: 300n, currency: 'USD' })).status).toBe('FAILED');
  } finally { fetch.mockRestore(); }
});
