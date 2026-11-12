import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Payment, User } from '@prisma/client';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { Webhook } from '../common/origin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import type { AuthContext } from '../common/request';
import { Billing, BillingError, isPremium, PREMIUM_MONTHS, premiumPriceFor, uploadAccess } from './billing';
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
  months: p.months, campaignId: p.campaignId, checkoutUrl: p.status === 'PENDING' ? p.checkoutUrl : null, failureReason: p.failureReason, createdAt: p.createdAt, paidAt: p.paidAt,
  // Manual payments: the code to write in the transfer message, and the transaction id the payer gave.
  reference: p.provider === 'manual' ? p.providerRef.split('-').slice(0, 2).join('-') : null, payerReference: p.payerReference,
});

/** Membership; administrators can use every Premium feature without one. */
export const premiumView = (u: Pick<User, 'premiumUntil'> & Partial<Pick<User, 'roles'>>) => ({ active: isPremium(u) || !!u.roles?.includes('ADMIN'), until: u.premiumUntil, admin: !!u.roles?.includes('ADMIN') });

export class PayDto {
  @ApiProperty({ enum: ['mtn_momo', 'flutterwave', 'manual'] }) @IsIn(['mtn_momo', 'flutterwave', 'manual']) method!: ProviderName;
  @ApiPropertyOptional({ description: 'MTN Mobile Money number (method mtn_momo)' }) @IsOptional() @IsString() @MaxLength(24) phone?: string;
}
class ProofDto { @ApiProperty({ description: 'Transaction id from the MoMo, Airtel or bank confirmation message' }) @IsString() @MaxLength(120) reference!: string }
class PremiumDto extends PayDto { @ApiProperty({ enum: PREMIUM_MONTHS }) @IsInt() @IsIn([...PREMIUM_MONTHS]) months!: number }

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly limits: RateLimitService) {}

  /** The viewer's country (from their profile), which sets their Premium price. */
  private async country(auth: AuthContext | null) {
    return auth ? (await this.prisma.profile.findUnique({ where: { userId: auth.user.id }, select: { country: true } }))?.country ?? null : null;
  }

  @Get('plans')
  @ApiOperation({ summary: 'Prices (Premium in the signed-in viewer\'s country) and the payment methods this server accepts' })
  async plans(@CurrentAuth() auth: AuthContext | null) {
    const b = await this.billing.settings();
    const country = await this.country(auth);
    const usdCents = premiumPriceFor(b, country);
    return {
      premium: { usdCents, months: PREMIUM_MONTHS, standardUsdCents: b.premiumUsdCents, country: usdCents !== b.premiumUsdCents ? country : null },
      creatorPass: { usdCents: b.creatorPassUsdCents, months: PREMIUM_MONTHS, freeVideos: b.creatorFreeVideos },
      // A paid day buys up to viewsPerDay ad views (priced per 1,000 views); views not delivered run on afterwards.
      ads: { usdCentsPerDay: b.adDayUsdCents, usdCentsPer1000Views: b.adCpmUsdCents, viewsPerDay: Math.floor((b.adDayUsdCents * 1000) / b.adCpmUsdCents), maxAdsPerVideo: 2 },
      payoutMinimumUsdCents: b.payoutMinUsdCents,
      methods: (await this.billing.methods()).map((m) => ({
        ...m, perUsd: m.name === 'mtn_momo' ? b.momo!.perUsd : m.name === 'manual' ? b.manual!.perUsd : 1,
        ...(m.name === 'manual' ? { accounts: b.manual!.accounts, instructions: b.manual!.instructions } : {}),
      })),
    };
  }

  @Get('me')
  @RequireAuth()
  @ApiOperation({ summary: 'My Premium membership and payments' })
  async me(@CurrentAuth() auth: AuthContext) {
    const [u, payments] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } }),
      this.prisma.payment.findMany({ where: { userId: auth.user.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    return { premium: premiumView(u), payments: payments.map(paymentView) };
  }

  @Post('premium')
  @RequireAuth()
  @ApiOperation({ summary: 'Pay for Premium (MoMo prompt on the phone, or a card checkout link)' })
  async premium(@CurrentAuth() auth: AuthContext, @Body() body: PremiumDto) {
    await this.limits.consume(`pay:${auth.user.id}`, 10, 3600, 'Too many payment attempts. Please wait a little.');
    const usdCents = premiumPriceFor(await this.billing.settings(), await this.country(auth)) * body.months;
    const p = await this.billing.attempt(() => this.billing.start(auth.user, { purpose: 'PREMIUM', method: body.method, phone: body.phone, months: body.months, usdCents, description: `Free Me Premium, ${body.months} ${body.months === 1 ? 'month' : 'months'}`, returnPath: '/premium' }));
    return { payment: paymentView(p) };
  }

  @Get('creator-pass')
  @RequireAuth()
  @ApiOperation({ summary: 'My Creator pass: whether I can upload, free videos left, and the price' })
  async creatorPass(@CurrentAuth() auth: AuthContext) {
    const [u, channel, b] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } }),
      this.prisma.channel.findUnique({ where: { userId: auth.user.id }, select: { uploadCount: true } }),
      this.billing.settings(),
    ]);
    const access = uploadAccess(u, channel?.uploadCount ?? 0, b);
    return {
      pass: { active: access.pass, until: u.creatorPassUntil, includedWithPremium: access.pass && isPremium(u) },
      canUpload: access.allowed, freeVideos: b.creatorFreeVideos, freeLeft: access.freeLeft, uploads: channel?.uploadCount ?? 0,
      usdCents: b.creatorPassUsdCents, months: PREMIUM_MONTHS,
    };
  }

  @Post('creator-pass')
  @RequireAuth()
  @ApiOperation({ summary: 'Pay for the Creator pass (needed to upload after the free videos)' })
  async buyCreatorPass(@CurrentAuth() auth: AuthContext, @Body() body: PremiumDto) {
    await this.limits.consume(`pay:${auth.user.id}`, 10, 3600, 'Too many payment attempts. Please wait a little.');
    const usdCents = (await this.billing.settings()).creatorPassUsdCents * body.months;
    const p = await this.billing.attempt(() => this.billing.start(auth.user, { purpose: 'CREATOR_PASS', method: body.method, phone: body.phone, months: body.months, usdCents, description: `Free Me Creator pass, ${body.months} ${body.months === 1 ? 'month' : 'months'}`, returnPath: '/hub/pass' }));
    return { payment: paymentView(p) };
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
