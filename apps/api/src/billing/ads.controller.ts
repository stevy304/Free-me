import { BadRequestException, Body, Controller, ForbiddenException, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
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
import { adDayKey, adViewLimits, EARNINGS_CURRENCY, hasPlus, hasPremiumAccess } from './billing';

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
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) targetVideoIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(1, 50, { each: true }) targetChannelHandles?: string[];
}
class ImpressionDto { @ApiProperty() @IsUUID() campaignId!: string; @ApiProperty() @IsUUID() videoId!: string }
class AdEventDto { @ApiProperty({ enum: ['COMPLETE', 'SKIP', 'CLICK'] }) @IsIn(['COMPLETE', 'SKIP', 'CLICK']) type!: string; @ApiProperty() @IsInt() @Min(0) @Max(3_600_000) ms!: number }

/** A campaign can show: running, inside its period (or its make-good period), with views left in its budget. */
const running = (c: Campaign, now: Date) => c.status === 'ACTIVE' && c.startDate <= now && (c.endDate > now || (!!c.deliverUntil && c.deliverUntil > now))
  && (!c.cpmRateCents || (c.impressionsCount + 1n) * BigInt(c.cpmRateCents) <= c.budgetAmountCents * 1000n);

const campaignView = (c: Campaign & { advertiser: Advertiser; video?: Pick<Video, 'id' | 'title' | 'durationSeconds'> | null }) => {
  const limits = adViewLimits(c);
  return {
  id: c.id, status: c.status, businessName: c.advertiser.businessName, headline: c.headline, destinationUrl: c.destinationUrl, days: c.days,
  dailyRateCents: c.dailyRateCents, totalCents: c.days * c.dailyRateCents, currency: c.currency,
  // Priced per 1,000 views (null for older campaigns priced per day): views bought, per day, and spent so far.
  cpmCents: c.cpmRateCents || null, viewsBought: limits?.total ?? null, viewsPerDay: limits?.perDay ?? null, spentCents: Number(c.spentAmountCents),
  deliverUntil: c.reviewedAt ? c.deliverUntil : null, targetCountries: c.targetCountries, targetVideoIds: c.targetVideoIds, targetChannelIds: c.targetChannelIds,
  startDate: c.reviewedAt ? c.startDate : null, endDate: c.reviewedAt ? c.endDate : null, reviewNote: c.reviewNote,
  impressions: Number(c.impressionsCount), clicks: Number(c.clicksCount), video: c.video ? { id: c.video.id, title: c.video.title, durationSeconds: c.video.durationSeconds } : null, createdAt: c.createdAt,
  };
};

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
    if (!hasPremiumAccess(auth.user)) throw new ForbiddenException('Ad Studio is part of Premium.');
    if (!isCountryCode(body.country)) throw new BadRequestException('Choose your business country from the list.');
    const targets = [...new Set((body.targetCountries ?? []).map((c) => c.toUpperCase()))];
    if (targets.some((c) => !isCountryCode(c))) throw new BadRequestException('Choose target countries from the list.');
    const v = await this.prisma.video.findUnique({ where: { id: body.videoId }, include: { channel: true } });
    if (!v || v.channel.userId !== auth.user.id) throw new BadRequestException('Choose one of your own videos as the ad.');
    if (v.status !== 'READY' || v.takenDownAt) throw new BadRequestException('The ad video must have finished processing.');
    if (v.visibility === 'PRIVATE') throw new BadRequestException('Make the ad video Unlisted (or Public) so viewers can play it.');
    if (v.durationSeconds < AD_MIN_SECONDS || v.durationSeconds > AD_MAX_SECONDS) throw new BadRequestException(`An ad must be between ${AD_MIN_SECONDS} and ${AD_MAX_SECONDS} seconds long.`);
    const targetVideoIds = [...new Set(body.targetVideoIds ?? [])];
    const handles = [...new Set((body.targetChannelHandles ?? []).map((h) => h.trim().toLowerCase().replace(/^@/, '')))];
    const [videoCount, channels] = await Promise.all([
      this.prisma.video.count({ where: { id: { in: targetVideoIds, not: v.id }, ...LINKED_VIDEO, visibility: 'PUBLIC', isAd: false, isShort: false } }),
      this.prisma.channel.findMany({ where: { handle: { in: handles } }, select: { id: true } }),
    ]);
    if (videoCount !== targetVideoIds.length || channels.length !== handles.length) {
      throw new BadRequestException('Choose existing public videos and valid channel handles for ad placements.');
    }
    const { adDayUsdCents: rate, adCpmUsdCents: cpm } = await this.billing.settings();
    const c = await this.prisma.$transaction(async (tx) => {
      const adv = await tx.advertiser.upsert({
        where: { userId: auth.user.id }, update: { businessName: body.businessName.trim(), country: body.country.toUpperCase() },
        create: { userId: auth.user.id, businessName: body.businessName.trim(), country: body.country.toUpperCase(), businessType: 'business', currency: EARNINGS_CURRENCY },
      });
      if (!auth.user.roles.includes('ADVERTISER')) await tx.user.update({ where: { id: auth.user.id }, data: { roles: { set: [...auth.user.roles, 'ADVERTISER'] } } });
      const now = new Date();
      return tx.campaign.create({ data: {
        advertiserId: adv.id, name: body.headline.trim(), headline: body.headline.trim(), destinationUrl: body.destinationUrl, videoId: v.id, days: body.days, dailyRateCents: rate, cpmRateCents: cpm,
        currency: EARNINGS_CURRENCY, budgetAmountCents: BigInt(rate * body.days), targetCountries: targets, targetVideoIds, targetChannelIds: channels.map((ch) => ch.id), startDate: now, endDate: now,
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
    const p = await this.billing.attempt(() => this.billing.start(auth.user, { purpose: 'AD_CAMPAIGN', method: body.method, phone: body.phone, campaignId: c.id, usdCents: c.days * c.dailyRateCents, description: `Free Me ad, ${c.days} ${c.days === 1 ? 'day' : 'days'}`, returnPath: '/studio/ads' }));
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

  private async viewerCountry(auth: AuthContext | null, req: AppRequest) {
    const profile = auth ? await this.prisma.profile.findUnique({ where: { userId: auth.user.id }, select: { country: true } }) : null;
    const header = req.headers['cf-ipcountry'];
    return (profile?.country ?? (typeof header === 'string' && /^[A-Z]{2}$/.test(header) ? header : null))?.toUpperCase() ?? null;
  }

  @Get('videos/:id/ads')
  @ApiOperation({ summary: 'Ads to play with this video: none, one before it, or also one halfway (at most two)' })
  async forVideo(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    // Plus, Family & TV and Premium: no ads (their subscription pays creators instead, by watch time).
    if (auth && await hasPlus(this.prisma, auth.user)) return { slots: [] };
    const v = await this.prisma.video.findFirst({ where: { id, ...LINKED_VIDEO }, include: { channel: { include: { eligibility: true, user: { select: { premiumUntil: true, roles: true } } } } } });
    const now = new Date();
    if (!v || v.isShort || v.isAd || !v.channel.eligibility?.isEligible || !hasPremiumAccess(v.channel.user, now)) return { slots: [] };
    const country = await this.viewerCountry(auth, req);
    const candidates = await this.prisma.campaign.findMany({
      where: { status: 'ACTIVE', startDate: { lte: now }, videoId: { not: id }, AND: [
        { OR: [{ endDate: { gt: now } }, { deliverUntil: { gt: now } }] },
        country ? { OR: [{ targetCountries: { isEmpty: true } }, { targetCountries: { has: country } }] } : { targetCountries: { isEmpty: true } },
        { OR: [{ targetVideoIds: { isEmpty: true }, targetChannelIds: { isEmpty: true } },
          ...(v.visibility === 'PUBLIC' ? [{ targetVideoIds: { has: id } }, { targetChannelIds: { has: v.channelId } }] : [])] },
      ] },
      include: { advertiser: true }, take: 50,
    });
    const ads = await this.prisma.video.findMany({ where: { id: { in: candidates.map((c) => c.videoId!).filter(Boolean) }, ...LINKED_VIDEO, mediaLocation: 'PUBLIC' } });
    const byId = new Map(ads.map((a) => [a.id, a]));
    // Campaigns that reached today's views or their budget leave the slots to others.
    const today = await this.redis.peek(candidates.map((c) => adDayKey(c.id, now)));
    const open = candidates.filter((c, i) => { const l = adViewLimits(c); return running(c, now) && (!l || today[i] < l.perDay); });
    const usable = open.filter((c) => c.videoId && byId.has(c.videoId)).sort(() => Math.random() - 0.5);
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
    if (auth && await hasPlus(this.prisma, auth.user)) return { impressionId: null };
    const c = await this.prisma.campaign.findUnique({ where: { id: body.campaignId } });
    const v = await this.prisma.video.findFirst({ where: { id: body.videoId, ...LINKED_VIDEO, isShort: false, isAd: false }, include: { channel: { include: { eligibility: true, user: true } } } });
    const now = new Date();
    if (!c || !v || !v.channel.eligibility?.isEligible || !hasPremiumAccess(v.channel.user, now) || c.videoId === v.id || !running(c, now)) return { impressionId: null };
    if ((c.targetVideoIds.length || c.targetChannelIds.length) &&
        (v.visibility !== 'PUBLIC' || (!c.targetVideoIds.includes(v.id) && !c.targetChannelIds.includes(v.channelId)))) return { impressionId: null };
    const country = await this.viewerCountry(auth, req);
    if (c.targetCountries.length && (!country || !c.targetCountries.includes(country))) return { impressionId: null };
    const { count } = await this.redis.hit(`ads:seen:${who}:${c.id}:${v.id}`, 1800);
    if (count > 1) return { impressionId: null };
    // Pacing: a campaign priced per 1,000 views gets at most its share of views each day.
    const limits = adViewLimits(c);
    if (limits && (await this.redis.hit(adDayKey(c.id, now), 2 * 86_400)).count > limits.perDay) return { impressionId: null };
    const imp = await this.prisma.$transaction(async (tx) => {
      // Counted and charged in one step that never goes over the budget (another server may count at the same time).
      const charged = await tx.$executeRaw`
        UPDATE "Campaign" SET "impressionsCount" = "impressionsCount" + 1, "spentAmountCents" = (("impressionsCount" + 1) * "cpmRateCents") / 1000, "updatedAt" = now()
        WHERE "id" = ${c.id} AND ("cpmRateCents" = 0 OR ("impressionsCount" + 1) * "cpmRateCents" <= "budgetAmountCents" * 1000)`;
      if (!charged) return null;
      return tx.adImpression.create({ data: { campaignId: c.id, videoId: v.id, viewerCountry: country, watchedDurationMs: 0, currency: c.currency, costChargedCents: 0, creatorShareCents: 0, platformShareCents: 0, reinvestShareCents: 0 } });
    });
    return { impressionId: imp?.id ?? null };
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
