import { BadRequestException } from '@nestjs/common';

export interface SandboxTransfer {
  phone: string; accountHolderName: string; amountRwf: number; reference: string;
}

/** Flutterwave v3 transfers using TEST credentials only. It never changes creator balances. */
export class FlutterwavePayoutSandbox {
  constructor(private readonly secret: string, private readonly fetcher: typeof fetch = fetch) {
    if (!secret.startsWith('FLWSECK_TEST-')) throw new BadRequestException('A Flutterwave TEST key is required.');
  }

  private async call(path: string, body?: object) {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.flutterwave.com/v3/transfers${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new BadRequestException('The test provider did not answer. Check its dashboard before retrying.'); }
    const result = await response.json().catch(() => null) as { status?: string; data?: Record<string, unknown> } | null;
    if (!response.ok || result?.status !== 'success' || !result.data) throw new BadRequestException('The provider could not complete this sandbox request.');
    return result.data;
  }

  async start(transfer: SandboxTransfer) {
    const data = await this.call('', {
      account_bank: 'MTN', account_number: transfer.phone, beneficiary_name: transfer.accountHolderName,
      amount: transfer.amountRwf, currency: 'RWF', reference: transfer.reference,
      narration: 'Free Me TEST payout',
    });
    if (!Number.isSafeInteger(data.id) || Number(data.id) <= 0) throw new BadRequestException('The provider returned an invalid test transfer ID.');
    return { id: Number(data.id), reference: transfer.reference, sandboxOnly: true, status: 'PENDING' };
  }

  async check(id: number, expected: SandboxTransfer) {
    const data = await this.call(`/${id}`);
    if (data.id !== id || data.currency !== 'RWF' || Number(data.amount) !== expected.amountRwf
      || data.reference !== expected.reference || String(data.account_number).replace(/\D/g, '') !== expected.phone) {
      throw new BadRequestException('The test transfer does not match its reference, destination, amount, and currency.');
    }
    return { id, reference: expected.reference, sandboxOnly: true,
      status: data.status === 'SUCCESSFUL' ? 'SUCCEEDED' : data.status === 'FAILED' ? 'FAILED' : 'PENDING' };
  }
}
