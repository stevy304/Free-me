import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { ContentClaim, RightsPolicy } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { MediaQueue } from '../media/queue';
import { MediaUrls } from '../videos/media-urls';

class ReferenceDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ enum: ['BLOCK', 'MONETIZE', 'TRACK'] }) @IsOptional() @IsIn(['BLOCK', 'MONETIZE', 'TRACK']) policy?: RightsPolicy;
}
class DisputeDto { @ApiProperty() @IsString() @MinLength(10) @MaxLength(1000) reason!: string }
class VerifyDto { @ApiProperty() @IsBoolean() verified!: boolean }

const CLAIM = { video: { select: { id: true, title: true, thumbnailKey: true, channel: { select: { handle: true, name: true } } } }, reference: { select: { id: true, title: true, channel: { select: { handle: true, name: true } } } } } as const;
type ClaimRow = ContentClaim & { video: { id: string; title: string; channel: { handle: string; name: string } }; reference: { id: string; title: string; channel: { handle: string; name: string } } };
const claimView = (c: ClaimRow) => ({
  id: c.id, policy: c.policy, status: c.status, matched: c.matched, seconds: c.matchedSeconds, uploadStart: c.uploadStart, referenceStart: c.referenceStart,
  disputeReason: c.disputeReason, disputedAt: c.disputedAt, resolvedAt: c.resolvedAt, createdAt: c.createdAt,
  upload: { id: c.video.id, title: c.video.title, handle: c.video.channel.handle, name: c.video.channel.name },
  work: { id: c.reference.id, title: c.reference.title, handle: c.reference.channel.handle, name: c.reference.channel.name },
});

/**
 * Creator Hub → Rights (RIGHTS.md): my protected works and their policy, matches of my works on other uploads, and
 * claims on my uploads (which I can dispute). Releasing a claim that blocked a video publishes it.
 */
@ApiTags('rights')
@Controller('rights')
@RequireAuth()
export class RightsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly queue: MediaQueue, private readonly urls: MediaUrls) {}

  private async channel(auth: AuthContext) {
    const ch = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!ch) throw new NotFoundException('Create your Space first.');
    return ch;
  }

  @Get()
  @ApiOperation({ summary: 'My works and their protection, matches of my works, and claims on my uploads' })
  async overview(@CurrentAuth() auth: AuthContext) {
    const ch = await this.channel(auth);
    const [works, mine, onMine] = await Promise.all([
      this.prisma.video.findMany({ where: { channelId: ch.id, isAd: false, status: { in: ['READY', 'PROCESSING'] } }, orderBy: { createdAt: 'desc' }, take: 200,
        select: { id: true, title: true, visibility: true, publishedAt: true, status: true, contentReference: true, contentFingerprint: { select: { createdAt: true } } } }),
      this.prisma.contentClaim.findMany({ where: { ownerChannelId: ch.id }, include: CLAIM, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.contentClaim.findMany({ where: { video: { channelId: ch.id } }, include: CLAIM, orderBy: { createdAt: 'desc' }, take: 200 }),
    ]);
    return {
      verified: !!ch.rightsVerifiedAt,
      works: works.map((w) => {
        const published = w.status === 'READY' && w.visibility !== 'PRIVATE' && !!w.publishedAt;
        const protectedNow = w.contentReference ? w.contentReference.active : published;
        return { id: w.id, title: w.title, visibility: w.visibility, published, fingerprinted: !!w.contentFingerprint, protected: protectedNow,
          policy: w.contentReference && ch.rightsVerifiedAt ? w.contentReference.policy : 'BLOCK' };
      }),
      matchesOfMyWorks: (mine as ClaimRow[]).map(claimView),
      claimsOnMyUploads: (onMine as ClaimRow[]).map(claimView),
    };
  }

  @Put('works/:videoId')
  @ApiOperation({ summary: 'Protect a work (or stop), and choose what a match does (earn or track: verified rights holders only)' })
  async setWork(@Param('videoId', ParseUUIDPipe) videoId: string, @Body() body: ReferenceDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const ch = await this.channel(auth);
    const v = await this.prisma.video.findFirst({ where: { id: videoId, channelId: ch.id } });
    if (!v) throw new NotFoundException('Video not found.');
    if (body.policy && body.policy !== 'BLOCK' && !ch.rightsVerifiedAt) throw new ForbiddenException('Only verified rights holders can let copies of their works through (earn or track). Your works are blocked when copied.');
    const r = await this.prisma.contentReference.upsert({
      where: { videoId }, create: { videoId, channelId: ch.id, active: body.active ?? true, policy: body.policy ?? 'BLOCK' },
      update: { ...(body.active !== undefined ? { active: body.active } : {}), ...(body.policy ? { policy: body.policy } : {}) },
    });
    // Claims already made on other uploads follow the new policy (a work no longer protected releases its claims).
    if (!r.active) await this.releaseAll(videoId);
    else await this.prisma.contentClaim.updateMany({ where: { referenceVideoId: videoId, status: { not: 'RELEASED' } }, data: { policy: r.policy } });
    if (r.active && r.policy !== 'BLOCK') await this.releaseBlocked(videoId);
    await this.audit.record({ userId: auth.user.id, action: 'RIGHTS_WORK_UPDATED', entityType: 'Video', entityId: videoId, req, details: { active: r.active, policy: r.policy } });
    return { videoId, active: r.active, policy: r.policy };
  }

  @Post('claims/:id/dispute')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dispute a claim on my upload (it is my work, I have permission, or it is fair use); the owner decides' })
  async dispute(@Param('id', ParseUUIDPipe) id: string, @Body() body: DisputeDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const c = await this.prisma.contentClaim.findUnique({ where: { id }, include: { video: { select: { channel: { select: { userId: true } } } } } });
    if (!c || c.video.channel.userId !== auth.user.id) throw new NotFoundException('Claim not found.');
    if (c.status !== 'ACTIVE') throw new BadRequestException(c.status === 'DISPUTED' ? 'This claim is already disputed.' : 'This claim was released.');
    if (c.disputedAt) throw new BadRequestException('You already disputed this claim, and the owner kept it.');
    await this.prisma.contentClaim.update({ where: { id }, data: { status: 'DISPUTED', disputeReason: body.reason.trim(), disputedAt: new Date() } });
    await this.audit.record({ userId: auth.user.id, action: 'RIGHTS_CLAIM_DISPUTED', entityType: 'ContentClaim', entityId: id, req });
    return { status: 'DISPUTED' };
  }

  @Post('claims/:id/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Release a claim on my work (the owner, or an administrator): a video it blocked is published' })
  async release(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const c = await this.claimIOwn(id, auth);
    await this.prisma.contentClaim.update({ where: { id }, data: { status: 'RELEASED', resolvedAt: new Date() } });
    await this.publishIfFree(c.videoId);
    await this.audit.record({ userId: auth.user.id, action: 'RIGHTS_CLAIM_RELEASED', entityType: 'ContentClaim', entityId: id, req });
    return { status: 'RELEASED' };
  }

  @Post('claims/:id/keep')
  @HttpCode(200)
  @ApiOperation({ summary: 'Keep a disputed claim on my work (the uploader cannot dispute it again)' })
  async keep(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const c = await this.claimIOwn(id, auth);
    if (c.status !== 'DISPUTED') throw new BadRequestException('Only a disputed claim can be kept.');
    await this.prisma.contentClaim.update({ where: { id }, data: { status: 'ACTIVE', resolvedAt: new Date() } });
    await this.audit.record({ userId: auth.user.id, action: 'RIGHTS_CLAIM_KEPT', entityType: 'ContentClaim', entityId: id, req });
    return { status: 'ACTIVE' };
  }

  private async claimIOwn(id: string, auth: AuthContext) {
    const c = await this.prisma.contentClaim.findUnique({ where: { id }, include: { owner: { select: { userId: true } } } });
    const admin = auth.user.roles.includes('ADMIN');
    if (!c || (c.owner.userId !== auth.user.id && !admin)) throw new NotFoundException('Claim not found.');
    if (c.status === 'RELEASED') throw new BadRequestException('This claim was already released.');
    return c;
  }

  private async releaseAll(referenceVideoId: string) {
    const claims = await this.prisma.contentClaim.findMany({ where: { referenceVideoId, status: { not: 'RELEASED' } }, select: { id: true, videoId: true } });
    for (const c of claims) { await this.prisma.contentClaim.update({ where: { id: c.id }, data: { status: 'RELEASED', resolvedAt: new Date() } }); await this.publishIfFree(c.videoId); }
  }

  /** Copies that were blocked go out once the owner lets them through (earn or track). */
  private async releaseBlocked(referenceVideoId: string) {
    const claims = await this.prisma.contentClaim.findMany({ where: { referenceVideoId, status: { not: 'RELEASED' } }, select: { videoId: true } });
    for (const c of claims) await this.publishIfFree(c.videoId);
  }

  /** A video a claim blocked is processed and published once no blocking claim is left on it. */
  private async publishIfFree(videoId: string) {
    const v = await this.prisma.video.findUnique({ where: { id: videoId }, select: { status: true, safetyModel: true } });
    if (!v || v.status !== 'FLAGGED' || v.safetyModel !== 'content-id') return;
    const left = await this.prisma.contentClaim.count({ where: { videoId, policy: 'BLOCK', status: { not: 'RELEASED' } } });
    if (left) return;
    await this.prisma.video.update({ where: { id: videoId }, data: { status: 'PROCESSING', processingStage: 'Queued', safetyDecision: 'publish', safetyReason: null, safetyModel: null } });
    await this.queue.add({ name: 'transcode', videoId });
  }
}

/** Administration: which Spaces are verified rights holders (they may choose earn or track for their works). */
@ApiTags('admin')
@Controller('admin/rights')
@RequireAuth('ADMIN')
export class AdminRightsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Verified rights holders, and recent claims' })
  async list() {
    const [holders, claims] = await Promise.all([
      this.prisma.channel.findMany({ where: { rightsVerifiedAt: { not: null } }, select: { handle: true, name: true, rightsVerifiedAt: true }, orderBy: { rightsVerifiedAt: 'desc' } }),
      this.prisma.contentClaim.groupBy({ by: ['status'], _count: true }),
    ]);
    return { holders, claims: Object.fromEntries(claims.map((c) => [c.status, c._count])) };
  }

  @Post(':handle')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a Space as a rights holder (or remove it)' })
  async verify(@Param('handle') handle: string, @Body() body: VerifyDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const ch = await this.prisma.channel.findUnique({ where: { handle: handle.replace(/^@/, '').toLowerCase() } });
    if (!ch) throw new NotFoundException('This Space does not exist.');
    await this.prisma.channel.update({ where: { id: ch.id }, data: { rightsVerifiedAt: body.verified ? new Date() : null } });
    // No longer verified: its works go back to blocking copies.
    if (!body.verified) await this.prisma.contentReference.updateMany({ where: { channelId: ch.id }, data: { policy: 'BLOCK' } });
    await this.audit.record({ userId: auth.user.id, action: body.verified ? 'RIGHTS_HOLDER_VERIFIED' : 'RIGHTS_HOLDER_REMOVED', entityType: 'Channel', entityId: ch.id, req });
    return { handle: ch.handle, verified: body.verified };
  }
}
