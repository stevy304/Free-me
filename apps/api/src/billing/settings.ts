import { adEconomics } from '@free-me/shared';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig, BillingConfig } from '../config/config';

/** One way to pay by hand: the payer sends money to this account and gives the transaction id. */
export interface ManualAccount { label: string; number: string; name: string }

/** Pay by hand (no payment provider needed): an administrator confirms each payment. */
export interface ManualConfig { currency: string; perUsd: number; accounts: ManualAccount[]; instructions: string | null }

export interface EffectiveBilling extends BillingConfig { manual: ManualConfig | null }

/** What administrators save in the app (Administration → Money → Payment settings). Secrets are stored encrypted. */
export interface StoredBilling {
  premiumUsdCents?: number; premiumByCountry?: Record<string, number>; creatorPassUsdCents?: number; creatorFreeVideos?: number;
  plusUsdCents?: number; plusByCountry?: Record<string, number>; familyUsdCents?: number; familyByCountry?: Record<string, number>; adDayUsdCents?: number; adCpmUsdCents?: number; adMinBudgetUsdCents?: number; verificationUsdCents?: number; payoutMinUsdCents?: number;
  momo?: { enabled: boolean; baseUrl: string; subscriptionKey: string; apiUser: string; apiKey: string; targetEnvironment: string; currency: string; perUsd: number } | null;
  flutterwave?: { enabled: boolean; secretKey: string; webhookHash: string | null } | null;
  manual?: ManualConfig & { enabled: boolean } | null;
}

const KEY = 'billing';
const SECRET_FIELDS = { momo: ['subscriptionKey', 'apiKey'], flutterwave: ['secretKey', 'webhookHash'] } as const;

/** AES-256-GCM with a key derived from SESSION_SECRET, so a database dump alone does not reveal payment keys. */
function cipherKey(config: AppConfig) { return createHash('sha256').update(`freeme-settings:${config.sessionSecret}`).digest(); }
export function seal(config: AppConfig, plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey(config), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}
export function unseal(config: AppConfig, value: string | null | undefined): string {
  if (!value) return '';
  if (!value.startsWith('enc:')) return value;
  const raw = Buffer.from(value.slice(4), 'base64');
  const d = createDecipheriv('aes-256-gcm', cipherKey(config), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Saved settings with secrets decrypted (null when nothing was saved, or SESSION_SECRET changed since). */
export async function loadStored(prisma: PrismaClient, config: AppConfig): Promise<StoredBilling> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  if (!row) return {};
  const s = structuredClone(row.value) as StoredBilling;
  try {
    for (const [group, fields] of Object.entries(SECRET_FIELDS) as Array<[keyof typeof SECRET_FIELDS, readonly string[]]>) {
      const g = s[group] as Record<string, string | null> | null | undefined;
      if (g) for (const f of fields) g[f] = unseal(config, g[f]) || (f === 'webhookHash' ? null : '');
    }
  } catch { return {}; } // encrypted with another SESSION_SECRET: ignore rather than fail every payment
  return s;
}

export async function saveStored(prisma: PrismaClient, config: AppConfig, s: StoredBilling, by: string) {
  const out = structuredClone(s);
  for (const [group, fields] of Object.entries(SECRET_FIELDS) as Array<[keyof typeof SECRET_FIELDS, readonly string[]]>) {
    const g = out[group] as Record<string, string | null> | null | undefined;
    if (g) for (const f of fields) g[f] = g[f] ? seal(config, g[f]!) : null;
  }
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: out as never, updatedBy: by }, update: { value: out as never, updatedBy: by } });
}

/** The settings in force: what administrators saved in the app wins over the environment. */
export function effective(config: AppConfig, s: StoredBilling): EffectiveBilling {
  const e = config.billing;
  return {
    premiumUsdCents: s.premiumUsdCents ?? e.premiumUsdCents,
    premiumByCountry: s.premiumByCountry ?? e.premiumByCountry,
    creatorPassUsdCents: s.creatorPassUsdCents ?? e.creatorPassUsdCents,
    creatorFreeVideos: s.creatorFreeVideos ?? e.creatorFreeVideos,
    creatorPassVideosPerYear: e.creatorPassVideosPerYear,
    plusUsdCents: s.plusUsdCents ?? e.plusUsdCents,
    plusByCountry: s.plusByCountry ?? e.plusByCountry,
    familyUsdCents: s.familyUsdCents ?? e.familyUsdCents,
    familyByCountry: s.familyByCountry ?? e.familyByCountry,
    familySeats: e.familySeats,
    subscriptionCreatorShareBps: e.subscriptionCreatorShareBps,
    airtel: e.airtel,
    adDayUsdCents: s.adDayUsdCents ?? e.adDayUsdCents,
    adEconomics: e.adEconomics,
    adCpmUsdCents: adEconomics(s.adCpmUsdCents ?? e.adCpmUsdCents, e.adEconomics).effectiveCpmUsdCents,
    adMinBudgetUsdCents: s.adMinBudgetUsdCents ?? e.adMinBudgetUsdCents,
    verificationUsdCents: s.verificationUsdCents ?? e.verificationUsdCents,
    payoutMinUsdCents: s.payoutMinUsdCents ?? e.payoutMinUsdCents,
    momo: s.momo === undefined ? e.momo : s.momo?.enabled && s.momo.subscriptionKey && s.momo.apiUser && s.momo.apiKey ? {
      baseUrl: s.momo.baseUrl.replace(/\/+$/, ''), subscriptionKey: s.momo.subscriptionKey, apiUser: s.momo.apiUser, apiKey: s.momo.apiKey,
      targetEnvironment: s.momo.targetEnvironment, currency: s.momo.currency, perUsd: s.momo.currency === 'USD' ? 1 : s.momo.perUsd,
    } : null,
    flutterwave: s.flutterwave === undefined ? e.flutterwave : s.flutterwave?.enabled && s.flutterwave.secretKey
      ? { baseUrl: e.flutterwave?.baseUrl ?? 'https://api.flutterwave.com', secretKey: s.flutterwave.secretKey, webhookHash: s.flutterwave.webhookHash } : null,
    manual: s.manual?.enabled && s.manual.accounts.length
      ? { currency: s.manual.currency, perUsd: s.manual.currency === 'USD' ? 1 : s.manual.perUsd, accounts: s.manual.accounts, instructions: s.manual.instructions } : null,
  };
}

/** A secret shown in the admin screen: only its last 4 characters. */
export const mask = (v: string | null | undefined) => (v ? `••••${v.slice(-4)}` : '');
