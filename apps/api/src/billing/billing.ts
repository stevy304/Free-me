import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Payment, Prisma, PrismaClient, User } from '@prisma/client';
import { PROPOSED_SPLIT, allocatePool, splitRevenue } from '@free-me/shared';
import type { AppConfig } from '../config/config';
import { createProviders, ProviderError, type PaymentProvider, type ProviderName } from './providers';
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

/**
 * Payments, Premium membership and ad revenue. Used by the API (checkout, status) and by the worker (checking
 * pending payments, ending memberships, settling each day's ad revenue). Every step is safe to run twice.
 */
export class Billing {
  readonly providers: Partial<Record<ProviderName, PaymentProvider>>;
  private readonly log = new Logger('Billing');
  constructor(private readonly prisma: PrismaClient, private readonly config: AppConfig) { this.providers = createProviders(config.billing); }

  methods() { return (Object.keys(this.providers) as ProviderName[]).map((name) => ({ name, currency: this.providers[name]!.currency })); }

  /** Creates a payment and asks the provider to collect it. */
  async start(user: User, p: { purpose: 'PREMIUM' | 'AD_CAMPAIGN'; method: ProviderName; usdCents: number; months?: number; campaignId?: string; phone?: string; description: string; returnPath: string }) {
    const provider = this.providers[p.method];
    if (!provider) throw new BillingError(p.method === 'mtn_momo' ? 'MTN MoMo payments are not set up on this server yet.' : 'Card payments are not set up on this server yet.');
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
    const provider = this.providers[p.provider as ProviderName];
    if (!provider) return p;
    let r;
    try { r = await provider.check(p.providerRef, { amountMinor: p.amountMinor, currency: p.currency }); }
    catch (e) { this.log.warn(`payment ${p.id}: ${(e as Error).message}`); return p; }
    if (r.status === 'PENDING') {
      if (Date.now() - p.createdAt.getTime() > DAY) return this.prisma.payment.update({ where: { id }, data: { status: 'FAILED', failureReason: 'The payment was not completed in time.' } });
      return p;
    }
    if (r.status === 'FAILED') {
      await this.prisma.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'FAILED', failureReason: r.reason } });
      publish(room.user(p.userId), 'payment', { id });
      return this.prisma.payment.findUniqueOrThrow({ where: { id } });
    }
    await this.prisma.$transaction(async (tx) => {
      // Only the first caller to flip PENDING → SUCCEEDED fulfils (the API and the worker may both check).
      const flipped = await tx.payment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SUCCEEDED', paidAt: new Date() } });
      if (flipped.count) await this.fulfil(tx, p);
    });
    publish(room.user(p.userId), 'payment', { id });
    return this.prisma.payment.findUniqueOrThrow({ where: { id } });
  }

  private async fulfil(tx: Prisma.TransactionClient, p: Payment) {
    if (p.purpose === 'PREMIUM') {
      const u = await tx.user.findUniqueOrThrow({ where: { id: p.userId } });
      const from = isPremium(u) ? u.premiumUntil!.getTime() : Date.now();
      await tx.user.update({ where: { id: u.id }, data: { premiumUntil: new Date(from + (p.months ?? 1) * MONTH) } });
      await tx.channel.updateMany({ where: { userId: u.id, isVerified: false }, data: { isVerified: true, verificationSource: 'PREMIUM' } });
    } else if (p.campaignId) {
      await tx.campaign.updateMany({ where: { id: p.campaignId, status: 'DRAFT' }, data: { status: 'PENDING_REVIEW' } });
    }
  }

  /** Grants Premium without a payment (administrators: gifts, partners). */
  async grantPremium(userId: string, months: number) {
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const from = isPremium(u) ? u.premiumUntil!.getTime() : Date.now();
      await tx.user.update({ where: { id: userId }, data: { premiumUntil: new Date(from + months * MONTH) } });
      await tx.channel.updateMany({ where: { userId, isVerified: false }, data: { isVerified: true, verificationSource: 'PREMIUM' } });
    });
  }

  /** Worker: checks pending payments (MoMo has no reliable callback; card payers may close the tab). */
  async reconcile() {
    const pending = await this.prisma.payment.findMany({ where: { status: 'PENDING', createdAt: { gt: new Date(Date.now() - 2 * DAY) } }, select: { id: true }, take: 200, orderBy: { createdAt: 'asc' } });
    for (const p of pending) await this.refresh(p.id);
    await this.prisma.payment.updateMany({ where: { status: 'PENDING', createdAt: { lte: new Date(Date.now() - 2 * DAY) } }, data: { status: 'FAILED', failureReason: 'The payment was not completed in time.' } });
  }

  /** Worker: memberships that ended lose the Premium badge (a badge given by administrators stays). */
  async expirePremium(now = new Date()) {
    const r = await this.prisma.channel.updateMany({ where: { verificationSource: 'PREMIUM', user: { OR: [{ premiumUntil: null }, { premiumUntil: { lte: now } }] } }, data: { isVerified: false, verificationSource: null } });
    // Campaigns past their end are done.
    await this.prisma.campaign.updateMany({ where: { status: 'ACTIVE', endDate: { lte: now } }, data: { status: 'COMPLETED' } });
    return r.count;
  }

  /**
   * Worker: shares each finished UTC day's ad revenue. Gross = what campaigns paid for the hours they ran that day.
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

  private async settleDay(day: Date) {
    const end = new Date(day.getTime() + DAY);
    const campaigns = await this.prisma.campaign.findMany({ where: { reviewedAt: { not: null }, status: { in: ['ACTIVE', 'COMPLETED', 'PAUSED'] }, startDate: { lt: end }, endDate: { gt: day } } });
    let gross = 0n;
    for (const c of campaigns) {
      const ran = Math.min(end.getTime(), c.endDate.getTime()) - Math.max(day.getTime(), c.startDate.getTime());
      if (ran > 0) gross += (BigInt(c.dailyRateCents) * BigInt(ran)) / BigInt(DAY);
    }
    const split = splitRevenue(gross, PROPOSED_SPLIT);
    const rows = await this.prisma.$queryRaw<Array<{ channelId: string; n: bigint }>>`
      SELECT v."channelId", count(*)::bigint AS n FROM "AdImpression" i JOIN "Video" v ON v.id = i."videoId"
      JOIN "CreatorEligibility" e ON e."channelId" = v."channelId" AND e."isEligible"
      WHERE i."createdAt" >= ${day} AND i."createdAt" < ${end} GROUP BY v."channelId"`;
    const shares = allocatePool(rows.length ? split.creatorPool : 0n, Object.fromEntries(rows.map((r) => [r.channelId, r.n])));
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
