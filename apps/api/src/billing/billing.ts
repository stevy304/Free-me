import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type Campaign, type Payment, type PrismaClient, type User } from '@prisma/client';
import { PROPOSED_SPLIT, allocatePool, splitRevenue } from '@free-me/shared';
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
/** Revenue (cents) of a campaign's first `views` views: whole cents only, so days add up exactly to the total. */
export const cpmRevenue = (views: bigint, cpmRateCents: number) => (views * BigInt(cpmRateCents)) / 1000n;
/** Redis counter of a campaign's ad views on one UTC day. */
export const adDayKey = (campaignId: string, t = new Date()) => `ads:day:${campaignId}:${t.toISOString().slice(0, 10)}`;

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
  async start(user: User, p: { purpose: 'PREMIUM' | 'AD_CAMPAIGN'; method: ProviderName; usdCents: number; months?: number; campaignId?: string; phone?: string; description: string; returnPath: string }) {
    const provider = (await this.providers())[p.method];
    if (!provider) throw new BillingError(p.method === 'mtn_momo' ? 'MTN MoMo payments are not set up on this server yet.' : p.method === 'flutterwave' ? 'Card payments are not set up on this server yet.' : 'This way of paying is not available.');
    let phone: string | undefined;
    if (p.method === 'mtn_momo') {
      phone = p.phone ? msisdn(p.phone, provider.currency) ?? undefined : undefined;
      if (!phone) throw new BillingError('Enter your MTN Mobile Money number, e.g. 0788 123 456 or +250 788 123 456.');
    }
    const amountMinor = provider.charge(p.usdCents);
    const payment = await this.prisma.payment.create({
      data: { userId: user.id, purpose: p.purpose, provider: p.method, providerRef: `pending-${randomUUID()}`, amountMinor, currency: provider.currency, usdCents: p.usdCents, months: p.months ?? null, campaignId: p.campaignId ?? null, phone: phone ?? null },
    });
    try {
      const r = await provider.start({ paymentId: payment.id, amountMinor, currency: provider.currency, description: p.description, email: user.email, phone, returnUrl: `${this.config.appUrl}${p.returnPath}${p.returnPath.includes('?') ? '&' : '?'}payment=${payment.id}` });
      return this.prisma.payment.update({ where: { id: payment.id }, data: { providerRef: r.providerRef, checkoutUrl: r.checkoutUrl } });
    } catch (e) {
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
      const flipped = await tx.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SUCCEEDED', paidAt: new Date(), receiptDueAt: new Date() } });
      if (flipped.count) await this.fulfil(tx, p);
    });
    publish(room.user(p.userId), 'payment', { id });
    return this.prisma.payment.findUniqueOrThrow({ where: { id } });
  }

  private async fulfil(tx: Prisma.TransactionClient, p: Payment) {
    if (p.purpose === 'PREMIUM') {
      await this.extendPremium(tx, p.userId, p.months ?? 1);
    } else if (p.campaignId) {
      await tx.campaign.updateMany({ where: { id: p.campaignId, status: 'DRAFT' }, data: { status: 'PENDING_REVIEW' } });
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
        const flipped = await tx.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SUCCEEDED', paidAt: new Date(), receiptDueAt: new Date() } });
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

  private async extendPremium(tx: Prisma.TransactionClient, userId: string, months: number) {
    // Serialize grants and purchases for the same account so both extensions are applied.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const from = isPremium(user) ? user.premiumUntil!.getTime() : Date.now();
    await tx.user.update({ where: { id: userId }, data: { premiumUntil: new Date(from + months * MONTH) } });
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
        const item = payment.purpose === 'PREMIUM' ? `Premium (${payment.months ?? 1} month(s))` : 'Ad campaign';
        await mail.send(noticeMail(payment.user.email, 'Your Free Me payment receipt', [
          item, `Amount paid: ${payment.currency} ${amount}`, `Payment date (UTC): ${payment.paidAt!.toISOString().slice(0, 10)}`,
          `Receipt reference: ${payment.id}`,
        ], { label: 'View payment history', url: `${this.config.appUrl}${payment.purpose === 'PREMIUM' ? '/premium' : '/studio/ads'}` }));
        await this.prisma.payment.updateMany({
          where: { id: payment.id, receiptDueAt: retryAt }, data: { receiptDueAt: null, receiptSentAt: new Date() },
        });
      } catch (error) {
        this.log.warn(`Receipt ${payment.id} could not be sent: ${(error as Error).message}`);
      }
    }
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
    // Campaigns past their end are done. One priced per 1,000 views may run on to its deliverUntil to deliver the
    // views it paid for, and is done as soon as its budget cannot buy another view.
    await this.prisma.$executeRaw`
      UPDATE "Campaign" SET "status" = 'COMPLETED', "updatedAt" = now() WHERE "status" = 'ACTIVE'
      AND (COALESCE("deliverUntil", "endDate") <= ${now} OR ("cpmRateCents" > 0 AND ("impressionsCount" + 1) * "cpmRateCents" > "budgetAmountCents" * 1000))`;
    return r.count;
  }

  /**
   * Worker: shares each finished UTC day's ad revenue. Campaigns priced per 1,000 views count the views they got that
   * day, and on the day their delivery period ends, any budget they could not deliver. Older campaigns priced per
   * day count what they paid for the hours they ran. Unpaid campaigns (approved without payment) count nothing.
   * The creator pool (60%) goes to monetised channels in proportion to the ads shown on their videos that day.
   */
  async settleAds(now = new Date()) {
    const first = await this.prisma.campaign.findFirst({ where: { startDate: { lt: now }, status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] }, reviewedAt: { not: null } }, orderBy: { startDate: 'asc' }, select: { startDate: true } });
    if (!first) return 0;
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
    const end = new Date(day.getTime() + DAY);
    const campaigns = await this.prisma.campaign.findMany({ where: { reviewedAt: { not: null }, status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] }, startDate: { lt: end }, OR: [{ endDate: { gt: day } }, { deliverUntil: { gte: day } }] } });
    const perView = campaigns.filter((c) => c.cpmRateCents > 0 && c.dailyRateCents > 0);
    const counts = new Map((perView.length ? await this.prisma.$queryRaw<Array<{ campaignId: string; before: bigint; today: bigint }>>`
      SELECT "campaignId", count(*) FILTER (WHERE "createdAt" < ${day.toISOString()}::timestamp)::bigint AS before,
        count(*) FILTER (WHERE "createdAt" >= ${day.toISOString()}::timestamp)::bigint AS today
      FROM "AdImpression" WHERE "campaignId" IN (${Prisma.join(perView.map((c) => c.id))}) AND "createdAt" < ${end.toISOString()}::timestamp
      GROUP BY "campaignId"` : []).map((r) => [r.campaignId, r]));
    let gross = 0n;
    for (const c of campaigns) {
      if (!c.dailyRateCents) continue;
      if (c.cpmRateCents > 0) {
        const n = counts.get(c.id) ?? { before: 0n, today: 0n };
        const upTo = cpmRevenue(n.before + n.today, c.cpmRateCents);
        gross += upTo - cpmRevenue(n.before, c.cpmRateCents);
        // Budget the campaign could not deliver is counted when its delivery period ends (it was paid for).
        const last = c.deliverUntil ?? c.endDate;
        if (last >= day && last < end && c.budgetAmountCents > upTo) gross += c.budgetAmountCents - upTo;
        continue;
      }
      if (c.endDate <= day) continue;
      const ran = Math.min(end.getTime(), c.endDate.getTime()) - Math.max(day.getTime(), c.startDate.getTime());
      if (ran > 0) gross += (BigInt(c.dailyRateCents) * BigInt(ran)) / BigInt(DAY);
    }
    const split = splitRevenue(gross, PROPOSED_SPLIT);
    const rows = await this.prisma.$queryRaw<Array<{ channelId: string; n: bigint }>>`
      SELECT v."channelId", count(*)::bigint AS n FROM "AdImpression" i JOIN "Video" v ON v.id = i."videoId"
      JOIN "CreatorEligibility" e ON e."channelId" = v."channelId" AND e."isEligible"
      WHERE i."createdAt" >= ${day.toISOString()}::timestamp AND i."createdAt" < ${end.toISOString()}::timestamp GROUP BY v."channelId"`;
    const shares = allocatePool(rows.length ? split.creatorPool : 0n, Object.fromEntries(rows.map((r) => [r.channelId, r.n])));
    return { gross, split, rows, shares };
  }

  private async settleDay(day: Date) {
    const { gross, split, rows, shares } = await this.adDayShares(day);
    const label = day.toISOString().slice(0, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.adDaySettlement.create({ data: {
        day, currency: EARNINGS_CURRENCY, grossCents: gross, creatorPoolCents: split.creatorPool, allocatedCents: Object.values(shares).reduce((a, b) => a + b, 0n),
        platformCents: split.platform, reinvestCents: split.reinvestment, impressions: rows.reduce((a, r) => a + Number(r.n), 0), channels: rows.length,
      } });
      for (const r of rows) {
        const amount = shares[r.channelId] ?? 0n;
        if (amount <= 0n) continue;
        const bal = await tx.creatorBalance.upsert({
          where: { channelId: r.channelId }, create: { channelId: r.channelId, currency: EARNINGS_CURRENCY, confirmedBalanceCents: amount, lifetimeEarningsCents: amount },
          update: { confirmedBalanceCents: { increment: amount }, lifetimeEarningsCents: { increment: amount } },
        });
        await tx.revenueLedger.create({ data: {
          channelId: r.channelId, sourceType: 'AD_SHARE_PRE_ROLL', referenceId: label, currency: EARNINGS_CURRENCY, grossAmountCents: amount, creatorShareCents: amount,
          platformShareCents: 0n, reinvestShareCents: 0n, splitBps: `${PROPOSED_SPLIT.creatorPoolBps}/${PROPOSED_SPLIT.platformBps}/${PROPOSED_SPLIT.reinvestmentBps}`,
          balanceAfterCents: bal.confirmedBalanceCents, description: `Ad earnings for ${label} (${r.n} ${r.n === 1n ? 'ad' : 'ads'} shown)`,
        } });
      }
    });
  }
}
