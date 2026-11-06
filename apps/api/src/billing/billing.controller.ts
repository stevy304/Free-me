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
import { Billing, BillingError, isPremium, PREMIUM_MONTHS } from './billing';
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
});

export const premiumView = (u: Pick<User, 'premiumUntil'>) => ({ active: isPremium(u), until: u.premiumUntil });

export class PayDto {
  @ApiProperty({ enum: ['mtn_momo', 'flutterwave'] }) @IsIn(['mtn_momo', 'flutterwave']) method!: ProviderName;
  @ApiPropertyOptional({ description: 'MTN Mobile Money number (method mtn_momo)' }) @IsOptional() @IsString() @MaxLength(24) phone?: string;
}
class PremiumDto extends PayDto { @ApiProperty({ enum: PREMIUM_MONTHS }) @IsInt() @IsIn([...PREMIUM_MONTHS]) months!: number }

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly limits: RateLimitService) {}

  @Get('plans')
  @ApiOperation({ summary: 'Prices and the payment methods this server accepts' })
  plans() {
    const b = this.billing.cfg.billing;
    return {
      premium: { usdCents: b.premiumUsdCents, months: PREMIUM_MONTHS },
      ads: { usdCentsPerDay: b.adDayUsdCents, maxAdsPerVideo: 2 },
      payoutMinimumUsdCents: b.payoutMinUsdCents,
      methods: this.billing.methods().map((m) => ({ ...m, perUsd: m.name === 'mtn_momo' ? b.momo!.perUsd : 1 })),
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
    const usdCents = this.billing.cfg.billing.premiumUsdCents * body.months;
    const p = await this.billing.attempt(() => this.billing.start(auth.user, { purpose: 'PREMIUM', method: body.method, phone: body.phone, months: body.months, usdCents, description: `Free Me Premium, ${body.months} ${body.months === 1 ? 'month' : 'months'}`, returnPath: '/premium' }));
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

  @Post('webhooks/flutterwave')
  @Webhook()
  @HttpCode(200)
  @ApiOperation({ summary: 'Flutterwave callback (checked with the verif-hash header; the payment is then verified with Flutterwave itself)' })
  async flutterwave(@Req() req: Request, @Body() body: { data?: { tx_ref?: string } }) {
    const hash = this.billing.cfg.billing.flutterwave?.webhookHash;
    if (!hash || req.headers['verif-hash'] !== hash) throw new ForbiddenException('Unknown sender.');
    const ref = body?.data?.tx_ref;
    const p = ref ? await this.prisma.payment.findUnique({ where: { providerRef: ref } }) : null;
    if (p) await this.billing.refresh(p.id);
    return { received: true };
  }
}
