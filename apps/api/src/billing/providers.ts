import { randomUUID } from 'node:crypto';
import type { BillingConfig } from '../config/config';
import type { EffectiveBilling, ManualConfig } from './settings';

export type ProviderName = 'mtn_momo' | 'airtel_money' | 'flutterwave' | 'manual';
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
/**
 * A dollar price in a local currency, as people expect to pay it: whole units, and amounts of 1,000 or more rounded
 * to the nearest 100 (RWF 2,494 → 2,500, 6,003 → 6,000). Returned in minor units. The web app rounds the same way.
 */
export function localCharge(usdCents: number, perUsd: number, currency: string): bigint {
  const d = currencyDigits(currency);
  const exact = (usdCents / 100) * perUsd;
  const units = d === 0 && exact >= 1000 ? Math.round(exact / 100) * 100 : Math.ceil(exact);
  return BigInt(units) * 10n ** BigInt(d);
}
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

  charge(usdCents: number) { return localCharge(usdCents, this.c.perUsd, this.c.currency); }

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

/**
 * Airtel Money Collections (Airtel Africa Open API, openapi.airtel.africa; sandbox openapiuat.airtel.africa): the
 * payer approves a USSD prompt on their phone, then the status is asked for. Numbers are sent without the country
 * code (Rwanda: 9 digits, e.g. 73xxxxxxx). Check the request against Airtel's current documentation and sandbox
 * before going live: Airtel's field names differ between products and countries.
 */
export class AirtelProvider implements PaymentProvider {
  readonly name = 'airtel_money' as const;
  private token: { value: string; until: number } | null = null;
  constructor(private readonly c: NonNullable<BillingConfig['airtel']>) {}
  get currency() { return this.c.currency; }

  charge(usdCents: number) { return localCharge(usdCents, this.c.perUsd, this.c.currency); }

  private async bearer() {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await call(`${this.c.baseUrl}/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: '*/*' },
      body: JSON.stringify({ client_id: this.c.clientId, client_secret: this.c.clientSecret, grant_type: 'client_credentials' }),
    }, 'Airtel token');
    if (!res.ok) throw new ProviderError(`Airtel token: answered ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number | string };
    this.token = { value: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in ?? 3600) - 60) * 1000 };
    return j.access_token;
  }

  private async headers() {
    return { authorization: `Bearer ${await this.bearer()}`, 'X-Country': this.c.country, 'X-Currency': this.c.currency, 'content-type': 'application/json', accept: '*/*' };
  }

  /** "250731234567" → "731234567": Airtel wants the national number. */
  private national(msisdn: string) { return msisdn.startsWith('250') && this.c.country === 'RW' ? msisdn.slice(3) : msisdn; }

  async start(p: StartPayment) {
    if (!p.phone) throw new ProviderError('An Airtel Money number is needed.');
    // Airtel's transaction id: short, unique, letters and digits only.
    const ref = p.paymentId.replace(/-/g, '').slice(0, 20).toUpperCase();
    const res = await call(`${this.c.baseUrl}/merchant/v1/payments/`, {
      method: 'POST', headers: await this.headers(),
      body: JSON.stringify({
        reference: p.description.replace(/[^\w ]/g, '').slice(0, 64) || 'Free Me',
        subscriber: { country: this.c.country, currency: this.c.currency, msisdn: this.national(p.phone) },
        transaction: { amount: Number(major(p.amountMinor, p.currency)), country: this.c.country, currency: this.c.currency, id: ref },
      }),
    }, 'Airtel collection');
    const j = (await res.json().catch(() => ({}))) as { status?: { success?: boolean; message?: string } };
    if (!res.ok || j.status?.success === false) throw new ProviderError(`Airtel collection: ${j.status?.message ?? `answered ${res.status}`}`);
    return { providerRef: ref, checkoutUrl: null };
  }

  async check(ref: string): Promise<ProviderStatus> {
    const res = await call(`${this.c.baseUrl}/standard/v1/payments/${encodeURIComponent(ref)}`, { headers: await this.headers() }, 'Airtel status');
    if (res.status === 404) return { status: 'PENDING' };
    if (!res.ok) throw new ProviderError(`Airtel status: answered ${res.status}`);
    const j = (await res.json()) as { data?: { transaction?: { status?: string; message?: string } } };
    const status = j.data?.transaction?.status;
    // TS: successful, TF: failed, TA/TIP: still in progress (ambiguous or waiting for the payer).
    if (status === 'TS') return { status: 'SUCCEEDED' };
    if (status === 'TF') return { status: 'FAILED', reason: 'The Airtel Money payment did not go through.' };
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

/**
 * Pay by hand: the payer sends the amount to one of the operator's accounts (MoMo number, Airtel Money, bank) with
 * a reference code, then enters the transaction id from their confirmation message. An administrator checks it
 * and confirms (Administration → Money). Works without any payment provider account.
 */
export class ManualProvider implements PaymentProvider {
  readonly name = 'manual' as const;
  constructor(readonly c: ManualConfig) {}
  get currency() { return this.c.currency; }
  charge(usdCents: number) { return this.c.currency === 'USD' ? BigInt(usdCents) : localCharge(usdCents, this.c.perUsd, this.c.currency); }
  async start() {
    // A short code people can type in a MoMo or bank transfer message.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomUUID().replace(/-/g, '').slice(0, 6), (h) => alphabet[parseInt(h, 16) % alphabet.length]).join('');
    return { providerRef: `FM-${code}-${randomUUID().slice(0, 4)}`, checkoutUrl: null };
  }
  /** Never decided automatically: an administrator confirms or rejects it. */
  async check(): Promise<ProviderStatus> { return { status: 'PENDING' }; }
}

export function createProviders(c: EffectiveBilling | BillingConfig): Partial<Record<ProviderName, PaymentProvider>> {
  const manual = 'manual' in c ? c.manual : null;
  return {
    ...(c.momo ? { mtn_momo: new MomoProvider(c.momo) } : {}),
    ...('airtel' in c && c.airtel ? { airtel_money: new AirtelProvider(c.airtel) } : {}),
    ...(c.flutterwave ? { flutterwave: new FlutterwaveProvider(c.flutterwave) } : {}),
    ...(manual ? { manual: new ManualProvider(manual) } : {}),
  };
}

/** MTN MoMo sandbox: creates an API user and key from just the subscription key (momodeveloper.mtn.com). */
export async function createMomoSandboxUser(baseUrl: string, subscriptionKey: string, callbackHost: string) {
  const user = randomUUID();
  const a = await call(`${baseUrl}/v1_0/apiuser`, { method: 'POST', headers: { 'X-Reference-Id': user, 'Ocp-Apim-Subscription-Key': subscriptionKey, 'content-type': 'application/json' }, body: JSON.stringify({ providerCallbackHost: callbackHost }) }, 'MoMo sandbox user');
  if (a.status !== 201) throw new ProviderError(a.status === 401 ? 'MTN did not accept this subscription key. Copy the Primary key of your Collections subscription.' : `MTN answered ${a.status} when creating the API user.`);
  const k = await call(`${baseUrl}/v1_0/apiuser/${user}/apikey`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': subscriptionKey } }, 'MoMo sandbox key');
  if (k.status !== 201) throw new ProviderError(`MTN answered ${k.status} when creating the API key.`);
  return { apiUser: user, apiKey: ((await k.json()) as { apiKey: string }).apiKey };
}

/** Checks MoMo keys by asking for an access token. */
export async function testMomo(c: NonNullable<BillingConfig['momo']>) {
  const res = await call(`${c.baseUrl}/collection/token/`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${c.apiUser}:${c.apiKey}`).toString('base64')}`, 'Ocp-Apim-Subscription-Key': c.subscriptionKey } }, 'MoMo');
  if (!res.ok) throw new ProviderError(res.status === 401 ? 'MTN refused these keys (check the subscription key, API user and API key, and sandbox or live).' : `MTN answered ${res.status}.`);
}

/** Checks a Flutterwave secret key with a harmless read. */
export async function testFlutterwave(c: NonNullable<BillingConfig['flutterwave']>) {
  const res = await call(`${c.baseUrl}/v3/banks/NG`, { headers: { authorization: `Bearer ${c.secretKey}` } }, 'Flutterwave');
  if (res.status === 401) throw new ProviderError('Flutterwave refused this secret key.');
  if (!res.ok) throw new ProviderError(`Flutterwave answered ${res.status}.`);
}
