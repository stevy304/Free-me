import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { payoutView } from './payouts';
import { PROPOSED_SPLIT } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { BillingService, paymentView, premiumView } from './billing.controller';
import { EARNINGS_CURRENCY, hasPremiumAccess, isPremium, PREMIUM_MONTHS, premiumPriceFor, utcDay } from './billing';
import { MAX_ADS_PER_VIDEO } from './ads.controller';

class ReviewDto {
  @ApiProperty() @IsBoolean() approve!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ description: 'Approve an unpaid ad without payment (a test, a partner or Free Me itself). It runs at $0 a day, so it adds nothing to the revenue shared with creators.' }) @IsOptional() @IsBoolean() free?: boolean;
}
class GrantDto { @ApiProperty() @IsEmail() email!: string; @ApiProperty({ enum: PREMIUM_MONTHS }) @IsInt() @Min(1) @Max(12) months!: number }

class VerificationDto {
  @IsString() @Length(1, 50) handle!: string;
  @IsBoolean() verified!: boolean;
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
    const [ledger, payouts, impressions, reserved, paid] = await Promise.all([
      this.prisma.revenueLedger.findMany({ where: { channelId: ch.id }, orderBy: { createdAt: 'desc' }, take: 60 }),
      this.prisma.payout.findMany({ where: { channelId: ch.id }, orderBy: { requestedAt: 'desc' }, take: 30 }),
      this.prisma.adImpression.count({ where: { video: { channelId: ch.id }, createdAt: { gte: since } } }),
      this.prisma.payout.aggregate({ where: { channelId: ch.id, status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } }, _sum: { amountCents: true } }),
      this.prisma.payout.aggregate({ where: { channelId: ch.id, status: 'PAID' }, _sum: { amountCents: true } }),
    ]);
    const b = await this.billing.settings();
    return {
      premium: premiumView(u), joined: !!ch.eligibility?.isEligible, joinedAt: ch.eligibility?.approvedAt ?? null,
      earning: !!ch.eligibility?.isEligible && hasPremiumAccess(u),
      balance: { currency: ch.balance?.currency ?? EARNINGS_CURRENCY, availableCents: Number(ch.balance?.confirmedBalanceCents ?? 0n), lifetimeCents: Number(ch.balance?.lifetimeEarningsCents ?? 0n), withdrawnCents: Number(ch.balance?.withdrawnCents ?? 0n), reservedCents: Number(reserved._sum.amountCents ?? 0n), paidCents: Number(paid._sum.amountCents ?? 0n), pendingCents: Number(ch.balance?.pendingBalanceCents ?? 0n) },
      adsShownLast28Days: impressions,
      earnings: ledger.map((l) => ({ id: l.id, kind: l.sourceType, amountCents: Number(l.creatorShareCents), day: l.referenceId, description: l.description, at: l.createdAt })),
      payouts: payouts.map(payoutView),
      programme: { creatorShareBps: PROPOSED_SPLIT.creatorPoolBps, adDayUsdCents: b.adDayUsdCents, maxAdsPerVideo: MAX_ADS_PER_VIDEO, payoutMinimumUsdCents: b.payoutMinUsdCents, premiumUsdCents: premiumPriceFor(b, (await this.prisma.profile.findUnique({ where: { userId: u.id }, select: { country: true } }))?.country) },
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
  @ApiOperation({ summary: 'Join the monetisation programme (Premium members with no recent removals)' })
  async join(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const ch = await this.channel(auth);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!hasPremiumAccess(u)) throw new ForbiddenException('Monetisation is part of Premium. Upgrade to start earning from ads on your videos.');
    const strikes = await this.prisma.video.count({ where: { channelId: ch.id, takenDownAt: { gt: new Date(Date.now() - 90 * 86_400_000) } } });
    if (strikes) throw new ForbiddenException('A video of yours was removed in the last 90 days. You can join once 90 days have passed since the last removal.');
    await this.prisma.creatorEligibility.upsert({
      where: { channelId: ch.id }, create: { channelId: ch.id, isEligible: true, appliedForMonetization: true, approvedAt: new Date(), subscribersRequired: 0, watchHoursRequired: 0 },
      update: { isEligible: true, appliedForMonetization: true, approvedAt: new Date(), rejectionReason: null },
    });
    await this.audit.record({ userId: auth.user.id, action: 'MONETISATION_JOINED', entityType: 'Channel', entityId: ch.id, req });
    return this.status(auth);
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

  @Get('campaigns')
  @ApiOperation({ summary: 'Ad campaigns (default: waiting for review)' })
  async campaigns(@Query('status') status = 'PENDING_REVIEW') {
    const rows = await this.prisma.campaign.findMany({ where: status === 'all' ? {} : { status: status as never }, orderBy: { createdAt: 'desc' }, take: 100, include: { advertiser: { include: { user: { select: { email: true } } } } } });
    const videos = new Map((await this.prisma.video.findMany({ where: { id: { in: rows.map((r) => r.videoId!).filter(Boolean) } }, select: { id: true, title: true, durationSeconds: true } })).map((v) => [v.id, v]));
    return { campaigns: rows.map((c) => ({ id: c.id, status: c.status, businessName: c.advertiser.businessName, email: c.advertiser.user.email, country: c.advertiser.country, headline: c.headline, destinationUrl: c.destinationUrl, days: c.days, totalCents: c.days * c.dailyRateCents, targetCountries: c.targetCountries, video: c.videoId ? videos.get(c.videoId) ?? null : null, impressions: Number(c.impressionsCount), clicks: Number(c.clicksCount), reviewNote: c.reviewNote, createdAt: c.createdAt })) };
  }

  @Post('campaigns/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve (it starts now and runs for the days bought) or reject a paid campaign; or, with free, approve an unpaid one without payment' })
  async review(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDto, @Req() req: AppRequest) {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Campaign not found.');
    const free = body.free === true && body.approve;
    if (free ? c.status !== 'DRAFT' && c.status !== 'PENDING_REVIEW' : c.status !== 'PENDING_REVIEW') throw new BadRequestException(free ? 'Only an ad that is not running yet can be approved without payment.' : 'This campaign is not waiting for review.');
    if (!body.approve && !body.note?.trim()) throw new BadRequestException('Say why it is rejected; the business will see it.');
    const now = new Date();
    await this.prisma.campaign.update({ where: { id }, data: body.approve
      ? { status: 'ACTIVE', reviewedAt: now, startDate: now, endDate: new Date(now.getTime() + c.days * 86_400_000),
        // Priced per 1,000 views: views not delivered in the days bought may still be delivered for as many days again.
        deliverUntil: c.cpmRateCents ? new Date(now.getTime() + 2 * c.days * 86_400_000) : null, reviewNote: body.note?.trim() || (free ? 'Approved without payment by Free Me' : null),
        // Unpaid: $0 a day, so no revenue (and nothing for creators) is counted for money that never came in.
        ...(free && c.status === 'DRAFT' ? { dailyRateCents: 0 } : {}) }
      : { status: 'REJECTED', reviewedAt: now, reviewNote: body.note!.trim() } });
    await this.audit.record({ userId: auth.user.id, action: free ? 'AD_APPROVED_FREE' : body.approve ? 'AD_APPROVED' : 'AD_REJECTED', entityType: 'Campaign', entityId: id, req, details: { note: body.note ?? null } });
    return { ok: true };
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Creator withdrawals (default: waiting)' })
  async payouts(@Query('status') status = 'open') {
    const rows = await this.prisma.payout.findMany({ where: status === 'open' ? { status: { in: ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] } } : {}, orderBy: { requestedAt: 'desc' }, take: 100, include: { channel: { select: { handle: true, name: true } } } });
    return { payouts: rows.map((p) => ({ ...payoutView(p), channel: p.channel })) };
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

  @Post('creator-pass')
  @HttpCode(200)
  @ApiOperation({ summary: 'Give someone the Creator pass without payment (creators invited at launch, partners)' })
  async grantPass(@CurrentAuth() auth: AuthContext, @Body() body: GrantDto, @Req() req: AppRequest) {
    const u = await this.prisma.user.findUnique({ where: { email: body.email.trim().toLowerCase() } });
    if (!u) throw new NotFoundException('No account uses this email. They need to sign in once first.');
    await this.billing.grantCreatorPass(u.id, body.months);
    await this.audit.record({ userId: auth.user.id, action: 'CREATOR_PASS_GRANTED', entityType: 'User', entityId: u.id, req, details: { months: body.months } });
    return { creatorPass: { until: (await this.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).creatorPassUntil } };
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
      const source = body.verified ? 'ADMIN' : isPremium(user) ? 'PREMIUM' : null;
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
