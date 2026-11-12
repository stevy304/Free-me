import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Payment, User } from '@prisma/client';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { Webhook } from '../common/origin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import type { AuthContext } from '../common/request';
import { Billing, BillingError, hasPlus, hasPremiumAccess, isPremium, PLAN_MONTHS, PLAN_PURPOSE, planPrice, planTotal, uploadAccess, uploadsLastYear, type PlanKey } from './billing';
import type { ProviderName } from './providers';

@Injectable()
export class BillingService extends Billing {
  constructor(prisma: PrismaService, @Inject(APP_CONFIG) readonly cfg: AppConfig) { super(prisma, cfg); }

  /** Runs a billing step, turning its errors into answers people can read. */
  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { if (e instanceof BillingError) throw new BadRequestException(e.message); throw e; }
  }
}

export const paymentView = (p: Payment) => ({
  id: p.id, purpose: p.purpose, method: p.provider, status: p.status, amount: p.amountMinor.toString(), currency: p.currency, usdCents: p.usdCents,
  supportChannelId: p.supportChannelId, supportClearedAt: p.supportClearedAt, months: p.months, campaignId: p.campaignId, checkoutUrl: p.status === 'PENDING' ? p.checkoutUrl : null, failureReason: p.failureReason, createdAt: p.createdAt, paidAt: p.paidAt,
  // Manual payments: the code to write in the transfer message, and the transaction id the payer gave.
  reference: p.provider === 'manual' ? p.providerRef.split('-').slice(0, 2).join('-') : null, payerReference: p.payerReference,
});

/** Membership; administrators can use every Premium feature without one. */
export const premiumView = (u: Pick<User, 'premiumUntil'> & Partial<Pick<User, 'roles'>>) => ({ active: isPremium(u) || !!u.roles?.includes('ADMIN'), until: u.premiumUntil, admin: !!u.roles?.includes('ADMIN') });

export class PayDto {
  @ApiProperty({ enum: ['mtn_momo', 'airtel_money', 'flutterwave', 'manual'] }) @IsIn(['mtn_momo', 'airtel_money', 'flutterwave', 'manual']) method!: ProviderName;
  @ApiPropertyOptional({ description: 'Mobile money number (methods mtn_momo and airtel_money)' }) @IsOptional() @IsString() @MaxLength(24) phone?: string;
}
class ProofDto { @ApiProperty({ description: 'Transaction id from the MoMo, Airtel or bank confirmation message' }) @IsString() @MaxLength(120) reference!: string }
class PlanPayDto extends PayDto { @ApiProperty({ description: 'Months: 1, 3, 6 or 12 (Creator pass: 12 or 24)' }) @IsInt() @IsIn([1, 3, 6, 12, 24]) months!: number }
class MemberDto { @ApiProperty() @IsEmail() @MaxLength(200) email!: string }

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly limits: RateLimitService) {}

  /** The viewer's country (from their profile), which sets their Premium price. */
  private async country(auth: AuthContext | null) {
    return auth ? (await this.prisma.profile.findUnique({ where: { userId: auth.user.id }, select: { country: true } }))?.country ?? null : null;
  }

  /** One plan's prices for this viewer: their country's price when there is one, and the standard price. */
  private planView(b: Awaited<ReturnType<BillingService['settings']>>, key: PlanKey, country: string | null) {
    const usdCents = planPrice(b, key, country);
    const standardUsdCents = planPrice(b, key, null);
    return { usdCents, standardUsdCents, months: PLAN_MONTHS[key], country: usdCents !== standardUsdCents ? country : null };
  }

  @Get('plans')
  @ApiOperation({ summary: 'Every plan with its price in the signed-in viewer\'s country (per month; the Creator pass per year), and the payment methods' })
  async plans(@CurrentAuth() auth: AuthContext | null) {
    const b = await this.billing.settings();
    const country = await this.country(auth);
    return {
      premium: this.planView(b, 'premium', country),
      plus: this.planView(b, 'plus', country),
      family: { ...this.planView(b, 'family', country), seats: b.familySeats },
      creatorPass: { ...this.planView(b, 'creator_pass', country), freeVideos: b.creatorFreeVideos, videosPerYear: b.creatorPassVideosPerYear },
      /** Largest file a creator can upload, on every plan. */
      uploadMaxBytes: this.billing.cfg.media.maxUploadBytes,
      // Ads: the business adds funds (at least minBudgetUsdCents), spent at usdCentsPer1000Views as the ad is shown.
      ads: { usdCentsPer1000Views: b.adCpmUsdCents, minBudgetUsdCents: b.adMinBudgetUsdCents, maxAdsPerVideo: 2 },
      payoutMinimumUsdCents: b.payoutMinUsdCents,
      methods: (await this.billing.methods()).map((m) => ({
        ...m, perUsd: m.name === 'mtn_momo' ? b.momo!.perUsd : m.name === 'airtel_money' ? b.airtel!.perUsd : m.name === 'manual' ? b.manual!.perUsd : 1,
        ...(m.name === 'manual' ? { accounts: b.manual!.accounts, instructions: b.manual!.instructions } : {}),
      })),
    };
  }

  @Get('me')
  @RequireAuth()
  @ApiOperation({ summary: 'My plans and payments' })
  async me(@CurrentAuth() auth: AuthContext) {
    const [u, payments] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id }, include: { familyOwner: { select: { email: true, familyUntil: true } } } }),
      this.prisma.payment.findMany({ where: { userId: auth.user.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const now = new Date();
    const live = (d: Date | null | undefined) => !!d && d > now;
    const viaFamily = !!u.familyOwnerId && live(u.familyOwner?.familyUntil);
    return {
      premium: premiumView(u),
      plans: {
        plus: { active: await hasPlus(this.prisma, u, now, u.familyOwner), until: u.plusUntil,
          via: live(u.plusUntil) ? 'plus' : live(u.familyUntil) ? 'family' : viaFamily ? 'family_member' : hasPremiumAccess(u, now) ? 'premium' : null },
        family: { active: live(u.familyUntil), until: u.familyUntil, memberOf: u.familyOwnerId ? { email: u.familyOwner?.email ?? null, until: u.familyOwner?.familyUntil ?? null } : null },
        creatorPass: { active: live(u.creatorPassUntil), until: u.creatorPassUntil },
      },
      payments: payments.map(paymentView),
    };
  }

  /** Starts the payment for a plan; it is applied when the provider confirms it. */
  private async buy(auth: AuthContext, plan: PlanKey, body: PlanPayDto) {
    if (!PLAN_MONTHS[plan].includes(body.months)) throw new BadRequestException(`Choose ${plan === 'creator_pass' ? '1 or 2 years' : '1, 3, 6 or 12 months'}.`);
    await this.limits.consume(`pay:${auth.user.id}`, 10, 3600, 'Too many payment attempts. Please wait a little.');
    const usdCents = planTotal(planPrice(await this.billing.settings(), plan, await this.country(auth)), plan, body.months);
    const length = plan === 'creator_pass' ? `${body.months / 12} ${body.months === 12 ? 'year' : 'years'}` : `${body.months} ${body.months === 1 ? 'month' : 'months'}`;
    const name = { premium: 'Premium', plus: 'Plus', family: 'Family & TV', creator_pass: 'Creator pass' }[plan];
    const returnPath = { premium: '/premium', plus: '/plans', family: '/plans', creator_pass: '/hub/pass' }[plan];
    const p = await this.billing.attempt(() => this.billing.start(auth.user, { purpose: PLAN_PURPOSE[plan], method: body.method, phone: body.phone, months: body.months, usdCents, description: `Free Me ${name}, ${length}`, returnPath }));
    return { payment: paymentView(p) };
  }

  @Post('plans/:plan')
  @RequireAuth()
  @ApiOperation({ summary: 'Pay for a plan: premium, plus, family (per month) or creator_pass (months: 12 or 24)' })
  buyPlan(@CurrentAuth() auth: AuthContext, @Param('plan') plan: string, @Body() body: PlanPayDto) {
    const key = plan.replace('-', '_') as PlanKey;
    if (!(key in PLAN_MONTHS)) throw new NotFoundException('No such plan.');
    return this.buy(auth, key, body);
  }

  @Post('premium')
  @RequireAuth()
  @ApiOperation({ summary: 'Pay for Premium (same as POST /billing/plans/premium)' })
  premium(@CurrentAuth() auth: AuthContext, @Body() body: PlanPayDto) { return this.buy(auth, 'premium', body); }

  @Get('creator-pass')
  @RequireAuth()
  @ApiOperation({ summary: 'My Creator pass: whether I can upload, free uploads and yearly uploads left, and the price per year' })
  async creatorPass(@CurrentAuth() auth: AuthContext) {
    const [u, channel, b] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } }),
      this.prisma.channel.findUnique({ where: { userId: auth.user.id }, select: { id: true, uploadCount: true } }),
      this.billing.settings(),
    ]);
    const lastYear = channel ? await uploadsLastYear(this.prisma, channel.id) : 0;
    const access = uploadAccess(u, channel?.uploadCount ?? 0, lastYear, b);
    return {
      pass: { active: access.pass, until: u.creatorPassUntil, includedWithPremium: access.pro },
      canUpload: access.allowed, reason: access.reason, freeVideos: b.creatorFreeVideos, freeLeft: access.freeLeft, uploads: channel?.uploadCount ?? 0,
      videosPerYear: b.creatorPassVideosPerYear, uploadsLastYear: lastYear, passLeft: access.passLeft,
      usdCents: b.creatorPassUsdCents, months: PLAN_MONTHS.creator_pass,
    };
  }

  @Post('creator-pass')
  @RequireAuth()
  @ApiOperation({ summary: 'Pay for the Creator pass (months: 12 or 24)' })
  buyCreatorPass(@CurrentAuth() auth: AuthContext, @Body() body: PlanPayDto) { return this.buy(auth, 'creator_pass', body); }

  @Get('family')
  @RequireAuth()
  @ApiOperation({ summary: 'My Family & TV plan: its members (holder), or whose plan I am in' })
  async family(@CurrentAuth() auth: AuthContext) {
    const [u, b] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id }, include: {
        familyMembers: { select: { id: true, email: true, profile: { select: { displayName: true } } }, orderBy: { email: 'asc' } },
        familyOwner: { select: { email: true, familyUntil: true } },
      } }),
      this.billing.settings(),
    ]);
    return {
      holder: { active: !!u.familyUntil && u.familyUntil > new Date(), until: u.familyUntil, seats: b.familySeats,
        members: u.familyMembers.map((m) => ({ id: m.id, email: m.email, name: m.profile?.displayName ?? null })) },
      memberOf: u.familyOwnerId ? { email: u.familyOwner?.email ?? null, until: u.familyOwner?.familyUntil ?? null } : null,
    };
  }

  @Post('family/members')
  @RequireAuth()
  @ApiOperation({ summary: 'Add someone to my Family & TV plan by the email of their Free Me account' })
  async addMember(@CurrentAuth() auth: AuthContext, @Body() body: MemberDto) {
    await this.limits.consume(`family:add:${auth.user.id}`, 20, 86_400, 'Too many changes today. Try again tomorrow.');
    const [holder, b] = await Promise.all([this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id }, include: { _count: { select: { familyMembers: true } } } }), this.billing.settings()]);
    if (!holder.familyUntil || holder.familyUntil <= new Date()) throw new BadRequestException('Get Family & TV first.');
    if (holder._count.familyMembers >= b.familySeats - 1) throw new BadRequestException(`Family & TV is for up to ${b.familySeats} people, you included. Remove someone first.`);
    const email = body.email.trim().toLowerCase();
    const member = await this.prisma.user.findUnique({ where: { email } });
    if (!member) throw new NotFoundException('No account uses this email. They need to sign in to Free Me once first.');
    if (member.id === holder.id) throw new BadRequestException('You are already in your plan.');
    const joined = await this.prisma.user.updateMany({ where: { id: member.id, familyOwnerId: null }, data: { familyOwnerId: holder.id } });
    if (!joined.count) throw new BadRequestException(member.familyOwnerId === holder.id ? 'They are already in your plan.' : 'They are already in another Family & TV plan.');
    return this.family(auth);
  }

  @Delete('family/members/:id')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove someone from my Family & TV plan' })
  async removeMember(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.user.updateMany({ where: { id, familyOwnerId: auth.user.id }, data: { familyOwnerId: null } });
    return this.family(auth);
  }

  @Delete('family/membership')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Leave the Family & TV plan I was added to' })
  async leave(@CurrentAuth() auth: AuthContext) {
    await this.prisma.user.update({ where: { id: auth.user.id }, data: { familyOwnerId: null } });
    return this.family(auth);
  }

  @Get('payments/:id')
  @RequireAuth()
  @ApiOperation({ summary: 'One of my payments, checked with the provider while it is pending' })
  async payment(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p || p.userId !== auth.user.id) throw new NotFoundException('Payment not found.');
    const fresh = await this.billing.refresh(id);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    return { payment: paymentView(fresh), premium: premiumView(u) };
  }

  @Post('payments/:id/proof')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Manual payment: give the transaction id from your MoMo, Airtel or bank message; an administrator confirms it' })
  async proof(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ProofDto) {
    await this.limits.consume(`pay:proof:${auth.user.id}`, 20, 3600);
    return { payment: paymentView(await this.billing.attempt(() => this.billing.submitProof(auth.user.id, id, body.reference))) };
  }

  @Post('webhooks/flutterwave')
  @Webhook()
  @HttpCode(200)
  @ApiOperation({ summary: 'Flutterwave callback (checked with the verif-hash header; the payment is then verified with Flutterwave itself)' })
  async flutterwave(@Req() req: Request, @Body() body: { data?: { tx_ref?: string } }) {
    const hash = (await this.billing.settings()).flutterwave?.webhookHash;
    if (!hash || req.headers['verif-hash'] !== hash) throw new ForbiddenException('Unknown sender.');
    const ref = body?.data?.tx_ref;
    const p = ref ? await this.prisma.payment.findUnique({ where: { providerRef: ref } }) : null;
    if (p) await this.billing.refresh(p.id);
    return { received: true };
  }
}
