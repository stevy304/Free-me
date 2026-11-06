import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, IsUrl, Length, Max, Min } from 'class-validator';
import type { Advertiser, Campaign, Video } from '@prisma/client';
import { isCountryCode } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, type AppRequest, type AuthContext } from '../common/request';
import { LINKED_VIDEO } from '../catalog/serialize';
import { MediaUrls } from '../videos/media-urls';
import { BillingService, PayDto, paymentView } from './billing.controller';
import { EARNINGS_CURRENCY, hasPremiumAccess } from './billing';

/** Ads show only on monetised channels: at most two per video (one before it, one halfway through long videos). */
export const MAX_ADS_PER_VIDEO = 2;
/** Videos at least this long also get an ad halfway through. */
export const MID_ROLL_MIN_SECONDS = 8 * 60;
export const AD_MIN_SECONDS = 5;
export const AD_MAX_SECONDS = 90;
export const SKIP_AFTER_SECONDS = 5;

class CampaignDto {
  @ApiProperty() @IsString() @Length(2, 100) businessName!: string;
  @ApiProperty({ description: 'ISO 3166-1 alpha-2' }) @IsString() @Length(2, 2) country!: string;
  @ApiProperty({ description: 'Short line shown with the ad' }) @IsString() @Length(3, 90) headline!: string;
  @ApiProperty({ description: 'Where "Visit" leads (https)' }) @IsUrl({ protocols: ['https'], require_protocol: true }) destinationUrl!: string;
  @ApiProperty({ description: 'One of your own videos, public or unlisted, 5–90 seconds' }) @IsUUID() videoId!: string;
  @ApiProperty({ minimum: 1, maximum: 90 }) @IsInt() @Min(1) @Max(90) days!: number;
  @ApiPropertyOptional({ description: 'Countries to show it in; empty = everywhere' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) targetCountries?: string[];
}
class ImpressionDto { @ApiProperty() @IsUUID() campaignId!: string; @ApiProperty() @IsUUID() videoId!: string }
class AdEventDto { @ApiProperty({ enum: ['COMPLETE', 'SKIP', 'CLICK'] }) @IsIn(['COMPLETE', 'SKIP', 'CLICK']) type!: string; @ApiProperty() @IsInt() @Min(0) @Max(3_600_000) ms!: number }

const campaignView = (c: Campaign & { advertiser: Advertiser; video?: Pick<Video, 'id' | 'title' | 'durationSeconds'> | null }) => ({
  id: c.id, status: c.status, businessName: c.advertiser.businessName, headline: c.headline, destinationUrl: c.destinationUrl, days: c.days,
  dailyRateCents: c.dailyRateCents, totalCents: c.days * c.dailyRateCents, currency: c.currency, targetCountries: c.targetCountries,
  startDate: c.reviewedAt ? c.startDate : null, endDate: c.reviewedAt ? c.endDate : null, reviewNote: c.reviewNote,
  impressions: Number(c.impressionsCount), clicks: Number(c.clicksCount), video: c.video ? { id: c.video.id, title: c.video.title, durationSeconds: c.video.durationSeconds } : null, createdAt: c.createdAt,
});

@ApiTags('ads')
@Controller()
export class AdsController {
  constructor(private readonly prisma: PrismaService, private readonly billing: BillingService, private readonly urls: MediaUrls, private readonly redis: RedisService, private readonly limits: RateLimitService) {}

  private async withVideos<T extends Campaign>(rows: T[]) {
    const ids = rows.map((r) => r.videoId).filter((x): x is string => !!x);
    const videos = new Map((await this.prisma.video.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, durationSeconds: true } })).map((v) => [v.id, v]));
    return rows.map((r) => ({ ...r, video: r.videoId ? videos.get(r.videoId) ?? null : null }));
  }

  @Get('ads/campaigns')
  @RequireAuth()
  @ApiOperation({ summary: 'My ad campaigns with their results' })
  async mine(@CurrentAuth() auth: AuthContext) {
    const adv = await this.prisma.advertiser.findUnique({ where: { userId: auth.user.id } });
    const rows = adv ? await this.prisma.campaign.findMany({ where: { advertiserId: adv.id }, orderBy: { createdAt: 'desc' }, include: { advertiser: true }, take: 100 }) : [];
    return { business: adv ? { name: adv.businessName, country: adv.country } : null, campaigns: (await this.withVideos(rows)).map(campaignView) };
  }

  @Post('ads/campaigns')
  @RequireAuth()
  @ApiOperation({ summary: 'Create an ad campaign (a draft until it is paid)' })
  async create(@CurrentAuth() auth: AuthContext, @Body() body: CampaignDto) {
    await this.limits.consume(`ads:create:${auth.user.id}`, 30, 3600);
    if (!isCountryCode(body.country)) throw new BadRequestException('Choose your business country from the list.');
    const targets = [...new Set((body.targetCountries ?? []).map((c) => c.toUpperCase()))];
    if (targets.some((c) => !isCountryCode(c))) throw new BadRequestException('Choose target countries from the list.');
    const v = await this.prisma.video.findUnique({ where: { id: body.videoId }, include: { channel: true } });
    if (!v || v.channel.userId !== auth.user.id) throw new BadRequestException('Choose one of your own videos as the ad.');
    if (v.status !== 'READY' || v.takenDownAt) throw new BadRequestException('The ad video must have finished processing.');
    if (v.visibility === 'PRIVATE') throw new BadRequestException('Make the ad video Unlisted (or Public) so viewers can play it.');
    if (v.durationSeconds < AD_MIN_SECONDS || v.durationSeconds > AD_MAX_SECONDS) throw new BadRequestException(`An ad must be between ${AD_MIN_SECONDS} and ${AD_MAX_SECONDS} seconds long.`);
    const rate = (await this.billing.settings()).adDayUsdCents;
    const c = await this.prisma.$transaction(async (tx) => {
      const adv = await tx.advertiser.upsert({
        where: { userId: auth.user.id }, update: { businessName: body.businessName.trim(), country: body.country.toUpperCase() },
        create: { userId: auth.user.id, businessName: body.businessName.trim(), country: body.country.toUpperCase(), businessType: 'business', currency: EARNINGS_CURRENCY },
      });
      if (!auth.user.roles.includes('ADVERTISER')) await tx.user.update({ where: { id: auth.user.id }, data: { roles: { set: [...auth.user.roles, 'ADVERTISER'] } } });
      const now = new Date();
      return tx.campaign.create({ data: {
        advertiserId: adv.id, name: body.headline.trim(), headline: body.headline.trim(), destinationUrl: body.destinationUrl, videoId: v.id, days: body.days, dailyRateCents: rate,
        currency: EARNINGS_CURRENCY, budgetAmountCents: BigInt(rate * body.days), targetCountries: targets, startDate: now, endDate: now,
      }, include: { advertiser: true } });
    });
    return { campaign: campaignView({ ...c, video: v }) };
  }

  private async own(auth: AuthContext, id: string) {
    const c = await this.prisma.campaign.findUnique({ where: { id }, include: { advertiser: true } });
    if (!c || c.advertiser.userId !== auth.user.id) throw new NotFoundException('Campaign not found.');
    return c;
  }

  @Post('ads/campaigns/:id/pay')
  @RequireAuth()
  @ApiOperation({ summary: 'Pay for a draft campaign; once paid it waits for review, then runs for the days bought' })
  async pay(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PayDto) {
    await this.limits.consume(`pay:${auth.user.id}`, 10, 3600, 'Too many payment attempts. Please wait a little.');
    const c = await this.own(auth, id);
    if (c.status !== 'DRAFT') throw new BadRequestException('This campaign is already paid.');
    const p = await this.billing.attempt(() => this.billing.start(auth.user, { purpose: 'AD_CAMPAIGN', method: body.method, phone: body.phone, campaignId: c.id, usdCents: c.days * c.dailyRateCents, description: `Free Me ad, ${c.days} ${c.days === 1 ? 'day' : 'days'}`, returnPath: '/ads' }));
    return { payment: paymentView(p) };
  }

  @Post('ads/campaigns/:id/pause')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Pause or resume a running campaign (the end date does not move)' })
  async pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.own(auth, id);
    if (c.status !== 'ACTIVE' && c.status !== 'PAUSED') throw new BadRequestException('Only a running campaign can be paused.');
    const next = await this.prisma.campaign.update({ where: { id }, data: { status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }, include: { advertiser: true } });
    return { campaign: campaignView((await this.withVideos([next]))[0]) };
  }

  @Delete('ads/campaigns/:id')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an unpaid draft' })
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.own(auth, id);
    if (c.status !== 'DRAFT') throw new BadRequestException('Only an unpaid draft can be deleted.');
    if (await this.prisma.payment.count({ where: { campaignId: id, status: 'PENDING' } })) throw new BadRequestException('A payment for this campaign is still in progress.');
    await this.prisma.campaign.delete({ where: { id } });
    return { deleted: true };
  }

  @Get('videos/:id/ads')
  @ApiOperation({ summary: 'Ads to play with this video: none, one before it, or also one halfway (at most two)' })
  async forVideo(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    const v = await this.prisma.video.findFirst({ where: { id, ...LINKED_VIDEO }, include: { channel: { include: { eligibility: true, user: { select: { premiumUntil: true, roles: true } } } } } });
    const now = new Date();
    if (!v || v.isShort || !v.channel.eligibility?.isEligible || !hasPremiumAccess(v.channel.user, now)) return { slots: [] };
    const profile = auth ? await this.prisma.profile.findUnique({ where: { userId: auth.user.id }, select: { country: true } }) : null;
    const header = req.headers['cf-ipcountry'];
    const country = (profile?.country ?? (typeof header === 'string' && /^[A-Z]{2}$/.test(header) ? header : null))?.toUpperCase() ?? null;
    const candidates = await this.prisma.campaign.findMany({
      where: { status: 'ACTIVE', startDate: { lte: now }, endDate: { gt: now }, videoId: { not: id }, ...(country ? { OR: [{ targetCountries: { isEmpty: true } }, { targetCountries: { has: country } }] } : { targetCountries: { isEmpty: true } }) },
      include: { advertiser: true }, take: 50,
    });
    const ads = await this.prisma.video.findMany({ where: { id: { in: candidates.map((c) => c.videoId!).filter(Boolean) }, ...LINKED_VIDEO, mediaLocation: 'PUBLIC' } });
    const byId = new Map(ads.map((a) => [a.id, a]));
    const usable = candidates.filter((c) => c.videoId && byId.has(c.videoId)).sort(() => Math.random() - 0.5);
    const at = [0, ...(v.durationSeconds >= MID_ROLL_MIN_SECONDS ? [Math.floor(v.durationSeconds / 2)] : [])].slice(0, MAX_ADS_PER_VIDEO);
    return {
      slots: at.slice(0, usable.length).map((t, i) => {
        const c = usable[i]; const a = byId.get(c.videoId!)!;
        return { at: t, ad: { campaignId: c.id, headline: c.headline, businessName: c.advertiser.businessName, destinationUrl: c.destinationUrl, playbackUrl: this.urls.playback(a), thumbnailUrl: this.urls.publicThumb(a), durationSeconds: a.durationSeconds, skipAfterSeconds: SKIP_AFTER_SECONDS } };
      }),
    };
  }

  @Post('ads/impressions')
  @ApiOperation({ summary: 'An ad started playing (counted once per viewer, campaign and video every 30 minutes)' })
  async impression(@Body() body: ImpressionDto, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    const who = auth?.user.id ?? clientIp(req) ?? 'unknown';
    await this.limits.consume(`ads:imp:${who}`, 120, 86_400, 'Too many ads today.');
    const c = await this.prisma.campaign.findUnique({ where: { id: body.campaignId } });
    const v = await this.prisma.video.findUnique({ where: { id: body.videoId }, select: { id: true } });
    const now = new Date();
    if (!c || !v || c.status !== 'ACTIVE' || c.startDate > now || c.endDate <= now) return { impressionId: null };
    const { count } = await this.redis.hit(`ads:seen:${who}:${c.id}:${v.id}`, 1800);
    if (count > 1) return { impressionId: null };
    const imp = await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({ where: { id: c.id }, data: { impressionsCount: { increment: 1 } } });
      return tx.adImpression.create({ data: { campaignId: c.id, videoId: v.id, viewerCountry: null, watchedDurationMs: 0, currency: c.currency, costChargedCents: 0, creatorShareCents: 0, platformShareCents: 0, reinvestShareCents: 0 } });
    });
    return { impressionId: imp.id };
  }

  @Post('ads/impressions/:id/events')
  @HttpCode(200)
  @ApiOperation({ summary: 'How an ad ended: watched to the end, skipped, or the viewer visited the business' })
  async event(@Param('id', ParseUUIDPipe) id: string, @Body() body: AdEventDto) {
    const imp = await this.prisma.adImpression.findUnique({ where: { id }, include: { events: { select: { eventType: true } } } });
    if (!imp || Date.now() - imp.createdAt.getTime() > 3600_000 || imp.events.some((e) => e.eventType === body.type)) return { ok: true };
    await this.prisma.$transaction([
      this.prisma.adEvent.create({ data: { impressionId: id, eventType: body.type, timestampMs: body.ms } }),
      this.prisma.adImpression.update({ where: { id }, data: { watchedDurationMs: Math.max(imp.watchedDurationMs, body.type === 'CLICK' ? imp.watchedDurationMs : body.ms), completed: imp.completed || body.type === 'COMPLETE' } }),
      ...(body.type === 'CLICK' ? [this.prisma.campaign.update({ where: { id: imp.campaignId }, data: { clicksCount: { increment: 1 } } })] : []),
    ]);
    return { ok: true };
  }
}
