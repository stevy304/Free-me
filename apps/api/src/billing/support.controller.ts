import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsUUID } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { AuditService } from '../common/audit.service';
import { RateLimitService } from '../common/rate-limit.service';
import { PrismaService } from '../database/prisma.service';
import { BillingService, PayDto, paymentView } from './billing.controller';

class SupportDto extends PayDto {
  @IsInt() @IsIn([100, 300, 500, 1000, 2000]) usdCents!: number;
  @IsUUID() requestId!: string;
}
class EnableDto { @IsBoolean() enabled!: boolean }

@Controller()
export class SupportController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly limits: RateLimitService, private readonly audit: AuditService) {}

  @Get('support/:handle')
  async availability(@Param('handle') handle: string) {
    const ch = await this.prisma.channel.findUnique({ where: { handle }, include: { payoutAccount: true } });
    if (!ch) throw new NotFoundException('Space not found.');
    return { enabled: ch.supportEnabled && ch.payoutAccount?.status === 'VERIFIED', optedIn: ch.supportEnabled,
      channelId: ch.id, name: ch.name, amountsUsdCents: [100, 300, 500, 1000, 2000], platformFeeBps: 0,
      terms: 'One-time support, not a subscription. Zero platform commission during the pilot. Funds await settlement review before withdrawal. Free Sparks have no cash value.' };
  }

  @Put('support/:handle')
  @RequireAuth()
  async enable(@CurrentAuth() auth: AuthContext, @Param('handle') handle: string, @Body() body: EnableDto) {
    const ch = await this.prisma.channel.findUnique({ where: { handle }, include: { payoutAccount: true } });
    if (!ch || ch.userId !== auth.user.id) throw new NotFoundException('Space not found.');
    if (body.enabled && ch.payoutAccount?.status !== 'VERIFIED') throw new BadRequestException('Have your payout account reviewed in Creator Hub first.');
    await this.prisma.channel.update({ where: { id: ch.id }, data: { supportEnabled: body.enabled } });
    return this.availability(handle);
  }

  @Post('support/:handle')
  @RequireAuth()
  async start(@CurrentAuth() auth: AuthContext, @Param('handle') handle: string, @Body() body: SupportDto) {
    await this.limits.consume(`support:${auth.user.id}`, 10, 3600);
    const ch = await this.prisma.channel.findUnique({ where: { handle }, include: { payoutAccount: true } });
    if (!ch) throw new NotFoundException('Space not found.');
    if (ch.userId === auth.user.id) throw new BadRequestException('You cannot support your own Space.');
    // Replaying an existing checkout remains safe after a creator switches support off.
    const key = `support:${auth.user.id}:${body.requestId}`;
    const existing = await this.prisma.payment.findUnique({ where: { requestKey: key } });
    if (!existing && (!ch.supportEnabled || ch.payoutAccount?.status !== 'VERIFIED')) throw new BadRequestException('This Space is not accepting support right now.');
    const payment = await this.billing.attempt(() => this.billing.start(auth.user, {
      purpose: 'CREATOR_SUPPORT', supportChannelId: ch.id, requestKey: key, usdCents: body.usdCents,
      method: body.method, phone: body.phone, description: `One-time support for ${ch.name}`,
      returnPath: `/channel/${encodeURIComponent(ch.handle)}?support=1`,
    }));
    return { payment: paymentView(payment) };
  }

  @Get('admin/billing/support')
  @RequireAuth('ADMIN')
  async queue() {
    const payments = await this.prisma.payment.findMany({ where: { purpose: 'CREATOR_SUPPORT', status: 'SUCCEEDED', supportClearedAt: null },
      orderBy: { paidAt: 'asc' }, take: 100, include: { supportChannel: { select: { handle: true, name: true } } } });
    return { payments: payments.map((p) => ({ ...paymentView(p), channel: p.supportChannel })) };
  }

  @Post('admin/billing/support/:id/clear')
  @RequireAuth('ADMIN')
  async clear(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p || p.purpose !== 'CREATOR_SUPPORT' || p.status !== 'SUCCEEDED' || !p.supportChannelId) throw new NotFoundException('Received support payment not found.');
    await this.prisma.$transaction(async (tx) => {
      const once = await tx.payment.updateMany({ where: { id, supportClearedAt: null }, data: { supportClearedAt: new Date() } });
      if (!once.count) return;
      const amount = BigInt(p.usdCents);
      const moved = await tx.creatorBalance.updateMany({ where: { channelId: p.supportChannelId!, currency: 'USD', pendingBalanceCents: { gte: amount } },
        data: { pendingBalanceCents: { decrement: amount }, confirmedBalanceCents: { increment: amount } } });
      if (!moved.count) throw new BadRequestException('Pending balance does not match. Review this payment before clearance.');
      const bal = await tx.creatorBalance.findUniqueOrThrow({ where: { channelId: p.supportChannelId! } });
      await tx.revenueLedger.create({ data: { channelId: p.supportChannelId!, sourceType: 'AUDIENCE_SUPPORT_CLEARED', referenceId: id,
        currency: 'USD', grossAmountCents: 0n, creatorShareCents: 0n, platformShareCents: 0n, reinvestShareCents: 0n,
        splitBps: '10000/0/0', balanceAfterCents: bal.confirmedBalanceCents, description: `Audience support cleared: USD ${(p.usdCents / 100).toFixed(2)}` } });
    });
    await this.audit.record({ userId: auth.user.id, action: 'AUDIENCE_SUPPORT_CLEARED', entityType: 'Payment', entityId: id });
    return { payment: paymentView(await this.prisma.payment.findUniqueOrThrow({ where: { id } })) };
  }
}
