import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import type { Payout } from '@prisma/client';
import { PROPOSED_SPLIT } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { BillingService, paymentView, premiumView } from './billing.controller';
import { EARNINGS_CURRENCY, hasAdBadge, isPremium, msisdn, PREMIUM_MONTHS, utcDay } from './billing';
import { MAX_ADS_PER_VIDEO } from './ads.controller';

class PayoutDto {
  @ApiProperty({ description: 'MTN Mobile Money number to receive the money' }) @IsString() @Length(6, 24) phone!: string;
  @ApiProperty() @IsString() @Length(2, 100) accountHolderName!: string;
}
class ReviewDto {
  @IsOptional() @IsBoolean() verifyBusiness?: boolean;
  @ApiProperty() @IsBoolean() approve!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ description: 'Approve an unpaid ad without payment (a test, a partner or Free Me itself). It runs at $0 a day, so it adds nothing to the revenue shared with creators.' }) @IsOptional() @IsBoolean() free?: boolean;
}
class PayoutDecisionDto {
  @ApiProperty({ enum: ['paid', 'reject'] }) @IsIn(['paid', 'reject']) action!: 'paid' | 'reject';
  @ApiPropertyOptional({ description: 'Transfer reference (paid)' }) @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @ApiPropertyOptional({ description: 'Why (reject)' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class GrantDto { @ApiProperty() @IsEmail() email!: string; @ApiProperty({ enum: PREMIUM_MONTHS }) @IsInt() @Min(1) @Max(12) months!: number }

class SuspendDto {
  @IsString() @Length(1, 50) handle!: string;
  @IsString() @Length(5, 500) reason!: string;
}

class VerificationDto {
  @IsString() @Length(1, 50) handle!: string;
  @IsBoolean() verified!: boolean;
}

const payoutView = (p: Payout) => ({ id: p.id, amountCents: Number(p.amountCents), currency: p.currency, method: p.method, account: p.accountIdentifier, accountHolderName: p.accountHolderName, status: p.status, reference: p.referenceTransactionId, rejectionReason: p.rejectionReason, requestedAt: p.requestedAt, processedAt: p.processedAt });

const REQUIREMENTS = { followers: 1_000, views: 10_000, momentViews: 50_000, watchHours: 4_000, sparks: 10_000 };

async function eligibilityProgress(prisma: PrismaService, channelId: string, userId: string) {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const publicVideo = { channelId, status: 'READY' as const, visibility: 'PUBLIC' as const, takenDownAt: null, isAd: false };
  const [followers, stats, moments, sparks, removals] = await Promise.all([
    prisma.subscription.count({ where: { channelId, userId: { not: userId }, user: { status: 'ACTIVE' } } }),
    prisma.videoDailyStat.aggregate({ where: { day: { gte: utcDay(since) }, video: { ...publicVideo, isShort: false } }, _sum: { views: true, watchSeconds: true } }),
    prisma.videoDailyStat.aggregate({ where: { day: { gte: utcDay(since) }, video: { ...publicVideo, isShort: true } }, _sum: { views: true } }),
    prisma.like.count({ where: { createdAt: { gte: since }, isLike: true, userId: { not: userId }, user: { status: 'ACTIVE' }, video: publicVideo } }),
    prisma.video.count({ where: { channelId, takenDownAt: { gt: since } } }),
  ]);
  const current = { followers, views: stats._sum.views ?? 0, momentViews: moments._sum.views ?? 0, watchHours: Number(stats._sum.watchSeconds ?? 0n) / 3600, sparks };
  return { current, required: REQUIREMENTS, canApply: !removals && Object.entries(REQUIREMENTS).every(([key, minimum]) => current[key as keyof typeof current] >= minimum), recentRemovals: removals };
}

@ApiTags('monetisation')
@Controller('hub/monetisation')
@RequireAuth()
export class MonetisationController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  private async channel(auth: AuthContext) {
    const ch = await this.prisma.channel.findUnique({ where: { userId: auth.user.id }, include: { eligibility: true, balance: true } });
    if (!ch) throw new NotFoundException('Create your Space first.');
    return ch;
  }

  @Get()
  @ApiOperation({ summary: 'My monetisation: membership, status, balance, daily earnings, payouts' })
  async status(@CurrentAuth() auth: AuthContext) {
    const ch = await this.channel(auth);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    const since = new Date(utcDay(new Date()).getTime() - 27 * 86_400_000);
    const [ledger, payouts, progress, impressions] = await Promise.all([
      this.prisma.revenueLedger.findMany({ where: { channelId: ch.id }, orderBy: { createdAt: 'desc' }, take: 60 }),
      this.prisma.payout.findMany({ where: { channelId: ch.id }, orderBy: { requestedAt: 'desc' }, take: 30 }),
      eligibilityProgress(this.prisma, ch.id, auth.user.id),
      this.prisma.adImpression.count({ where: { video: { channelId: ch.id }, createdAt: { gte: since } } }),
    ]);
    const b = await this.billing.settings();
    return {
      premium: premiumView(u), joined: !!ch.eligibility?.isEligible, joinedAt: ch.eligibility?.approvedAt ?? null,
      earning: !!ch.eligibility?.isEligible,
      eligibility: { ...progress, suspended: !!ch.eligibility?.suspendedAt, pending: !!ch.eligibility?.appliedForMonetization && !ch.eligibility.isEligible && !ch.eligibility.rejectionReason, rejectionReason: ch.eligibility?.rejectionReason ?? null },
      balance: { currency: ch.balance?.currency ?? EARNINGS_CURRENCY, availableCents: Number(ch.balance?.confirmedBalanceCents ?? 0n), lifetimeCents: Number(ch.balance?.lifetimeEarningsCents ?? 0n), withdrawnCents: Number(ch.balance?.withdrawnCents ?? 0n) },
      adsShownLast28Days: impressions,
      earnings: ledger.map((l) => ({ id: l.id, kind: l.sourceType, amountCents: Number(l.creatorShareCents), day: l.referenceId, description: l.description, at: l.createdAt })),
      payouts: payouts.map(payoutView),
      programme: { creatorShareBps: PROPOSED_SPLIT.creatorPoolBps, adDayUsdCents: b.adDayUsdCents, maxAdsPerVideo: MAX_ADS_PER_VIDEO, payoutMinimumUsdCents: b.payoutMinUsdCents, premiumUsdCents: b.premiumUsdCents },
    };
  }

  @Get('earn')
  async earn(@CurrentAuth() auth: AuthContext) {
    const ch = await this.channel(auth);
    const day = utcDay(new Date());
    const [estimate, activity] = await Promise.all([
      this.billing.adDayShares(day),
      this.prisma.$queryRaw<Array<{ campaignId: string; campaign: string; videoId: string; video: string; impressions: bigint }>>`
        SELECT c.id AS "campaignId", c.headline AS campaign, v.id AS "videoId", v.title AS video, count(*)::bigint AS impressions
        FROM "AdImpression" i JOIN "Campaign" c ON c.id = i."campaignId" JOIN "Video" v ON v.id = i."videoId"
        WHERE v."channelId" = ${ch.id} AND i."createdAt" >= ${day.toISOString()}::timestamp
        GROUP BY c.id, v.id ORDER BY impressions DESC, c.id, v.id LIMIT 20`,
    ]);
    return {
      day: day.toISOString().slice(0, 10),
      estimatedCents: Number(estimate.shares[ch.id] ?? 0n),
      impressions: Number(estimate.rows.find((row) => row.channelId === ch.id)?.n ?? 0n),
      activity: activity.map((row) => ({ ...row, impressions: Number(row.impressions) })),
    };
  }

  @Post('join')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply for creator monetisation after meeting the audience requirements' })
  async join(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const ch = await this.channel(auth);
    if (ch.eligibility?.isEligible || (ch.eligibility?.appliedForMonetization && !ch.eligibility.rejectionReason)) return this.status(auth);
    const progress = await eligibilityProgress(this.prisma, ch.id, auth.user.id);
    if (!progress.canApply && !ch.eligibility?.suspendedAt) throw new ForbiddenException('Meet the audience requirements and resolve any recent content removals before applying.');
    await this.prisma.creatorEligibility.upsert({
      where: { channelId: ch.id },
      create: { channelId: ch.id, appliedForMonetization: true, subscribersRequired: REQUIREMENTS.followers, watchHoursRequired: REQUIREMENTS.watchHours },
      update: { appliedForMonetization: true, rejectionReason: null },
    });
    await this.audit.record({ userId: auth.user.id, action: 'MONETISATION_APPLIED', entityType: 'Channel', entityId: ch.id, req });
    return this.status(auth);
  }

  @Post('payouts')
  @ApiOperation({ summary: 'Withdraw my whole available balance to MTN Mobile Money' })
  async payout(@CurrentAuth() auth: AuthContext, @Body() body: PayoutDto, @Req() req: AppRequest) {
    const ch = await this.channel(auth);
    const phone = msisdn(body.phone, 'RWF');
    if (!phone) throw new BadRequestException('Enter a mobile money number, e.g. 0788 123 456 or +250 788 123 456.');
    const min = BigInt((await this.billing.settings()).payoutMinUsdCents);
    const p = await this.prisma.$transaction(async (tx) => {
      const bal = await tx.creatorBalance.findUnique({ where: { channelId: ch.id } });
      const amount = bal?.confirmedBalanceCents ?? 0n;
      if (amount < min) throw new BadRequestException(`You can withdraw once your balance reaches $${(Number(min) / 100).toFixed(2)}.`);
      if (await tx.payout.count({ where: { channelId: ch.id, status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } } })) throw new BadRequestException('A withdrawal is already on its way.');
      // Only take the money if the balance is still what we read (two requests at once cannot both withdraw it).
      const took = await tx.creatorBalance.updateMany({ where: { channelId: ch.id, confirmedBalanceCents: amount }, data: { confirmedBalanceCents: { decrement: amount }, withdrawnCents: { increment: amount } } });
      if (!took.count) throw new BadRequestException('Your balance just changed. Please try again.');
      const payout = await tx.payout.create({ data: { channelId: ch.id, amountCents: amount, currency: bal!.currency, method: 'MOBILE_MONEY', provider: 'mtn_momo', accountIdentifier: phone, accountHolderName: body.accountHolderName.trim() } });
      await tx.revenueLedger.create({ data: { channelId: ch.id, sourceType: 'PAYOUT_DEDUCTION', referenceId: payout.id, currency: bal!.currency, grossAmountCents: -amount, creatorShareCents: -amount, platformShareCents: 0n, reinvestShareCents: 0n, splitBps: '-', balanceAfterCents: 0n, description: `Withdrawal to mobile money ${phone.slice(0, 3)}…${phone.slice(-3)}` } });
      return payout;
    });
    await this.audit.record({ userId: auth.user.id, action: 'PAYOUT_REQUESTED', entityType: 'Payout', entityId: p.id, req, details: { amountCents: Number(p.amountCents) } });
    return { payout: payoutView(p) };
  }
}

@ApiTags('admin')
@Controller('admin/billing')
@RequireAuth('ADMIN')
export class AdminBillingController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Money at a glance: members, income in the last 30 days, work waiting' })
  async summary() {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [members, income, reviews, payouts, days] = await Promise.all([
      this.prisma.user.count({ where: { premiumUntil: { gt: new Date() } } }),
      this.prisma.payment.groupBy({ by: ['purpose'], where: { status: 'SUCCEEDED', paidAt: { gte: since } }, _sum: { usdCents: true }, _count: true }),
      this.prisma.campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      this.prisma.payout.count({ where: { status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } } }),
      this.prisma.adDaySettlement.findMany({ orderBy: { day: 'desc' }, take: 14 }),
    ]);
    const sum = (p: 'PREMIUM' | 'AD_CAMPAIGN') => income.find((i) => i.purpose === p)?._sum.usdCents ?? 0;
    return {
      premiumMembers: members, last30Days: { premiumUsdCents: sum('PREMIUM'), adsUsdCents: sum('AD_CAMPAIGN'), payments: income.reduce((a, i) => a + i._count, 0) },
      waiting: { adReviews: reviews, payouts },
      settlements: days.map((d) => ({ day: d.day.toISOString().slice(0, 10), grossCents: Number(d.grossCents), creatorPoolCents: Number(d.creatorPoolCents), paidToCreatorsCents: Number(d.allocatedCents), impressions: d.impressions, channels: d.channels })),
      methods: await this.billing.methods(),
    };
  }

  @Post('monetisation/suspend')
  @HttpCode(200)
  async suspend(@CurrentAuth() auth: AuthContext, @Body() body: SuspendDto, @Req() req: AppRequest) {
    const handle = body.handle.trim().toLowerCase().replace(/^@/, '');
    const channel = await this.prisma.channel.findUnique({ where: { handle } });
    if (!channel) throw new NotFoundException('Channel not found.');
    if (body.reason.trim().length < 5) throw new BadRequestException('Explain the in-video advertising violation.');
    const suspended = await this.prisma.creatorEligibility.updateMany({
      where: { channelId: channel.id, isEligible: true },
      data: { isEligible: false, suspendedAt: new Date(), appliedForMonetization: false, rejectionReason: body.reason.trim() },
    });
    if (!suspended.count) throw new BadRequestException('This channel is not currently monetised.');
    await this.audit.record({ userId: auth.user.id, action: 'MONETISATION_SUSPENDED', entityType: 'Channel', entityId: channel.id, req, details: { reason: body.reason.trim() } });
    return { ok: true };
  }

  @Get('applications')
  async applications() {
    return { applications: await this.prisma.creatorEligibility.findMany({
      where: { appliedForMonetization: true, isEligible: false, rejectionReason: null },
      include: { channel: { select: { id: true, handle: true, name: true } } },
      orderBy: { updatedAt: 'asc' }, take: 100,
    }) };
  }

  @Post('applications/:id/review')
  @HttpCode(200)
  async reviewApplication(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDto, @Req() req: AppRequest) {
    const application = await this.prisma.creatorEligibility.findUnique({ where: { id }, include: { channel: true } });
    if (!application) throw new NotFoundException('Application not found.');
    const note = body.note?.trim();
    if (!body.approve && !note) throw new BadRequestException('Enter a reason for declining the application.');
    if (body.approve && !application.suspendedAt && !(await eligibilityProgress(this.prisma, application.channelId, application.channel.userId)).canApply) {
      throw new BadRequestException('This channel no longer meets the requirements.');
    }
    const reviewed = await this.prisma.creatorEligibility.updateMany({
      where: { id, appliedForMonetization: true, isEligible: false, rejectionReason: null },
      data: { isEligible: body.approve, suspendedAt: body.approve ? null : application.suspendedAt, approvedAt: body.approve ? new Date() : null, rejectionReason: body.approve ? null : note },
    });
    if (!reviewed.count) throw new BadRequestException('This application has already been reviewed.');
    await this.audit.record({ userId: auth.user.id, action: body.approve ? 'MONETISATION_APPROVED' : 'MONETISATION_DECLINED', entityType: 'Channel', entityId: application.channelId, req });
    return { ok: true };
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'Ad campaigns (default: waiting for review)' })
  async campaigns(@Query('status') status = 'PENDING_REVIEW') {
    const rows = await this.prisma.campaign.findMany({ where: status === 'all' ? {} : { status: status as never }, orderBy: { createdAt: 'desc' }, take: 100, include: { advertiser: { include: { user: { select: { email: true } } } } } });
    const videos = new Map((await this.prisma.video.findMany({ where: { id: { in: rows.map((r) => r.videoId!).filter(Boolean) } }, select: { id: true, title: true, durationSeconds: true } })).map((v) => [v.id, v]));
    return { campaigns: rows.map((c) => ({ id: c.id, status: c.status, businessName: c.advertiser.businessName, registrationNumber: c.advertiser.registrationNumber, businessVerified: c.advertiser.isVerified, email: c.advertiser.user.email, country: c.advertiser.country, headline: c.headline, destinationUrl: c.destinationUrl, days: c.days, totalCents: c.days * c.dailyRateCents, targetCountries: c.targetCountries, video: c.videoId ? videos.get(c.videoId) ?? null : null, impressions: Number(c.impressionsCount), clicks: Number(c.clicksCount), reviewNote: c.reviewNote, createdAt: c.createdAt })) };
  }

  @Post('campaigns/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve (it starts now and runs for the days bought) or reject a paid campaign; or, with free, approve an unpaid one without payment' })
  async review(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDto, @Req() req: AppRequest) {
    const c = await this.prisma.campaign.findUnique({ where: { id }, include: { advertiser: true } });
    if (!c) throw new NotFoundException('Campaign not found.');
    const free = body.free === true && body.approve;
    if (free ? c.status !== 'DRAFT' && c.status !== 'PENDING_REVIEW' : c.status !== 'PENDING_REVIEW') throw new BadRequestException(free ? 'Only an ad that is not running yet can be approved without payment.' : 'This campaign is not waiting for review.');
    if (!body.approve && !body.note?.trim()) throw new BadRequestException('Say why it is rejected; the business will see it.');
    const now = new Date();
    if (body.approve && c.advertiser.registrationNumber && !c.advertiser.isVerified && !body.verifyBusiness) {
      throw new BadRequestException('Verify the business registration before approving the campaign.');
    }
    await this.prisma.$transaction(async (tx) => {
      // Match the reviewed registration to avoid approving a stale business profile.
      if (body.approve && c.advertiser.registrationNumber) {
        const verified = await tx.advertiser.updateMany({ where: { id: c.advertiserId, registrationNumber: c.advertiser.registrationNumber, businessName: c.advertiser.businessName, country: c.advertiser.country }, data: { isVerified: true } });
        if (!verified.count) throw new BadRequestException('The business details changed. Review them again.');
      }
      const result = await tx.campaign.updateMany({ where: { id, status: c.status }, data: body.approve
      ? { status: 'ACTIVE', reviewedAt: now, startDate: now, endDate: new Date(now.getTime() + c.days * 86_400_000), reviewNote: body.note?.trim() || (free ? 'Approved without payment by Free Me' : null),
        // Unpaid: $0 a day, so no revenue (and nothing for creators) is counted for money that never came in.
        ...(free && c.status === 'DRAFT' ? { dailyRateCents: 0 } : {}) }
      : { status: 'REJECTED', reviewedAt: now, reviewNote: body.note!.trim() } });
      if (!result.count) throw new BadRequestException('The campaign status changed. Refresh and try again.');
    });
    await this.audit.record({ userId: auth.user.id, action: free ? 'AD_APPROVED_FREE' : body.approve ? 'AD_APPROVED' : 'AD_REJECTED', entityType: 'Campaign', entityId: id, req, details: { note: body.note ?? null } });
    return { ok: true };
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Creator withdrawals (default: waiting)' })
  async payouts(@Query('status') status = 'open') {
    const rows = await this.prisma.payout.findMany({ where: status === 'open' ? { status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } } : {}, orderBy: { requestedAt: 'desc' }, take: 100, include: { channel: { select: { handle: true, name: true } } } });
    return { payouts: rows.map((p) => ({ ...payoutView(p), channel: p.channel })) };
  }

  @Post('payouts/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a withdrawal as sent (with the transfer reference) or reject it (the money returns to the balance)' })
  async decide(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PayoutDecisionDto, @Req() req: AppRequest) {
    const p = await this.prisma.payout.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Withdrawal not found.');
    if (p.status === 'PAID' || p.status === 'REJECTED') throw new BadRequestException('This withdrawal is already settled.');
    if (body.action === 'paid') {
      if (!body.reference?.trim()) throw new BadRequestException('Enter the transfer reference.');
      await this.prisma.payout.update({ where: { id }, data: { status: 'PAID', referenceTransactionId: body.reference.trim(), processedAt: new Date() } });
    } else {
      if (!body.reason?.trim()) throw new BadRequestException('Say why; the creator will see it.');
      await this.prisma.$transaction(async (tx) => {
        await tx.payout.update({ where: { id }, data: { status: 'REJECTED', rejectionReason: body.reason!.trim(), processedAt: new Date() } });
        const bal = await tx.creatorBalance.update({ where: { channelId: p.channelId }, data: { confirmedBalanceCents: { increment: p.amountCents }, withdrawnCents: { decrement: p.amountCents } } });
        await tx.revenueLedger.create({ data: { channelId: p.channelId, sourceType: 'PAYOUT_REVERSAL', referenceId: p.id, currency: p.currency, grossAmountCents: p.amountCents, creatorShareCents: p.amountCents, platformShareCents: 0n, reinvestShareCents: 0n, splitBps: '-', balanceAfterCents: bal.confirmedBalanceCents, description: `Withdrawal returned: ${body.reason!.trim()}` } });
      });
    }
    await this.audit.record({ userId: auth.user.id, action: body.action === 'paid' ? 'PAYOUT_PAID' : 'PAYOUT_REJECTED', entityType: 'Payout', entityId: id, req, details: { reference: body.reference ?? null, reason: body.reason ?? null } });
    return { payout: payoutView((await this.prisma.payout.findUniqueOrThrow({ where: { id } }))) };
  }

  @Post('premium')
  @HttpCode(200)
  @ApiOperation({ summary: 'Give someone Premium without payment (gifts, partners)' })
  async grant(@CurrentAuth() auth: AuthContext, @Body() body: GrantDto, @Req() req: AppRequest) {
    const u = await this.prisma.user.findUnique({ where: { email: body.email.trim().toLowerCase() } });
    if (!u) throw new NotFoundException('No account uses this email. They need to sign in once first.');
    await this.billing.grantPremium(u.id, body.months);
    await this.audit.record({ userId: auth.user.id, action: 'PREMIUM_GRANTED', entityType: 'User', entityId: u.id, req, details: { months: body.months } });
    return { premium: premiumView(await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } })) };
  }

  @Post('verification')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set or remove an administrator-issued verification badge' })
  async verification(@CurrentAuth() auth: AuthContext, @Body() body: VerificationDto, @Req() req: AppRequest) {
    const handle = body.handle.trim().toLowerCase().replace(/^@/, '');
    const channel = await this.prisma.channel.findUnique({ where: { handle }, select: { id: true, userId: true } });
    if (!channel) throw new NotFoundException('No Space uses this handle.');
    const badge = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${channel.userId} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: channel.userId } });
      const source = body.verified ? 'ADMIN' : isPremium(user) ? 'PREMIUM' : hasAdBadge(user) ? 'AD_BADGE' : null;
      return tx.channel.update({
        where: { id: channel.id }, data: { isVerified: source !== null, verificationSource: source },
        select: { isVerified: true, verificationSource: true },
      });
    });
    await this.audit.record({ userId: auth.user.id, action: body.verified ? 'VERIFICATION_GRANTED' : 'VERIFICATION_REMOVED', entityType: 'Channel', entityId: channel.id, req });
    return { badge };
  }

  @Get('payments')
  @ApiOperation({ summary: 'Recent payments' })
  async payments() {
    const rows = await this.prisma.payment.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { user: { select: { email: true } } } });
    return { payments: rows.map((p) => ({ ...paymentView(p), email: p.user.email })) };
  }
}
