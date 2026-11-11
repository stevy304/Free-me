import { makeQuote, readQuote } from '../src/billing/payouts';
import { FlutterwavePayoutSandbox } from '../src/billing/payout-sandbox';

test('quotes use whole RWF arithmetic and reject signature tampering', () => {
  const quote = makeQuote('channel', 3, 1234n, 1450, 100, 'secret');
  expect(quote.receiveRwf).toBe('17793');
  expect(readQuote(quote.token, 'secret')).toMatchObject({ channelId: 'channel', accountVersion: 3, amountCents: '1234' });
  const [payload, signature] = quote.token.split('.');
  const changed = Buffer.from(JSON.stringify({ ...quote, receiveRwf: '999999' })).toString('base64url');
  expect(() => readQuote(`${changed}.${signature}`, 'secret')).toThrow();
  expect(() => readQuote(`${payload}.wrong`, 'secret')).toThrow();
  expect(() => makeQuote('channel', 1, 1n, 1450, 100, 'secret')).toThrow();
});

test('sandbox rejects live credentials and validates every transfer field', async () => {
  const request = jest.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'success', data: { id: 7, currency: 'RWF', amount: 1000, reference: 'ref', account_number: '250788555444', status: 'SUCCESSFUL' } }), { status: 200 }));
  expect(() => new FlutterwavePayoutSandbox('FLWSECK-live', request as never)).toThrow();
  const provider = new FlutterwavePayoutSandbox('FLWSECK_TEST-mock', request as never);
  const expected = { phone: '250788555444', accountHolderName: 'Maker', amountRwf: 1000, reference: 'ref' };
  expect(await provider.check(7, expected)).toMatchObject({ status: 'SUCCEEDED', sandboxOnly: true });
  request.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', data: { id: 7, currency: 'USD', amount: 1000, reference: 'ref', account_number: expected.phone, status: 'SUCCESSFUL' } }), { status: 200 }));
  await expect(provider.check(7, expected)).rejects.toThrow('does not match');
  expect(request.mock.calls[0][0]).toBe('https://api.flutterwave.com/v3/transfers/7');
});
