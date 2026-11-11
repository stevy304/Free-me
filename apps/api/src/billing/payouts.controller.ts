import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { BillingService } from './billing.controller';
import { msisdn } from './billing';
import { makeQuote, payoutView, readQuote } from './payouts';

class AccountDto {
  @IsIn(['RW']) country!: 'RW';
  @IsString() @Length(6, 24) phone!: string;
  @IsString() @Length(2, 100) accountHolderName!: string;
}
class AccountReviewDto {
  @IsInt() @Min(1) version!: number;
  @IsBoolean() approve!: boolean;
  @IsString() @Length(3, 500) note!: string;
}
class WithdrawDto { @IsString() @Length(20, 2000) quoteToken!: string }
class DecisionDto {
  @IsIn(['paid', 'reject']) action!: 'paid' | 'reject';
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

@Controller()
export class PayoutsController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  private async channel(auth: AuthContext) {
    const ch = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!ch) throw new NotFoundException('Create your Space first.');
    return ch;
  }

  @Get('monetisation/availability')
  availability() {
    return { countries: [{ code: 'RW', name: 'Rwanda', currency: 'RWF', method: 'MTN Mobile Money', mode: 'MANUAL_REVIEW', quotesEnabled: !!this.billing.cfg.billing.payouts }],
      otherCountries: 'Payouts are not enabled yet. New routes open after payment-provider approval.' };
  }

  @Get('hub/monetisation/payout-account')
  @RequireAuth()
  async account(@CurrentAuth() auth: AuthContext) {
    const ch = await this.channel(auth);
    return { account: await this.prisma.payoutAccount.findUnique({ where: { channelId: ch.id } }) };
  }

  @Put('hub/monetisation/payout-account')
  @RequireAuth()
  async saveAccount(@CurrentAuth() auth: AuthContext, @Body() body: AccountDto, @Req() req: AppRequest) {
    const ch = await this.channel(auth);
    const phone = msisdn(body.phone, 'RWF');
    const name = body.accountHolderName.trim();
    if (!phone || !/^2507\d{8}$/.test(phone) || name.length < 2) throw new BadRequestException('Enter your Rwanda mobile money number and the name on that account.');
    const account = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Channel" WHERE id = ${ch.id} FOR UPDATE`;
      const existing = await tx.payoutAccount.findUnique({ where: { channelId: ch.id } });
      if (existing?.accountIdentifier === phone && existing.accountHolderName === name && existing.status !== 'REJECTED') return existing;
      return tx.payoutAccount.upsert({
        where: { channelId: ch.id },
        create: { channelId: ch.id, country: body.country, provider: 'mtn_momo', accountIdentifier: phone, accountHolderName: name },
        update: { country: body.country, accountIdentifier: phone, accountHolderName: name, status: 'PENDING', reviewNote: null, reviewedAt: null, version: { increment: 1 } },
      });
    });
    await this.audit.record({ userId: auth.user.id, action: 'PAYOUT_ACCOUNT_SAVED', entityType: 'PayoutAccount', entityId: account.id, req });
    return { account };
  }

  @Get('admin/billing/payout-accounts')
  @RequireAuth('ADMIN')
  async accounts() {
    return { accounts: await this.prisma.payoutAccount.findMany({ where: { status: 'PENDING' }, include: { channel: { select: { handle: true, name: true } } }, orderBy: { updatedAt: 'asc' }, take: 100 }) };
  }

  @Post('admin/billing/payout-accounts/:id')
  @HttpCode(200)
  @RequireAuth('ADMIN')
  async reviewAccount(@Param('id', ParseUUIDPipe) id: string, @Body() body: AccountReviewDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    if (body.note.trim().length < 3) throw new BadRequestException('Record the ownership check or the reason for returning these details.');
    const result = await this.prisma.payoutAccount.updateMany({
      where: { id, version: body.version, status: 'PENDING' },
      data: { status: body.approve ? 'VERIFIED' : 'REJECTED', reviewNote: body.note.trim(), reviewedAt: new Date() },
    });
    if (!result.count) throw new BadRequestException('These account details changed or were already reviewed. Refresh the queue.');
    await this.audit.record({ userId: auth.user.id, action: body.approve ? 'PAYOUT_ACCOUNT_VERIFIED' : 'PAYOUT_ACCOUNT_REJECTED', entityType: 'PayoutAccount', entityId: id, req });
    return { ok: true };
  }

  @Get('hub/monetisation/payout-quote')
  @RequireAuth()
  async quote(@CurrentAuth() auth: AuthContext) {
    const ch = await this.channel(auth);
    const account = await this.prisma.payoutAccount.findUnique({ where: { channelId: ch.id } });
    if (account?.status !== 'VERIFIED') throw new BadRequestException('Your payout account needs review before a withdrawal.');
    const settings = this.billing.cfg.billing.payouts;
    if (!settings) throw new BadRequestException('Withdrawals are waiting for the operator to set a payout exchange rate and fee.');
    const bal = await this.prisma.creatorBalance.findUnique({ where: { channelId: ch.id } });
    const min = BigInt((await this.billing.settings()).payoutMinUsdCents);
    if (!bal || bal.currency !== 'USD' || bal.confirmedBalanceCents < min) throw new BadRequestException('Your available USD balance is below the withdrawal minimum.');
    const quote = makeQuote(ch.id, account.version, bal.confirmedBalanceCents, settings.rwfPerUsd, settings.feeRwf, this.billing.cfg.sessionSecret);
    return { quote, destination: { country: account.country, currency: 'RWF', account: account.accountIdentifier, name: account.accountHolderName }, processing: 'Reviewed and sent by Free Me. A request is not a completed transfer.' };
  }

  @Post('hub/monetisation/payouts')
  @RequireAuth()
  async withdraw(@CurrentAuth() auth: AuthContext, @Body() body: WithdrawDto, @Req() req: AppRequest) {
    const ch = await this.channel(auth);
    const q = readQuote(body.quoteToken, this.billing.cfg.sessionSecret);
    if (q.channelId !== ch.id) throw new ForbiddenException('This withdrawal preview belongs to another creator.');
    const key = `${ch.id}:${q.id}`;
    const minimum = BigInt((await this.billing.settings()).payoutMinUsdCents);
    const p = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Channel" WHERE id = ${ch.id} FOR UPDATE`;
      const previous = await tx.payout.findUnique({ where: { idempotencyKey: key } });
      if (previous) return previous;
      if (!this.billing.cfg.billing.payouts || q.expiresAt < Date.now()) throw new BadRequestException('This withdrawal preview expired. Preview it again.');
      const account = await tx.payoutAccount.findUnique({ where: { channelId: ch.id } });
      if (account?.status !== 'VERIFIED' || account.version !== q.accountVersion) throw new BadRequestException('Your payout details changed. Review them and preview again.');
      const amount = BigInt(q.amountCents);
      const balance = await tx.creatorBalance.findUnique({ where: { channelId: ch.id } });
      if (!balance || balance.currency !== 'USD' || amount < minimum || balance.confirmedBalanceCents !== amount) throw new BadRequestException('Your balance changed. Preview the withdrawal again.');
      if (await tx.payout.count({ where: { channelId: ch.id, status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } } })) throw new BadRequestException('A withdrawal is already awaiting completion.');
      const took = await tx.creatorBalance.updateMany({ where: { channelId: ch.id, confirmedBalanceCents: amount }, data: { confirmedBalanceCents: { decrement: amount }, withdrawnCents: { increment: amount } } });
      if (!took.count) throw new BadRequestException('Your balance changed. Preview again.');
      const payout = await tx.payout.create({ data: {
        channelId: ch.id, idempotencyKey: key, amountCents: amount, currency: 'USD', method: 'MOBILE_MONEY',
        provider: 'mtn_momo', accountIdentifier: account.accountIdentifier, accountHolderName: account.accountHolderName,
        destinationCurrency: 'RWF', destinationAmount: BigInt(q.receiveRwf), feeAmount: BigInt(q.feeRwf), exchangeRate: q.rwfPerUsd,
      } });
      await tx.revenueLedger.create({ data: { channelId: ch.id, sourceType: 'PAYOUT_DEDUCTION', referenceId: payout.id, currency: 'USD', grossAmountCents: -amount, creatorShareCents: -amount, platformShareCents: 0n, reinvestShareCents: 0n, splitBps: '-', balanceAfterCents: 0n, description: 'Reserved for withdrawal to your reviewed mobile money account' } });
      return payout;
    });
    await this.audit.record({ userId: auth.user.id, action: 'PAYOUT_REQUESTED', entityType: 'Payout', entityId: p.id, req });
    return { payout: payoutView(p) };
  }

  @Post('admin/billing/payouts/:id')
  @HttpCode(200)
  @RequireAuth('ADMIN')
  async decide(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto, @Req() req: AppRequest) {
    const reference = body.reference?.trim(), reason = body.reason?.trim();
    if (body.action === 'paid' ? !reference : !reason) throw new BadRequestException(body.action === 'paid' ? 'Enter the completed transfer reference.' : 'Say why the money is being returned.');
    const p = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payout" WHERE id = ${id} FOR UPDATE`;
      const payout = await tx.payout.findUnique({ where: { id } });
      if (!payout) throw new NotFoundException('Withdrawal not found.');
      if (payout.status === 'PAID' || payout.status === 'REJECTED') throw new BadRequestException('This withdrawal is already settled.');
      const result = await tx.payout.update({ where: { id }, data: body.action === 'paid'
        ? { status: 'PAID', referenceTransactionId: reference, processedAt: new Date() }
        : { status: 'REJECTED', rejectionReason: reason, processedAt: new Date() } });
      if (body.action === 'reject') {
        const balance = await tx.creatorBalance.update({ where: { channelId: payout.channelId }, data: { confirmedBalanceCents: { increment: payout.amountCents }, withdrawnCents: { decrement: payout.amountCents } } });
        await tx.revenueLedger.create({ data: { channelId: payout.channelId, sourceType: 'PAYOUT_REVERSAL', referenceId: payout.id, currency: payout.currency, grossAmountCents: payout.amountCents, creatorShareCents: payout.amountCents, platformShareCents: 0n, reinvestShareCents: 0n, splitBps: '-', balanceAfterCents: balance.confirmedBalanceCents, description: `Withdrawal returned: ${reason}` } });
      }
      return result;
    });
    await this.audit.record({ userId: auth.user.id, action: body.action === 'paid' ? 'PAYOUT_PAID' : 'PAYOUT_REJECTED', entityType: 'Payout', entityId: id, req });
    return { payout: payoutView(p) };
  }
}
