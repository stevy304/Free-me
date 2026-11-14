import { Logger } from '@nestjs/common';
import { authChanged } from '../auth/session-cache';
import { randomUUID } from 'node:crypto';
import { Prisma, type Campaign, type Payment, type PrismaClient, type User } from '@prisma/client';
import { adRevenuePolicy, allocatePool, splitRevenue } from '@free-me/shared';
import type { AppConfig, BillingConfig } from '../config/config';
import { createProviders, currencyDigits, ProviderError, type PaymentProvider, type ProviderName } from './providers';
import { type MailService, noticeMail } from '../mail/mail.service';

import { effective, loadStored, type EffectiveBilling } from './settings';
import { publish, room } from '../realtime/publish';

export const PREMIUM_MONTHS = [1, 3, 6, 12] as const;
const DAY = 86_400_000;
const MONTH = 30 * DAY;
/** Ads and creator earnings are kept in US dollars (cents). */
export const EARNINGS_CURRENCY = 'USD';

export class BillingError extends Error {}

/** Start of the UTC day containing `t`. */
export const utcDay = (t: Date) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));

/** An international mobile number as digits ("+250 788 123 456" → "250788123456"). A leading 0 takes the MoMo country's code. */
export function msisdn(raw: string, currency: string): string | null {
  let d = raw.replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && currency === 'RWF') d = `250${d.slice(1)}`;
  return /^[1-9]\d{8,14}$/.test(d) ? d : null;
}

export const isPremium = (u: Pick<User, 'premiumUntil'>, now = new Date()) => !!u.premiumUntil && u.premiumUntil > now;
/** Premium features (Live Studio, monetisation): members, and administrators, who can use everything. */
export const hasPremiumAccess = (u: Pick<User, 'premiumUntil' | 'roles'>, now = new Date()) => isPremium(u, now) || u.roles.includes('ADMIN');
/**
 * Ad views a campaign priced per 1,000 views can get: in total (its budget) and per UTC day (spread evenly over the
 * days bought, so one campaign cannot take every slot). Null for older campaigns priced per day (no limit).
 */
export function adViewLimits(c: Pick<Campaign, 'cpmRateCents' | 'budgetAmountCents' | 'days'>): { total: number; perDay: number } | null {
  if (!c.cpmRateCents) return null;
  const total = Number((c.budgetAmountCents * 1000n) / BigInt(c.cpmRateCents));
  return { total, perDay: Math.max(1, Math.floor(total / Math.max(1, c.days))) };
}
/**
 * Adds funds to a paid ad. Days grow with the budget so the daily pace stays the same; a reviewed ad's end and
 * delivery window move out by those days (from now if it had ended), and a finished ad starts running again.
 */
export async function addAdFunds(tx: Prisma.TransactionClient, campaignId: string, amount: bigint) {
  const c = await tx.campaign.findUnique({ where: { id: campaignId } });
  if (!c || amount <= 0n) return;
  const budget = c.budgetAmountCents + amount;
  const days = c.budgetAmountCents > 0n ? Math.max(c.days, Math.ceil(Number((budget * BigInt(Math.max(1, c.days))) / c.budgetAmountCents))) : Math.max(1, c.days);
  const extra = (days - c.days) * 86_400_000;
  const now = Date.now();
  const reviewed = !!c.reviewedAt;
  const end = new Date(Math.max(c.endDate.getTime(), now) + extra);
  const until = new Date(Math.max(c.deliverUntil?.getTime() ?? 0, end.getTime() + Math.max(days, 30) * 86_400_000));
  await tx.campaign.update({ where: { id: campaignId }, data: {
    budgetAmountCents: budget, days, dailyRateCents: Math.ceil(Number(budget) / days),
    ...(reviewed ? { endDate: end, deliverUntil: until } : {}),
    ...(c.status === 'COMPLETED' && reviewed ? { status: 'ACTIVE' } : {}),
  } });
}

/** Revenue (cents) of a campaign's first `views` views: whole cents only, so days add up exactly to the total. */
export const cpmRevenue = (views: bigint, cpmRateCents: number) => (views * BigInt(cpmRateCents)) / 1000n;
/** Redis counter of a campaign's ad views on one UTC day. */
export const adDayKey = (campaignId: string, t = new Date()) => `ads:day:${campaignId}:${t.toISOString().slice(0, 10)}`;

/** Uploading after the free videos: the Creator pass, Premium (which includes it), or an administrator account. */
export const hasCreatorPass = (u: Pick<User, 'premiumUntil' | 'roles' | 'creatorPassUntil'>, now = new Date()) =>
  hasPremiumAccess(u, now) || (!!u.creatorPassUntil && u.creatorPassUntil > now);

/**
 * Whether this account may start another upload. Every channel gets `creatorFreeVideos` uploads to try Free Me; then
 * the Creator pass (a year at a time) allows `creatorPassVideosPerYear` uploads in any 365 days; Premium (Pro) has no
 * limit. Videos already published stay online whether or not a plan is kept up. `uploadsLastYear` counts the
 * channel's videos uploaded in the last 365 days (deleting one frees its storage, so it frees its place too).
 */
export function uploadAccess(u: Pick<User, 'premiumUntil' | 'roles' | 'creatorPassUntil'>, uploadCount: number, uploadsLastYear: number,
  b: Pick<BillingConfig, 'creatorFreeVideos' | 'creatorPassVideosPerYear'>, now = new Date()) {
  const pro = hasPremiumAccess(u, now);
  const pass = pro || (!!u.creatorPassUntil && u.creatorPassUntil > now);
  const freeLeft = Math.max(0, b.creatorFreeVideos - uploadCount);
  const passLeft = pro ? null : pass ? Math.max(0, b.creatorPassVideosPerYear - uploadsLastYear) : 0;
  const allowed = pro || freeLeft > 0 || (pass && (passLeft ?? 0) > 0);
  const reason = allowed ? null : pass ? 'PASS_LIMIT' as const : 'PASS_REQUIRED' as const;
  return { allowed, pro, pass, freeLeft, passLeft, reason };
}

/** A channel's uploads (not ads) of the last 365 days, for the Creator pass's yearly number. */
export const uploadsLastYear = (prisma: Pick<PrismaClient, 'video'>, channelId: string, now = new Date()) =>
  prisma.video.count({ where: { channelId, isAd: false, createdAt: { gt: new Date(now.getTime() - 365 * DAY) } } });

/** The paid plans (Premium is the "Pro" plan for creators). */
export type PlanKey = 'premium' | 'plus' | 'family' | 'creator_pass';
export const PLAN_PURPOSE = { premium: 'PREMIUM', plus: 'PLUS', family: 'FAMILY', creator_pass: 'CREATOR_PASS' } as const;
/** Lengths on sale: months for the monthly plans, years (as 12, 24 months) for the Creator pass. */
export const PLAN_MONTHS: Record<PlanKey, readonly number[]> = { premium: [1, 3, 6, 12], plus: [1, 3, 6, 12], family: [1, 3, 6, 12], creator_pass: [12, 24] };

/** A plan's price for one month (one year for the Creator pass) for someone in `country` (their profile's country). */
export function planPrice(b: Pick<BillingConfig, 'premiumUsdCents' | 'premiumByCountry' | 'plusUsdCents' | 'plusByCountry' | 'familyUsdCents' | 'familyByCountry' | 'creatorPassUsdCents'>, plan: PlanKey, country: string | null | undefined): number {
  const c = country?.toUpperCase();
  if (plan === 'premium') return (c && b.premiumByCountry?.[c]) || b.premiumUsdCents;
  if (plan === 'plus') return (c && b.plusByCountry?.[c]) || b.plusUsdCents;
  if (plan === 'family') return (c && b.familyByCountry?.[c]) || b.familyUsdCents;
  return b.creatorPassUsdCents;
}
/** What `months` of a plan costs: the Creator pass is priced per year. */
export const planTotal = (unit: number, plan: PlanKey, months: number) => (plan === 'creator_pass' ? unit * (months / 12) : unit * months);

type PlusFields = Pick<User, 'premiumUntil' | 'roles' | 'plusUntil' | 'familyUntil' | 'familyOwnerId'>;
/**
 * Plus perks (no ads, every quality): Plus, Family & TV (holder and members), and Premium, which includes them. A
 * member's perks last while the holder's plan does. Pass the holder when already loaded; otherwise it is read.
 */
export async function hasPlus(prisma: Pick<PrismaClient, 'user'>, u: PlusFields, now = new Date(), owner?: Pick<User, 'familyUntil'> | null): Promise<boolean> {
  if (hasPremiumAccess(u, now) || (u.plusUntil && u.plusUntil > now) || (u.familyUntil && u.familyUntil > now)) return true;
  if (!u.familyOwnerId) return false;
  const o = owner ?? await prisma.user.findUnique({ where: { id: u.familyOwnerId }, select: { familyUntil: true } });
  return !!o?.familyUntil && o.familyUntil > now;
}

/** Premium per month for someone in `country` (their profile's country): the country's own price, else the standard one. */
export const premiumPriceFor = (b: Pick<BillingConfig, 'premiumUsdCents' | 'premiumByCountry'>, country: string | null | undefined) =>
  (country && b.premiumByCountry?.[country.toUpperCase()]) || b.premiumUsdCents;

/** Manual payments wait this long for the payer's proof and an administrator's check. */
const MANUAL_WAIT = 7 * DAY;

/**
 * Payments, Premium membership and ad revenue. Used by the API (checkout, status) and by the worker (checking
 * pending payments, ending memberships, settling each day's ad revenue). Every step is safe to run twice.
 */
export class Billing {
  private readonly log = new Logger('Billing');
  private cache: { at: number; settings: EffectiveBilling; providers: Partial<Record<ProviderName, PaymentProvider>> } | null = null;
  constructor(private readonly prisma: PrismaClient, private readonly config: AppConfig) {}

  /** Prices and payment methods in force: the environment, overridden by what administrators saved in the app. */
  async settings(): Promise<EffectiveBilling> { return (await this.load()).settings; }
  async providers() { return (await this.load()).providers; }
  /** After administrators change the settings (other servers pick them up within 15 seconds). */
  invalidate() { this.cache = null; }
  private async load() {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache;
    const settings = effective(this.config, await loadStored(this.prisma, this.config));
    this.cache = { at: Date.now(), settings, providers: createProviders(settings) };
    return this.cache;
  }

  async methods() {
    const providers = await this.providers();
    return (Object.keys(providers) as ProviderName[]).map((name) => ({ name, currency: providers[name]!.currency }));
  }

  /** Creates a payment and asks the provider to collect it. */
  async start(user: User, p: { purpose: 'PREMIUM' | 'AD_CAMPAIGN' | 'CREATOR_SUPPORT' | 'CREATOR_PASS' | 'PLUS' | 'FAMILY' | 'VERIFICATION'; supportChannelId?: string; requestKey?: string; method: ProviderName; usdCents: number; months?: number; campaignId?: string; phone?: string; description: string; returnPath: string }): Promise<Payment> {
    const provider = (await this.providers())[p.method];
    if (!provider) throw new BillingError(p.method === 'airtel_money' ? 'Airtel Money payments are not set up on this server yet.' : p.method === 'mtn_momo' ? 'MTN MoMo payments are not set up on this server yet.' : p.method === 'flutterwave' ? 'Card payments are not set up on this server yet.' : 'This way of paying is not available.');
    let phone: string | undefined;
    if (p.method === 'mtn_momo' || p.method === 'airtel_money') {
      phone = p.phone ? msisdn(p.phone, provider.currency) ?? undefined : undefined;
      if (!phone) throw new BillingError(p.method === 'airtel_money' ? 'Enter your Airtel Money number, e.g. 0731 234 567 or +250 731 234 567.' : 'Enter your MTN Mobile Money number, e.g. 0788 123 456 or +250 788 123 456.');
    }
    const amountMinor = provider.charge(p.usdCents);
    const existing = p.requestKey ? await this.prisma.payment.findUnique({ where: { requestKey: p.requestKey } }) : null;
    if (existing) {
      if (existing.userId !== user.id || existing.supportChannelId !== p.supportChannelId || existing.usdCents !== p.usdCents || existing.provider !== p.method || existing.phone !== (phone ?? null)) throw new BillingError('This request was already used for a different payment.');
      return existing;
    }
    const paymentId = randomUUID();
    const preparedRef = p.purpose === 'CREATOR_SUPPORT' && p.method !== 'manual'
      ? p.method === 'flutterwave' ? `fm-${paymentId}` : randomUUID()
      : `pending-${randomUUID()}`;
    let payment: Payment;
    try { payment = await this.prisma.payment.create({
      data: { id: paymentId, userId: user.id, purpose: p.purpose, provider: p.method, providerRef: preparedRef, amountMinor, currency: provider.currency, usdCents: p.usdCents, months: p.months ?? null, campaignId: p.campaignId ?? null, phone: phone ?? null, supportChannelId: p.supportChannelId, requestKey: p.requestKey },
    }); } catch (e) {
      // A competing request may have created this payment while we checked.
      if (p.requestKey && (e as { code?: string }).code === 'P2002') return this.start(user, p);
      throw e;
    }
    try {
      const r = await provider.start({ paymentId: payment.id, providerRef: preparedRef.startsWith('pending-') ? undefined : preparedRef, amountMinor, currency: provider.currency, description: p.description, email: user.email, phone, returnUrl: `${this.config.appUrl}${p.returnPath}${p.returnPath.includes('?') ? '&' : '?'}payment=${payment.id}` });
      return this.prisma.payment.update({ where: { id: payment.id }, data: { providerRef: r.providerRef, checkoutUrl: r.checkoutUrl } });
    } catch (e) {
      if (p.purpose === 'CREATOR_SUPPORT' && p.method !== 'manual') {
        this.log.warn(`Support payment ${payment.id}: collection response uncertain; checking saved reference`);
        return this.prisma.payment.update({ where: { id: payment.id }, data: { failureReason: 'Confirmation is delayed. We are checking the saved payment reference. Do not send another payment.' } });
      }
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: 'The payment could not be started.' } });
      this.log.warn(`payment ${payment.id}: ${(e as Error).message}`);
      throw new BillingError(e instanceof ProviderError ? 'The payment service did not answer. Please try again in a moment.' : 'The payment could not be started.');
    }
  }

  /** Asks the provider about a pending payment and applies the answer. */
  async refresh(id: string): Promise<Payment> {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id } });
    if (p.status !== 'PENDING' || p.providerRef.startsWith('pending-')) return p;
    const provider = (await this.providers())[p.provider as ProviderName];
    if (!provider) return p;
    if (p.provider === 'manual') {
      // Decided by an administrator; only an old one that nobody confirmed lapses.
      if (Date.now() - p.createdAt.getTime() > MANUAL_WAIT) return this.prisma.payment.update({ where: { id }, data: { status: 'FAILED', failureReason: 'The payment was not confirmed in time.' } });
      return p;
    }
    let r;
    try { r = await provider.check(p.providerRef, { amountMinor: p.amountMinor, currency: p.currency }); }
    catch (e) { this.log.warn(`payment ${p.id}: ${(e as Error).message}`); return p; }
    if (r.status === 'PENDING') {
      if (Date.now() - p.createdAt.getTime() > DAY) {
        await this.prisma.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: 'The payment was not completed in time.' } });
        return this.prisma.payment.findUniqueOrThrow({ where: { id } });
      }
      return p;
    }
    if (r.status === 'FAILED') {
      await this.prisma.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: r.reason } });
      publish(room.user(p.userId), 'payment', { id });
      return this.prisma.payment.findUniqueOrThrow({ where: { id } });
    }
    await this.prisma.$transaction(async (tx) => {
      // Only the first caller to flip PENDING → SUCCEEDED fulfils (the API and the worker may both check).
      const flipped = await tx.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SUCCEEDED', failureReason: null, paidAt: new Date(), receiptDueAt: new Date() } });
      if (flipped.count) await this.fulfil(tx, p);
    });
    publish(room.user(p.userId), 'payment', { id });
    return this.prisma.payment.findUniqueOrThrow({ where: { id } });
  }

  private async fulfil(tx: Prisma.TransactionClient, p: Payment) {
    if (p.purpose === 'PREMIUM') {
      await this.extendPremium(tx, p.userId, p.months ?? 1);
    } else if (p.purpose === 'CREATOR_SUPPORT' && p.supportChannelId) {
      const amount = BigInt(p.usdCents);
      const bal = await tx.creatorBalance.upsert({ where: { channelId: p.supportChannelId },
        create: { channelId: p.supportChannelId, currency: EARNINGS_CURRENCY, pendingBalanceCents: amount, lifetimeEarningsCents: amount },
        update: { pendingBalanceCents: { increment: amount }, lifetimeEarningsCents: { increment: amount } } });
      if (bal.currency !== EARNINGS_CURRENCY) throw new BillingError('Creator balance currency needs review.');
      await tx.revenueLedger.create({ data: { channelId: p.supportChannelId, sourceType: 'AUDIENCE_SUPPORT_PENDING', referenceId: p.id,
        currency: EARNINGS_CURRENCY, grossAmountCents: amount, creatorShareCents: amount, platformShareCents: 0n, reinvestShareCents: 0n,
        splitBps: '10000/0/0', balanceAfterCents: bal.confirmedBalanceCents, description: 'Audience support received; awaiting settlement review' } });
    } else if (p.purpose === 'CREATOR_PASS') {
      await this.extendCreatorPass(tx, p.userId, p.months ?? 12);
    } else if (p.purpose === 'VERIFICATION') {
      await this.extendVerification(tx, p.userId, p.months ?? 12);
    } else if (p.purpose === 'PLUS' || p.purpose === 'FAMILY') {
      await this.extendPlan(tx, p.userId, p.purpose === 'PLUS' ? 'plusUntil' : 'familyUntil', p.months ?? 1);
    } else if (p.campaignId) {
      // The first payment for an ad sends it to review. Any later payment (Add funds, or a second payment for the same
      // ad) adds to its budget: more views at the same price, over proportionally more days, so the daily pace stays.
      const first = await tx.campaign.updateMany({ where: { id: p.campaignId, status: 'DRAFT' }, data: { status: 'PENDING_REVIEW' } });
      if (!first.count) await addAdFunds(tx, p.campaignId, BigInt(p.usdCents));
    }
  }

  /** The payer gives the transaction id from their MoMo, Airtel or bank confirmation (manual payments). */
  async submitProof(userId: string, id: string, reference: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p || p.userId !== userId) throw new BillingError('Payment not found.');
    if (p.provider !== 'manual' || p.status !== 'PENDING') throw new BillingError('This payment does not need a transaction id.');
    const ref = reference.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (ref.length < 4) throw new BillingError('Enter the transaction id from your payment message.');
    return this.prisma.payment.update({ where: { id }, data: { payerReference: ref } });
  }

  /** An administrator checked a manual payment arrived (or did not). */
  async confirmManual(id: string, approve: boolean, reason?: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p || p.provider !== 'manual') throw new BillingError('Payment not found.');
    if (p.status !== 'PENDING') throw new BillingError('This payment is already settled.');
    if (approve) {
      await this.prisma.$transaction(async (tx) => {
        const flipped = await tx.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SUCCEEDED', failureReason: null, paidAt: new Date(), receiptDueAt: new Date() } });
        if (flipped.count) await this.fulfil(tx, p);
      });
    } else {
      await this.prisma.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: reason?.trim() || 'The payment could not be found.' } });
    }
    publish(room.user(p.userId), 'payment', { id });
    return this.prisma.payment.findUniqueOrThrow({ where: { id } });
  }

  /** Grants Premium without a payment (administrators: gifts, partners). */
  async grantPremium(userId: string, months: number) {
    await this.prisma.$transaction((tx) => this.extendPremium(tx, userId, months));
  }

  /** Gives the Creator pass without a payment (administrators: invited creators at launch, partners). */
  async grantCreatorPass(userId: string, months: number) {
    await this.prisma.$transaction((tx) => this.extendCreatorPass(tx, userId, months));
  }

  private extendCreatorPass(tx: Prisma.TransactionClient, userId: string, months: number) {
    return this.extendPlan(tx, userId, 'creatorPassUntil', months);
  }

  /**
   * A paid Verified business badge: the checked business (APPROVED, or ACTIVE when renewing) gets the badge until a
   * year later (from its current end when renewing early). The badge then overrides a Premium badge on the channel.
   */
  private async extendVerification(tx: Prisma.TransactionClient, userId: string, months: number) {
    const channel = await tx.channel.findUnique({ where: { userId }, include: { businessVerification: true } });
    const v = channel?.businessVerification;
    if (!channel || !v || (v.status !== 'APPROVED' && v.status !== 'ACTIVE')) { this.log.warn(`verification paid by ${userId} without an approved request`); return; }
    const from = v.verifiedUntil && v.verifiedUntil > new Date() ? v.verifiedUntil.getTime() : Date.now();
    await tx.businessVerification.update({ where: { id: v.id }, data: { status: 'ACTIVE', verifiedUntil: new Date(from + months * MONTH) } });
    await tx.channel.update({ where: { id: channel.id }, data: { isVerified: true, verificationSource: 'BUSINESS' } });
  }

  /** Gives Plus or Family & TV without a payment (administrators: partners, prizes, support). */
  async grantPlan(userId: string, field: 'plusUntil' | 'familyUntil', months: number) {
    await this.prisma.$transaction((tx) => this.extendPlan(tx, userId, field, months));
  }

  /** Adds months to a plan, from its end when it is still running (paying early never loses days). */
  private async extendPlan(tx: Prisma.TransactionClient, userId: string, field: 'creatorPassUntil' | 'plusUntil' | 'familyUntil', months: number) {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const until = user[field];
    const from = until && until > new Date() ? until.getTime() : Date.now();
    await tx.user.update({ where: { id: userId }, data: { [field]: new Date(from + months * MONTH) } });
    authChanged(userId); // announced again two seconds later, after the transaction commits
  }

  private async extendPremium(tx: Prisma.TransactionClient, userId: string, months: number) {
    // Serialize grants and purchases for the same account so both extensions are applied.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const from = isPremium(user) ? user.premiumUntil!.getTime() : Date.now();
    await tx.user.update({ where: { id: userId }, data: { premiumUntil: new Date(from + months * MONTH) } });
    authChanged(userId);
    await tx.channel.updateMany({ where: { userId, isVerified: false }, data: { isVerified: true, verificationSource: 'PREMIUM' } });
  }

  async sendReceipts(mail: MailService) {
    const payments = await this.prisma.payment.findMany({
      where: { status: 'SUCCEEDED', receiptDueAt: { lte: new Date() } },
      include: { user: { select: { email: true } } }, orderBy: { receiptDueAt: 'asc' }, take: 50,
    });
    for (const payment of payments) {
      const retryAt = new Date(Date.now() + 10 * 60_000);
      const claim = await this.prisma.payment.updateMany({
        where: { id: payment.id, receiptDueAt: payment.receiptDueAt }, data: { receiptDueAt: retryAt },
      });
      if (!claim.count) continue;
      try {
        const digits = currencyDigits(payment.currency);
        const raw = payment.amountMinor.toString().padStart(digits + 1, '0');
        const amount = digits ? `${raw.slice(0, -digits)}.${raw.slice(-digits)}` : raw;
        const item = payment.purpose === 'PREMIUM' ? `Premium (${payment.months ?? 1} month(s))` : payment.purpose === 'CREATOR_PASS' ? `Creator pass (${Math.round((payment.months ?? 12) / 12)} year(s))`
          : payment.purpose === 'PLUS' ? `Plus (${payment.months ?? 1} month(s))` : payment.purpose === 'FAMILY' ? `Family & TV (${payment.months ?? 1} month(s))`
            : payment.purpose === 'VERIFICATION' ? 'Verified business badge (1 year)' : payment.purpose === 'CREATOR_SUPPORT' ? 'One-time creator support' : 'Ad funds';
        await mail.send(noticeMail(payment.user.email, 'Your Free Me payment receipt', [
          item, `Amount paid: ${payment.currency} ${amount}`, `Payment date (UTC): ${payment.paidAt!.toISOString().slice(0, 10)}`,
          `Receipt reference: ${payment.id}`,
        ], { label: 'View payment history', url: `${this.config.appUrl}${payment.purpose === 'PREMIUM' ? '/premium' : payment.purpose === 'CREATOR_PASS' ? '/hub/pass' : payment.purpose === 'AD_CAMPAIGN' || payment.purpose === 'VERIFICATION' ? '/studio/ads' : '/plans'}` }));
        await this.prisma.payment.updateMany({
          where: { id: payment.id, receiptDueAt: retryAt }, data: { receiptDueAt: null, receiptSentAt: new Date() },
        });
      } catch (error) {
        this.log.warn(`Receipt ${payment.id} could not be sent: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Worker: mobile money cannot renew by itself, so plans are paid ahead. Three days before a plan ends, its holder gets
   * one email with a link to renew (`remember` makes sure the same ending is never announced twice, e.g. a Redis SET NX).
   */
  async sendRenewalReminders(mail: MailService, remember: (key: string) => Promise<boolean>, now = new Date()) {
    const from = new Date(now.getTime() + 2 * DAY);
    const to = new Date(now.getTime() + 3 * DAY);
    const window = { gt: from, lte: to };
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', OR: [{ premiumUntil: window }, { creatorPassUntil: window }, { plusUntil: window }, { familyUntil: window }] },
      select: { id: true, email: true, premiumUntil: true, creatorPassUntil: true, plusUntil: true, familyUntil: true }, take: 500,
    });
    const plans = [
      { field: 'premiumUntil', name: 'Premium', path: '/premium' },
      { field: 'plusUntil', name: 'Plus', path: '/plans' },
      { field: 'familyUntil', name: 'Family & TV', path: '/plans' },
      { field: 'creatorPassUntil', name: 'Creator pass', path: '/hub/pass' },
    ] as const;
    let sent = 0;
    for (const u of users) {
      for (const p of plans) {
        const until = u[p.field];
        if (!until || until <= from || until > to) continue;
        if (!(await remember(`fm:remind:${u.id}:${p.field}:${until.getTime()}`))) continue;
        const day = until.toISOString().slice(0, 10);
        try {
          await mail.send(noticeMail(u.email, `Your Free Me ${p.name} ends on ${day}`, [
            `Your ${p.name} ends on ${day} (UTC).`,
            p.field === 'creatorPassUntil' ? 'Renew it to keep uploading. Your videos stay online either way.'
              : p.field === 'familyUntil' ? 'Renew it so everyone in your plan keeps watching without ads.'
                : 'Renew it to keep everything it includes. Paying early adds the time to the end, so you lose nothing.',
          ], { label: `Renew ${p.name}`, url: `${this.config.appUrl}${p.path}` }));
          sent++;
        } catch (error) { this.log.warn(`Reminder to ${u.id} not sent: ${(error as Error).message}`); }
      }
    }
    return sent;
  }

  /** Worker: checks pending payments (MoMo has no reliable callback; card payers may close the tab). */
  async reconcile() {
    const pending = await this.prisma.payment.findMany({ where: { status: 'PENDING', provider: { not: 'manual' }, createdAt: { gt: new Date(Date.now() - 2 * DAY) } }, select: { id: true }, take: 200, orderBy: { createdAt: 'asc' } });
    for (const p of pending) await this.refresh(p.id);
    await this.prisma.payment.updateMany({ where: { status: 'PENDING', provider: { not: 'manual' }, createdAt: { lte: new Date(Date.now() - 2 * DAY) } }, data: { status: 'FAILED', failureReason: 'The payment was not completed in time.' } });
    await this.prisma.payment.updateMany({ where: { status: 'PENDING', provider: 'manual', createdAt: { lte: new Date(Date.now() - MANUAL_WAIT) } }, data: { status: 'FAILED', failureReason: 'The payment was not confirmed in time.' } });
  }

  /** Worker: memberships that ended lose the Premium badge (a badge given by administrators stays). */
  async expirePremium(now = new Date()) {
    const r = await this.prisma.channel.updateMany({ where: { verificationSource: 'PREMIUM', user: { OR: [{ premiumUntil: null }, { premiumUntil: { lte: now } }] } }, data: { isVerified: false, verificationSource: null } });
    // Verified business badges whose year ended: the badge goes (Premium's comes back), the check stays valid to renew.
    const lapsed = await this.prisma.businessVerification.findMany({ where: { status: 'ACTIVE', verifiedUntil: { lte: now } }, select: { id: true, channelId: true, channel: { select: { user: { select: { premiumUntil: true } } } } } });
    for (const v of lapsed) {
      await this.prisma.businessVerification.update({ where: { id: v.id }, data: { status: 'APPROVED' } });
      const premium = !!v.channel.user.premiumUntil && v.channel.user.premiumUntil > now;
      await this.prisma.channel.updateMany({ where: { id: v.channelId, verificationSource: 'BUSINESS' }, data: premium ? { verificationSource: 'PREMIUM' } : { isVerified: false, verificationSource: null } });
    }
    // Campaigns past their end are done. One priced per 1,000 views may run on to its deliverUntil to deliver the
    // views it paid for, and is done as soon as its budget cannot buy another view.
    await this.prisma.$executeRaw`
      UPDATE "Campaign" SET "status" = 'COMPLETED', "updatedAt" = now() WHERE "status" = 'ACTIVE'
      AND (COALESCE("deliverUntil", "endDate") <= ${now} OR ("cpmRateCents" > 0 AND ("impressionsCount" + 1) * "cpmRateCents" > "budgetAmountCents" * 1000))`;
    return r.count;
  }

  /**
   * Worker: shares each finished UTC day's ad revenue. Campaigns priced per 1,000 views count the views they got that
   * day. Undelivered funds remain a liability. Older campaigns priced per
   * day count what they paid for the hours they ran. Unpaid campaigns (approved without payment) count nothing.
   * The creator pool (70% from 2026-11-14; 60% before that) goes to monetised channels in proportion to the ads shown on their videos that day.
   */
  async settleAds(now = new Date()) {
    // From the first day with ad or subscription money (Plus and Family share theirs with creators too).
    const [campaign, member] = await Promise.all([
      this.prisma.campaign.findFirst({ where: { startDate: { lt: now }, status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] }, reviewedAt: { not: null } }, orderBy: { startDate: 'asc' }, select: { startDate: true } }),
      this.prisma.payment.findFirst({ where: { status: 'SUCCEEDED', purpose: { in: ['PLUS', 'FAMILY'] }, paidAt: { lt: now } }, orderBy: { paidAt: 'asc' }, select: { paidAt: true } }),
    ]);
    const starts = [campaign?.startDate, member?.paidAt].filter((d): d is Date => !!d);
    if (!starts.length) return 0;
    const first = { startDate: new Date(Math.min(...starts.map((d) => d.getTime()))) };
    const done = new Set((await this.prisma.adDaySettlement.findMany({ where: { day: { gte: utcDay(first.startDate) } }, select: { day: true } })).map((d) => d.day.getTime()));
    let settled = 0;
    for (let day = utcDay(first.startDate); day.getTime() + DAY <= now.getTime(); day = new Date(day.getTime() + DAY)) {
      if (done.has(day.getTime())) continue;
      await this.settleDay(day);
      settled++;
    }
    return settled;
  }

  async adDayShares(day: Date) {
    const policy = adRevenuePolicy(day);
    const end = new Date(day.getTime() + DAY);
    const campaigns = await this.prisma.campaign.findMany({ where: { reviewedAt: { not: null }, status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] }, startDate: { lt: end }, OR: [{ endDate: { gt: day } }, { deliverUntil: { gte: day } }] } });
    const perView = campaigns.filter((c) => c.cpmRateCents > 0 && c.dailyRateCents > 0);
    const counts = new Map((perView.length ? await this.prisma.$queryRaw<Array<{ campaignId: string; before: bigint; today: bigint }>>`
      SELECT "campaignId", count(*) FILTER (WHERE "createdAt" < ${day.toISOString()}::timestamp)::bigint AS before,
        count(*) FILTER (WHERE "createdAt" >= ${day.toISOString()}::timestamp)::bigint AS today
      FROM "AdImpression" WHERE "campaignId" IN (${Prisma.join(perView.map((c) => c.id))}) AND "createdAt" < ${end.toISOString()}::timestamp
      GROUP BY "campaignId"` : []).map((r) => [r.campaignId, r]));
    let gross = 0n;
    const campaignGross = new Map<string, bigint>();
    for (const c of campaigns) {
      if (!c.dailyRateCents) continue;
      if (c.cpmRateCents > 0) {
        const n = counts.get(c.id) ?? { before: 0n, today: 0n };
        const upTo = cpmRevenue(n.before + n.today, c.cpmRateCents);
        const before = cpmRevenue(n.before, c.cpmRateCents);
        const earned = (upTo < c.budgetAmountCents ? upTo : c.budgetAmountCents) - (before < c.budgetAmountCents ? before : c.budgetAmountCents);
        gross += earned;
        campaignGross.set(c.id, earned);
        // Undelivered prepaid funds remain a liability, available for a reviewed refund/make-good.
        // They are never ad revenue or a creator pool, even when the delivery window expires.
        continue;
      }
      if (c.endDate <= day) continue;
      const ran = Math.min(end.getTime(), c.endDate.getTime()) - Math.max(day.getTime(), c.startDate.getTime());
      if (ran > 0) {
        const earned = (BigInt(c.dailyRateCents) * BigInt(ran)) / BigInt(DAY);
        gross += earned;
        campaignGross.set(c.id, earned);
      }
    }
    // Count placements per PAID campaign. Free house ads cannot divert paid creator earnings,
    // and a low-priced campaign cannot dilute another campaign's creator allocation.
    const paidIds = [...campaignGross.keys()];
    const placements = paidIds.length ? await this.prisma.$queryRaw<Array<{ campaignId: string; all: bigint; moments: bigint }>>`
      SELECT "campaignId", count(*)::bigint AS all, count(*) FILTER (WHERE "placement" = 'MOMENTS')::bigint AS moments FROM "AdImpression"
      WHERE "campaignId" IN (${Prisma.join(paidIds)}) AND "createdAt" >= ${day.toISOString()}::timestamp AND "createdAt" < ${end.toISOString()}::timestamp
      GROUP BY "campaignId"` : [];
    // A monetized rights claim pays the owner rather than the uploader.
    const deliveries = paidIds.length ? await this.prisma.$queryRaw<Array<{ campaignId: string; channelId: string; n: bigint }>>`
      SELECT i."campaignId", COALESCE(cl."ownerChannelId", v."channelId") AS "channelId", count(*)::bigint AS n FROM "AdImpression" i JOIN "Video" v ON v.id = i."videoId"
      LEFT JOIN LATERAL (SELECT c."ownerChannelId" FROM "ContentClaim" c WHERE c."videoId" = v.id AND c."policy" = 'MONETIZE' AND c."status" = 'ACTIVE' ORDER BY c."createdAt" LIMIT 1) cl ON true
      LEFT JOIN "CreatorEligibility" e ON e."channelId" = v."channelId" AND e."isEligible"
      WHERE i."campaignId" IN (${Prisma.join(paidIds)}) AND i."placement" = 'PRE_ROLL' AND (cl."ownerChannelId" IS NOT NULL OR e."channelId" IS NOT NULL)
        AND i."createdAt" >= ${day.toISOString()}::timestamp AND i."createdAt" < ${end.toISOString()}::timestamp GROUP BY 1, 2` : [];
    const placementByCampaign = new Map(placements.map((p) => [p.campaignId, p]));
    const hostsByCampaign = new Map<string, typeof deliveries>();
    for (const delivery of deliveries) {
      const hosts = hostsByCampaign.get(delivery.campaignId) ?? [];
      hosts.push(delivery); hostsByCampaign.set(delivery.campaignId, hosts);
    }
    let momentsGross = 0n;
    const split = { gross: 0n, creatorPool: 0n, platform: 0n, reinvestment: 0n };
    const shares: Record<string, bigint> = {};
    const rowCounts = new Map<string, bigint>();
    for (const [campaignId, earned] of campaignGross) {
      const placed = placementByCampaign.get(campaignId);
      const momentAmount = placed && placed.all > 0n ? earned * placed.moments / placed.all : 0n;
      momentsGross += momentAmount;
      const part = splitRevenue(earned - momentAmount, policy.split);
      split.gross += part.gross; split.creatorPool += part.creatorPool;
      split.platform += part.platform; split.reinvestment += part.reinvestment;
      const hosts = hostsByCampaign.get(campaignId) ?? [];
      const allocated = allocatePool(part.creatorPool, Object.fromEntries(hosts.map((r) => [r.channelId, r.n])));
      for (const host of hosts) {
        rowCounts.set(host.channelId, (rowCounts.get(host.channelId) ?? 0n) + host.n);
        shares[host.channelId] = (shares[host.channelId] ?? 0n) + (allocated[host.channelId] ?? 0n);
      }
    }
    const rows = [...rowCounts].map(([channelId, n]) => ({ channelId, n }));
    const momentsPool = momentsGross * BigInt(policy.momentsCreatorBps) / 10_000n;
    const momentRows = momentsGross > 0n ? await this.prisma.$queryRaw<Array<{ channelId: string; views: bigint }>>`
      SELECT v."channelId", sum(s."views")::bigint AS views FROM "VideoDailyStat" s JOIN "Video" v ON v.id = s."videoId"
      JOIN "CreatorEligibility" e ON e."channelId" = v."channelId" AND e."isEligible"
      JOIN "Channel" ch ON ch.id = v."channelId" JOIN "User" u ON u.id = ch."userId"
      WHERE s."day" = ${day.toISOString().slice(0, 10)}::date AND v."isShort" AND s."views" > 0
        AND (u."premiumUntil" > ${day.toISOString()}::timestamp OR 'ADMIN' = ANY(u."roles"))
      GROUP BY v."channelId"` : [];
    const momentShares = allocatePool(momentRows.length ? momentsPool : 0n, Object.fromEntries(momentRows.map((r) => [r.channelId, r.views])));
    return { gross, split, rows, shares, moments: { gross: momentsGross, pool: momentsPool, rows: momentRows, shares: momentShares } };
  }

  /**
   * Plus and Family & TV money of one day for creators: each payment counts over the days it pays for (its months of
   * 30 days from when it was paid), and SUBSCRIPTION_CREATOR_SHARE_PERCENT of it (default 50%) is shared between
   * monetised channels in proportion to the watch time members gave their videos that day. A day nobody with a
   * plan watched a monetised video keeps the money with Free Me (recorded as not allocated).
   */
  async subscriptionDayShares(day: Date) {
    const end = new Date(day.getTime() + DAY);
    const b = await this.settings();
    const paid = await this.prisma.payment.findMany({
      where: { status: 'SUCCEEDED', purpose: { in: ['PLUS', 'FAMILY'] }, paidAt: { lt: end, gt: new Date(day.getTime() - 13 * MONTH) } },
      select: { usdCents: true, months: true, paidAt: true },
    });
    let gross = 0n;
    for (const p of paid) {
      const span = (p.months ?? 1) * MONTH;
      const from = p.paidAt!.getTime();
      const covered = Math.min(end.getTime(), from + span) - Math.max(day.getTime(), from);
      if (covered > 0) gross += (BigInt(p.usdCents) * BigInt(covered)) / BigInt(span);
    }
    const pool = (gross * BigInt(b.subscriptionCreatorShareBps)) / 10_000n;
    const rows = await this.prisma.$queryRaw<Array<{ channelId: string; seconds: bigint }>>`
      SELECT v."channelId", sum(s."plusWatchSeconds")::bigint AS seconds FROM "VideoDailyStat" s JOIN "Video" v ON v.id = s."videoId"
      JOIN "CreatorEligibility" e ON e."channelId" = v."channelId" AND e."isEligible"
      WHERE s."day" = ${day.toISOString().slice(0, 10)}::date AND s."plusWatchSeconds" > 0 GROUP BY v."channelId"`;
    const shares = allocatePool(rows.length ? pool : 0n, Object.fromEntries(rows.map((r) => [r.channelId, r.seconds])));
    return { gross, pool, rows, shares, shareBps: b.subscriptionCreatorShareBps };
  }

  private async settleDay(day: Date) {
    const { gross, split, rows, shares, moments } = await this.adDayShares(day);
    const subs = await this.subscriptionDayShares(day);
    const label = day.toISOString().slice(0, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.adDaySettlement.create({ data: {
        day, currency: EARNINGS_CURRENCY, grossCents: gross, creatorPoolCents: split.creatorPool, allocatedCents: Object.values(shares).reduce((a, b) => a + b, 0n),
        platformCents: split.platform, reinvestCents: split.reinvestment, impressions: rows.reduce((a, r) => a + Number(r.n), 0), channels: rows.length,
        subscriptionPoolCents: subs.pool, subscriptionAllocatedCents: Object.values(subs.shares).reduce((a, b) => a + b, 0n),
        momentsGrossCents: moments.gross, momentsPoolCents: moments.pool, momentsAllocatedCents: Object.values(moments.shares).reduce((a, b) => a + b, 0n),
      } });
      for (const r of moments.rows) {
        const amount = moments.shares[r.channelId] ?? 0n;
        if (amount <= 0n) continue;
        const bal = await tx.creatorBalance.upsert({
          where: { channelId: r.channelId }, create: { channelId: r.channelId, currency: EARNINGS_CURRENCY, confirmedBalanceCents: amount, lifetimeEarningsCents: amount },
          update: { confirmedBalanceCents: { increment: amount }, lifetimeEarningsCents: { increment: amount } },
        });
        await tx.revenueLedger.create({ data: {
          channelId: r.channelId, sourceType: 'AD_SHARE_MOMENTS', referenceId: label, currency: EARNINGS_CURRENCY, grossAmountCents: amount, creatorShareCents: amount,
          platformShareCents: 0n, reinvestShareCents: 0n, splitBps: `${adRevenuePolicy(day).momentsCreatorBps}/${10_000 - adRevenuePolicy(day).momentsCreatorBps}/0`,
          balanceAfterCents: bal.confirmedBalanceCents, description: `Moments ad earnings for ${label} (${r.views} Moments ${r.views === 1n ? 'view' : 'views'})`,
        } });
      }
      for (const r of subs.rows) {
        const amount = subs.shares[r.channelId] ?? 0n;
        if (amount <= 0n) continue;
        const bal = await tx.creatorBalance.upsert({
          where: { channelId: r.channelId }, create: { channelId: r.channelId, currency: EARNINGS_CURRENCY, confirmedBalanceCents: amount, lifetimeEarningsCents: amount },
          update: { confirmedBalanceCents: { increment: amount }, lifetimeEarningsCents: { increment: amount } },
        });
        const minutes = Math.round(Number(r.seconds) / 60);
        await tx.revenueLedger.create({ data: {
          channelId: r.channelId, sourceType: 'SUBSCRIPTION_SHARE', referenceId: label, currency: EARNINGS_CURRENCY, grossAmountCents: amount, creatorShareCents: amount,
          platformShareCents: 0n, reinvestShareCents: 0n, splitBps: `${subs.shareBps}/${10_000 - subs.shareBps}/0`,
          balanceAfterCents: bal.confirmedBalanceCents, description: `Member viewing earnings for ${label} (${minutes} ${minutes === 1 ? 'minute' : 'minutes'} watched by members)`,
        } });
      }
      for (const r of rows) {
        const amount = shares[r.channelId] ?? 0n;
        if (amount <= 0n) continue;
        const bal = await tx.creatorBalance.upsert({
          where: { channelId: r.channelId }, create: { channelId: r.channelId, currency: EARNINGS_CURRENCY, confirmedBalanceCents: amount, lifetimeEarningsCents: amount },
          update: { confirmedBalanceCents: { increment: amount }, lifetimeEarningsCents: { increment: amount } },
        });
        await tx.revenueLedger.create({ data: {
          channelId: r.channelId, sourceType: 'AD_SHARE_PRE_ROLL', referenceId: label, currency: EARNINGS_CURRENCY, grossAmountCents: amount, creatorShareCents: amount,
          platformShareCents: 0n, reinvestShareCents: 0n, splitBps: `${adRevenuePolicy(day).split.creatorPoolBps}/${adRevenuePolicy(day).split.platformBps}/${adRevenuePolicy(day).split.reinvestmentBps}`,
          balanceAfterCents: bal.confirmedBalanceCents, description: `Ad earnings for ${label} (${r.n} ${r.n === 1n ? 'ad' : 'ads'} shown)`,
        } });
      }
    });
  }
}
