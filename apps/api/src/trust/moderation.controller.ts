import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Equals, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Prisma, Report } from '@prisma/client';
import { reportReasonLabel, signatureMatches } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { MailService, noticeMail } from '../mail/mail.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { MediaQueue } from '../media/queue';
import { MediaUrls } from '../videos/media-urls';

class DecisionDto {
  @ApiProperty({ enum: ['remove', 'dismiss', 'restore'] }) @IsIn(['remove', 'dismiss', 'restore']) action!: 'remove' | 'dismiss' | 'restore';
  @ApiPropertyOptional({ description: 'Shown to the creator and the reporter' }) @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class CounterNoticeDto {
  @ApiProperty({ description: 'Why the removal was a mistake or misidentification' }) @IsString() @MinLength(20) @MaxLength(3000) statement!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(120) name!: string;
  @ApiProperty({ description: 'Postal address (forwarded to the person who sent the notice)' }) @IsString() @MinLength(8) @MaxLength(400) address!: string;
  @ApiProperty({ description: 'Good-faith belief, under penalty of perjury, that the video was removed by mistake or misidentification' }) @Equals(true, { message: 'Confirm the good-faith statement.' }) goodFaith!: boolean;
  @ApiProperty({ description: 'Consent to the jurisdiction of the courts and to accept service from the claimant' }) @Equals(true, { message: 'Confirm that you accept the jurisdiction and service of process.' }) consent!: boolean;
  @ApiProperty() @IsString() @MaxLength(120) signature!: string;
}

const OPEN: Prisma.ReportWhereInput = { status: { in: ['PENDING', 'INVESTIGATING'] } };
const STRIKE_DAYS = 90;

/** Strikes: removals of a channel's videos in the last 90 days that were not reversed. */
async function strikes(prisma: PrismaService, channelId: string) {
  const since = new Date(Date.now() - STRIKE_DAYS * 86_400_000);
  const rows = await prisma.video.findMany({ where: { channelId, takenDownAt: { gte: since } }, select: { takedownReason: true } });
  return { copyright: rows.filter((r) => r.takedownReason === 'COPYRIGHT').length, guidelines: rows.filter((r) => r.takedownReason !== 'COPYRIGHT').length, windowDays: STRIKE_DAYS };
}

/** The moderation queue: review reports and copyright notices, remove or restore videos. Moderators and administrators. */
@ApiTags('moderation')
@Controller('moderation')
@RequireAuth('ADMIN', 'MODERATOR')
export class ModerationController {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mail: MailService,
    private readonly queue: MediaQueue, private readonly urls: MediaUrls, @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('reports')
  @ApiOperation({ summary: 'Reports to review: open (default), counter-notices waiting, or closed' })
  async list(@Query('state') state = 'open', @Query('reason') reason?: string, @Query('cursor') cursor?: string) {
    const where: Prisma.ReportWhereInput = {
      ...(state === 'closed' ? { status: { in: ['RESOLVED', 'DISMISSED'] } } : state === 'counter' ? { counterAt: { not: null }, video: { takenDownAt: { not: null } } } : OPEN),
      ...(reason ? { reason } : {}),
    };
    const rows = await this.prisma.report.findMany({
      where, orderBy: [{ createdAt: state === 'closed' ? 'desc' : 'asc' }, { id: 'asc' }], take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { video: { include: { channel: true } }, reporter: { select: { email: true } } },
    });
    const items = await Promise.all(rows.slice(0, 50).map(async (r) => ({
      ...this.view(r), reporterEmail: r.reporter.email,
      video: { id: r.video.id, title: r.video.title, status: r.video.status, visibility: r.video.visibility, takenDownAt: r.video.takenDownAt, takedownReason: r.video.takedownReason, thumbnailUrl: await this.urls.thumb(r.video), durationSeconds: r.video.durationSeconds },
      channel: { handle: r.video.channel.handle, name: r.video.channel.name, strikes: await strikes(this.prisma, r.video.channelId) },
      openReportsOnVideo: await this.prisma.report.count({ where: { videoId: r.videoId, ...OPEN } }),
    })));
    return { reports: items, nextCursor: rows.length > 50 ? rows[49].id : null, open: await this.prisma.report.count({ where: OPEN }) };
  }

  private view(r: Report) {
    return {
      id: r.id, reason: r.reason, reasonLabel: reportReasonLabel(r.reason), details: r.details, timestampSeconds: r.timestampSeconds, status: r.status,
      createdAt: r.createdAt, resolvedAt: r.resolvedAt, resolution: r.resolution,
      notice: r.reason === 'COPYRIGHT' ? { claimantName: r.claimantName, claimantEmail: r.claimantEmail, claimantAddress: r.claimantAddress, originalWork: r.originalWork, signature: r.signature } : null,
      counter: r.counterAt ? { name: r.counterName, address: r.counterAddress, statement: r.counterStatement, submittedAt: r.counterAt } : null,
    };
  }

  @Post('reports/:id/decision')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove the video, dismiss the report, or restore a removed video (e.g. after a counter-notice)' })
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const r = await this.prisma.report.findUnique({ where: { id }, include: { video: { include: { channel: { include: { user: { select: { email: true } } } } } }, reporter: { select: { email: true } } } });
    if (!r) throw new NotFoundException('Report not found.');
    const v = r.video;
    const notes = body.notes?.trim() || null;
    const watch = `${this.config.appUrl}/watch?v=${v.id}`;
    const creatorEmail = v.channel.user.email;
    const now = new Date();

    if (body.action === 'remove') {
      if (v.takenDownAt) throw new BadRequestException('This video has already been removed.');
      if (!notes) throw new BadRequestException('Explain the decision: the creator will read it.');
      const resolution = `Video removed: ${notes}`;
      await this.prisma.$transaction([
        this.prisma.video.update({ where: { id: v.id }, data: { takenDownAt: now, takedownReason: r.reason, status: 'SUSPENDED' } }),
        this.prisma.report.updateMany({ where: { videoId: v.id, ...OPEN }, data: { status: 'RESOLVED', resolution, resolvedAt: now } }),
        this.prisma.moderationAction.create({ data: { reportId: r.id, videoId: v.id, moderatorId: auth.user.id, action: 'VIDEO_TAKEDOWN', notes } }),
      ]);
      if (v.hlsMasterKey) await this.queue.add({ name: 'relocate', videoId: v.id });
      const copyright = r.reason === 'COPYRIGHT';
      await this.mail.send(noticeMail(creatorEmail, `Your video "${v.title}" was removed`, [
        `Your video "${v.title}" was removed from Free Me.`,
        copyright ? `Reason: a copyright notice from ${r.claimantName}, about this work: ${r.originalWork}` : `Reason: ${reportReasonLabel(r.reason)} (Community Guidelines).`,
        `Moderator's note: ${notes}`,
        copyright
          ? 'If you believe the video was removed by mistake or misidentification, you can send a counter-notice from Creator Hub. We forward it to the person who sent the notice; unless they tell us within 10 to 14 business days that they have started court action, the video can be restored.'
          : 'Removals count as a strike on your channel for 90 days. If you think this decision is wrong, reply to this email to ask for a review.',
      ], { label: 'Open Creator Hub', url: `${this.config.appUrl}/hub?tab=notices` })).catch(() => undefined);
      if (copyright && r.claimantEmail) await this.mail.send(noticeMail(r.claimantEmail, 'The video in your copyright notice was removed', [`Hello ${r.claimantName},`, `After reviewing your notice (reference ${r.id}), we removed the video "${v.title}".`, 'If the creator sends a counter-notice, we will forward it to you.'])).catch(() => undefined);
      await this.audit.record({ userId: auth.user.id, action: 'VIDEO_TAKEN_DOWN', entityType: 'Video', entityId: v.id, req, details: { reportId: r.id, reason: r.reason } });
      return { video: { id: v.id, takenDown: true }, report: { id: r.id, status: 'RESOLVED' } };
    }

    if (body.action === 'dismiss') {
      if (r.status === 'RESOLVED' || r.status === 'DISMISSED') throw new BadRequestException('This report is already closed.');
      const resolution = notes ? `No action taken: ${notes}` : 'No action taken: the video does not break the rules.';
      await this.prisma.$transaction([
        this.prisma.report.update({ where: { id }, data: { status: 'DISMISSED', resolution, resolvedAt: now } }),
        this.prisma.moderationAction.create({ data: { reportId: r.id, videoId: v.id, moderatorId: auth.user.id, action: 'DISMISSED', notes } }),
      ]);
      if (r.reason === 'COPYRIGHT' && r.claimantEmail) {
        await this.mail.send(noticeMail(r.claimantEmail, 'Your copyright notice was not accepted', [`Hello ${r.claimantName},`, `We reviewed your notice (reference ${r.id}) about "${v.title}" and did not remove the video.`, resolution, 'You can send a new notice with the missing information at any time.'])).catch(() => undefined);
      }
      await this.audit.record({ userId: auth.user.id, action: 'REPORT_DISMISSED', entityType: 'Report', entityId: r.id, req });
      return { report: { id: r.id, status: 'DISMISSED' } };
    }

    // restore
    if (!v.takenDownAt) throw new BadRequestException('This video is not removed.');
    const resolution = notes ? `Video restored: ${notes}` : 'Video restored.';
    await this.prisma.$transaction([
      this.prisma.video.update({ where: { id: v.id }, data: { takenDownAt: null, takedownReason: null, status: v.hlsMasterKey ? 'READY' : 'PROCESSING' } }),
      this.prisma.report.update({ where: { id }, data: { status: 'RESOLVED', resolution, resolvedAt: now } }),
      this.prisma.moderationAction.create({ data: { reportId: r.id, videoId: v.id, moderatorId: auth.user.id, action: 'VIDEO_RESTORED', notes } }),
    ]);
    if (v.hlsMasterKey) await this.queue.add({ name: 'relocate', videoId: v.id });
    await this.mail.send(noticeMail(creatorEmail, `Your video "${v.title}" is back`, [`Your video "${v.title}" has been restored and can be watched again.`, ...(notes ? [`Moderator's note: ${notes}`] : [])], { label: 'Watch it', url: watch })).catch(() => undefined);
    if (r.reason === 'COPYRIGHT' && r.claimantEmail) await this.mail.send(noticeMail(r.claimantEmail, 'A video from your copyright notice was restored', [`Hello ${r.claimantName},`, `The video "${v.title}" (notice reference ${r.id}) was restored${r.counterAt ? ' after a counter-notice, and we did not receive notice of court action within the waiting period' : ''}.`, ...(notes ? [notes] : [])])).catch(() => undefined);
    await this.audit.record({ userId: auth.user.id, action: 'VIDEO_RESTORED', entityType: 'Video', entityId: v.id, req, details: { reportId: r.id } });
    return { video: { id: v.id, takenDown: false }, report: { id: r.id, status: 'RESOLVED' } };
  }
}

/** Creator Hub: removals of my videos, strikes, and counter-notices. */
@ApiTags('creator hub')
@Controller('hub/notices')
@RequireAuth('CREATOR')
export class HubNoticesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mail: MailService, private readonly urls: MediaUrls, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'My removed videos, why, and my strikes' })
  async list(@CurrentAuth() auth: AuthContext) {
    const channel = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!channel) return { removals: [], strikes: { copyright: 0, guidelines: 0, windowDays: STRIKE_DAYS } };
    const videos = await this.prisma.video.findMany({ where: { channelId: channel.id, takenDownAt: { not: null } }, orderBy: { takenDownAt: 'desc' } });
    const removals = await Promise.all(videos.map(async (v) => {
      const action = await this.prisma.moderationAction.findFirst({ where: { videoId: v.id, action: 'VIDEO_TAKEDOWN' }, orderBy: { createdAt: 'desc' }, include: { report: true } });
      const r = action?.report;
      return {
        video: { id: v.id, title: v.title, thumbnailUrl: await this.urls.thumb(v) }, takenDownAt: v.takenDownAt, reason: v.takedownReason, reasonLabel: reportReasonLabel(v.takedownReason ?? 'OTHER'),
        moderatorNote: action?.notes ?? null,
        notice: r && r.reason === 'COPYRIGHT' ? { id: r.id, claimantName: r.claimantName, originalWork: r.originalWork, details: r.details, receivedAt: r.createdAt } : null,
        counter: r?.counterAt ? { submittedAt: r.counterAt } : null,
        canCounter: !!r && r.reason === 'COPYRIGHT' && !r.counterAt,
      };
    }));
    return { removals, strikes: await strikes(this.prisma, channel.id) };
  }

  @Post(':reportId/counter')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a counter-notice for a video removed after a copyright notice' })
  async counter(@Param('reportId', ParseUUIDPipe) reportId: string, @Body() body: CounterNoticeDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const r = await this.prisma.report.findUnique({ where: { id: reportId }, include: { video: { include: { channel: true } } } });
    if (!r || r.video.channel.userId !== auth.user.id) throw new NotFoundException('Notice not found.');
    if (r.reason !== 'COPYRIGHT' || !r.video.takenDownAt) throw new BadRequestException('A counter-notice is only for videos removed after a copyright notice.');
    if (r.counterAt) throw new BadRequestException('You already sent a counter-notice for this video.');
    if (!signatureMatches(body.name, body.signature)) throw new BadRequestException('Sign by typing your full name exactly as entered above.');
    await this.prisma.report.update({ where: { id: r.id }, data: { counterStatement: body.statement.trim(), counterName: body.name.trim(), counterAddress: body.address.trim(), counterAt: new Date(), status: 'INVESTIGATING' } });
    if (r.claimantEmail) {
      await this.mail.send(noticeMail(r.claimantEmail, 'Counter-notice about your copyright notice', [
        `Hello ${r.claimantName},`,
        `The creator of "${r.video.title}" sent a counter-notice about your copyright notice (reference ${r.id}). It is copied below as the law requires.`,
        `Name: ${body.name.trim()}\nAddress: ${body.address.trim()}\nStatement: ${body.statement.trim()}`,
        'The creator states, under penalty of perjury, that the video was removed by mistake or misidentification, and consents to the jurisdiction of the courts for their address and to accept service of process from you.',
        `Unless you tell us within 10 business days that you have filed a court action to stop the infringement${this.config.legal.copyrightEmail ? ` (write to ${this.config.legal.copyrightEmail})` : ' (reply to this email)'}, the video may be restored after 10 to 14 business days.`,
      ])).catch(() => undefined);
    }
    await this.audit.record({ userId: auth.user.id, action: 'COUNTER_NOTICE_SENT', entityType: 'Report', entityId: r.id, req });
    return { counter: { submittedAt: new Date() } };
  }
}
