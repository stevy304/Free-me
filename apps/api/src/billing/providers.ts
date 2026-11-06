import { randomUUID } from 'node:crypto';
import type { BillingConfig } from '../config/config';

export type ProviderName = 'mtn_momo' | 'flutterwave';
export type ProviderStatus = { status: 'PENDING' } | { status: 'SUCCEEDED' } | { status: 'FAILED'; reason: string };

export interface StartPayment {
  paymentId: string;
  /** Amount in minor units of `currency`. */
  amountMinor: bigint;
  currency: string;
  description: string;
  email: string;
  phone?: string;
  /** Where the card checkout sends the payer back. */
  returnUrl: string;
}

export interface PaymentProvider {
  name: ProviderName;
  /** The currency this provider charges in. */
  currency: string;
  /** Turns a US-cent price into the charge in this provider's currency (minor units). */
  charge(usdCents: number): bigint;
  start(p: StartPayment): Promise<{ providerRef: string; checkoutUrl: string | null }>;
  check(providerRef: string, expected: { amountMinor: bigint; currency: string }): Promise<ProviderStatus>;
}

export class ProviderError extends Error {}

/** Digits after the decimal point for a currency (RWF 0, USD 2). */
export const currencyDigits = (currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
const major = (minor: bigint, currency: string) => {
  const d = currencyDigits(currency);
  if (!d) return minor.toString();
  const unit = 10n ** BigInt(d);
  return `${minor / unit}.${(minor % unit).toString().padStart(d, '0')}`;
};
const toMinor = (amount: number | string, currency: string) => BigInt(Math.round(Number(amount) * 10 ** currencyDigits(currency)));

async function call(url: string, init: RequestInit, what: string) {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new ProviderError(`${what}: could not reach the payment provider (${(e as Error).message})`); }
  return res;
}

/** MTN Mobile Money, Collections product: the payer approves a prompt on their phone. */
export class MomoProvider implements PaymentProvider {
  readonly name = 'mtn_momo' as const;
  private token: { value: string; until: number } | null = null;
  constructor(private readonly c: NonNullable<BillingConfig['momo']>) {}
  get currency() { return this.c.currency; }

  charge(usdCents: number) {
    // Rounded up to a whole unit, so the charge never falls below the dollar price.
    const d = currencyDigits(this.c.currency);
    return BigInt(Math.ceil((usdCents / 100) * this.c.perUsd)) * 10n ** BigInt(d);
  }

  private async bearer() {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await call(`${this.c.baseUrl}/collection/token/`, {
      method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${this.c.apiUser}:${this.c.apiKey}`).toString('base64')}`, 'Ocp-Apim-Subscription-Key': this.c.subscriptionKey },
    }, 'MoMo token');
    if (!res.ok) throw new ProviderError(`MoMo token: answered ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return j.access_token;
  }

  private async headers() {
    return { authorization: `Bearer ${await this.bearer()}`, 'X-Target-Environment': this.c.targetEnvironment, 'Ocp-Apim-Subscription-Key': this.c.subscriptionKey, 'content-type': 'application/json' };
  }

  async start(p: StartPayment) {
    if (!p.phone) throw new ProviderError('A mobile money number is needed.');
    const ref = randomUUID();
    const res = await call(`${this.c.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST', headers: { ...(await this.headers()), 'X-Reference-Id': ref },
      body: JSON.stringify({ amount: major(p.amountMinor, p.currency), currency: p.currency, externalId: p.paymentId, payer: { partyIdType: 'MSISDN', partyId: p.phone }, payerMessage: p.description.slice(0, 160), payeeNote: p.description.slice(0, 160) }),
    }, 'MoMo request to pay');
    if (res.status !== 202 && !res.ok) throw new ProviderError(`MoMo request to pay: answered ${res.status}`);
    return { providerRef: ref, checkoutUrl: null };
  }

  async check(ref: string, expected: { amountMinor: bigint; currency: string }): Promise<ProviderStatus> {
    const res = await call(`${this.c.baseUrl}/collection/v1_0/requesttopay/${ref}`, { headers: await this.headers() }, 'MoMo status');
    if (res.status === 404) return { status: 'PENDING' };
    if (!res.ok) throw new ProviderError(`MoMo status: answered ${res.status}`);
    const j = (await res.json()) as { status: string; amount?: string; currency?: string; reason?: string | { message?: string } };
    if (j.status === 'SUCCESSFUL') {
      if (j.currency !== expected.currency || toMinor(j.amount ?? '0', expected.currency) < expected.amountMinor) return { status: 'FAILED', reason: 'The amount paid does not match the price.' };
      return { status: 'SUCCEEDED' };
    }
    if (j.status === 'FAILED' || j.status === 'REJECTED' || j.status === 'TIMEOUT') {
      const r = typeof j.reason === 'string' ? j.reason : j.reason?.message;
      return { status: 'FAILED', reason: r === 'APPROVAL_REJECTED' ? 'The payment was declined on the phone.' : r === 'NOT_ENOUGH_FUNDS' ? 'Not enough money on the mobile money account.' : 'The mobile money payment did not go through.' };
    }
    return { status: 'PENDING' };
  }
}

/** Flutterwave Standard: a hosted checkout page for cards (and local mobile money where Flutterwave offers it). */
export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave' as const;
  readonly currency = 'USD';
  constructor(private readonly c: NonNullable<BillingConfig['flutterwave']>) {}
  charge(usdCents: number) { return BigInt(usdCents); }
  private get auth() { return { authorization: `Bearer ${this.c.secretKey}`, 'content-type': 'application/json' }; }

  async start(p: StartPayment) {
    const ref = `fm-${p.paymentId}`;
    const res = await call(`${this.c.baseUrl}/v3/payments`, {
      method: 'POST', headers: this.auth,
      body: JSON.stringify({ tx_ref: ref, amount: major(p.amountMinor, p.currency), currency: p.currency, redirect_url: p.returnUrl, customer: { email: p.email }, customizations: { title: 'Free Me', description: p.description } }),
    }, 'Card checkout');
    const j = (await res.json().catch(() => ({}))) as { status?: string; data?: { link?: string }; message?: string };
    if (!res.ok || j.status !== 'success' || !j.data?.link) throw new ProviderError(`Card checkout: ${j.message ?? `answered ${res.status}`}`);
    return { providerRef: ref, checkoutUrl: j.data.link };
  }

  async check(ref: string, expected: { amountMinor: bigint; currency: string }): Promise<ProviderStatus> {
    const res = await call(`${this.c.baseUrl}/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref)}`, { headers: this.auth }, 'Card status');
    if (res.status === 404 || res.status === 400) return { status: 'PENDING' }; // not paid yet
    if (!res.ok) throw new ProviderError(`Card status: answered ${res.status}`);
    const j = (await res.json()) as { data?: { status?: string; amount?: number; currency?: string } };
    const d = j.data ?? {};
    if (d.status === 'successful') {
      if (d.currency !== expected.currency || toMinor(d.amount ?? 0, expected.currency) < expected.amountMinor) return { status: 'FAILED', reason: 'The amount paid does not match the price.' };
      return { status: 'SUCCEEDED' };
    }
    if (d.status === 'failed' || d.status === 'cancelled') return { status: 'FAILED', reason: 'The card payment did not go through.' };
    return { status: 'PENDING' };
  }
}

export function createProviders(c: BillingConfig): Partial<Record<ProviderName, PaymentProvider>> {
  return { ...(c.momo ? { mtn_momo: new MomoProvider(c.momo) } : {}), ...(c.flutterwave ? { flutterwave: new FlutterwaveProvider(c.flutterwave) } : {}) };
}
