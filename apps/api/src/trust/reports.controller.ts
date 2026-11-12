import { BadRequestException, Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Equals, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { REPORT_DETAILS_MAX, REPORT_REASONS, reportReasonLabel, signatureMatches } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { MailService, noticeMail } from '../mail/mail.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { watchable } from '../engagement/access';

const REASONS = REPORT_REASONS.map((r) => r.code) as string[];

class ReportDto {
  @ApiProperty({ enum: REASONS }) @IsIn(REASONS, { message: 'Choose a reason from the list.' }) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(REPORT_DETAILS_MAX) details?: string;
  @ApiPropertyOptional({ description: 'Where in the video (seconds)' }) @IsOptional() @IsInt() @Min(0) @Max(86_400) timestampSeconds?: number;
}

/** A copyright notice: the elements most notice-and-takedown laws ask for (DMCA 17 U.S.C. 512(c)(3), EU DSA art. 16, and similar). */
class CopyrightNoticeDto {
  @ApiProperty() @IsUUID() videoId!: string;
  @ApiProperty({ description: 'Full legal name of the owner or their authorised agent' }) @IsString() @MinLength(3) @MaxLength(120) claimantName!: string;
  @ApiProperty() @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(200) claimantEmail!: string;
  @ApiProperty({ description: 'Postal address' }) @IsString() @MinLength(8) @MaxLength(400) claimantAddress!: string;
  @ApiProperty({ description: 'The original work (title and where it can be found)' }) @IsString() @MinLength(10) @MaxLength(1000) originalWork!: string;
  @ApiProperty({ description: 'What in the video infringes it' }) @IsString() @MinLength(10) @MaxLength(REPORT_DETAILS_MAX) details!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(86_400) timestampSeconds?: number;
  @ApiProperty({ description: 'Good-faith belief that the use is not authorised by the owner, its agent or the law' }) @Equals(true, { message: 'Confirm the good-faith statement.' }) goodFaith!: boolean;
  @ApiProperty({ description: 'The notice is accurate and, under penalty of perjury, the sender is the owner or authorised to act for them' }) @Equals(true, { message: 'Confirm the accuracy statement.' }) accurate!: boolean;
  @ApiProperty({ description: 'Electronic signature: the full name again' }) @IsString() @MaxLength(120) signature!: string;
}

/** Reporting videos that break the Community Guidelines, and copyright notices from rights holders. */
@ApiTags('trust and safety')
@Controller()
export class ReportsController {
  constructor(
    private readonly prisma: PrismaService, private readonly limits: RateLimitService, private readonly audit: AuditService,
    private readonly mail: MailService, @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('videos/:id/reports')
  @RequireAuth()
  @ApiOperation({ summary: 'Report a video to the moderators (copyright has its own notice form)' })
  async report(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReportDto, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`report:${auth.user.id}`, 20, 86_400, 'You have sent many reports today. Please try again tomorrow.');
    const v = await watchable(this.prisma, id, auth);
    if (v.channel.userId === auth.user.id) throw new BadRequestException('You cannot report your own video.');
    const open = await this.prisma.report.findFirst({ where: { reporterId: auth.user.id, videoId: id, status: { in: ['PENDING', 'INVESTIGATING'] } } });
    if (open) return { report: { id: open.id, status: open.status }, alreadyReported: true };
    const r = await this.prisma.report.create({ data: {
      reporterId: auth.user.id, videoId: id, reason: body.reason, details: body.details?.trim() || null,
      timestampSeconds: body.timestampSeconds != null ? Math.min(body.timestampSeconds, v.durationSeconds) : null,
    } });
    await this.holdIfReportedWidely(id, body.reason === 'CHILD_SAFETY');
    return { report: { id: r.id, status: r.status }, alreadyReported: false };
  }

  /**
   * Hides a video from everyone but its owner until a moderator decides, once enough different people report it:
   * REPORT_HOLD_THRESHOLD accounts (default 5), or 2 for child safety. Accounts younger than a day do not count, so
   * a wave of new accounts cannot take a video down. The moderator's decision lifts the hold or removes the video.
   */
  private async holdIfReportedWidely(videoId: string, childSafety: boolean) {
    const threshold = this.config.safety.reportHoldThreshold;
    if (!threshold) return;
    const established = { createdAt: { lt: new Date(Date.now() - 86_400_000) } };
    const open = { videoId, status: { in: ['PENDING', 'INVESTIGATING'] as Array<'PENDING' | 'INVESTIGATING'> }, reporter: established };
    const [all, child] = await Promise.all([
      this.prisma.report.findMany({ where: open, distinct: ['reporterId'], select: { reporterId: true } }),
      childSafety ? this.prisma.report.findMany({ where: { ...open, reason: 'CHILD_SAFETY' }, distinct: ['reporterId'], select: { reporterId: true } }) : [],
    ]);
    if (all.length < threshold && child.length < Math.min(2, threshold)) return;
    const held = await this.prisma.video.updateMany({ where: { id: videoId, reviewHoldAt: null, takenDownAt: null }, data: { reviewHoldAt: new Date() } });
    if (held.count) await this.audit.record({ userId: null, action: 'VIDEO_HELD_BY_REPORTS', entityType: 'Video', entityId: videoId, details: { reporters: all.length, childSafety: child.length } });
  }

  @Post('copyright/notices')
  @RequireAuth()
  @ApiOperation({ summary: 'Send a copyright notice asking for a video to be removed' })
  async copyright(@Body() body: CopyrightNoticeDto, @CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    await this.limits.consume(`copyright:${auth.user.id}`, 10, 86_400, 'You have sent many notices today. Please try again tomorrow.');
    const v = await watchable(this.prisma, body.videoId, auth);
    if (v.channel.userId === auth.user.id) throw new BadRequestException('This is your own video. You can delete it from Creator Hub.');
    if (!signatureMatches(body.claimantName, body.signature)) throw new BadRequestException('Sign by typing your full name exactly as entered above.');
    const r = await this.prisma.report.create({ data: {
      reporterId: auth.user.id, videoId: v.id, reason: 'COPYRIGHT', details: body.details.trim(),
      timestampSeconds: body.timestampSeconds != null ? Math.min(body.timestampSeconds, v.durationSeconds) : null,
      claimantName: body.claimantName.trim(), claimantEmail: body.claimantEmail.trim().toLowerCase(), claimantAddress: body.claimantAddress.trim(),
      originalWork: body.originalWork.trim(), signature: body.signature.trim(),
    } });
    await this.audit.record({ userId: auth.user.id, action: 'COPYRIGHT_NOTICE_RECEIVED', entityType: 'Video', entityId: v.id, req, details: { reportId: r.id } });
    await this.mail.send(noticeMail(r.claimantEmail!, 'We received your copyright notice', [
      `Hello ${r.claimantName},`,
      `We received your copyright notice about the video "${v.title}" (${this.config.appUrl}/watch?v=${v.id}). Reference: ${r.id}.`,
      'A moderator will review it. If the notice is complete and valid, the video will be removed and the creator will be told who sent the notice and which work it concerns. The creator may send a counter-notice; we will forward it to you.',
      'Sending a notice you know to be false can make you liable for damages.',
    ])).catch(() => undefined);
    return { report: { id: r.id, status: r.status } };
  }

  @Get('me/reports')
  @RequireAuth()
  @ApiOperation({ summary: 'Reports and notices I sent, with their outcome' })
  async mine(@CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.report.findMany({ where: { reporterId: auth.user.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { video: { select: { id: true, title: true } } } });
    return { reports: rows.map((r) => ({ id: r.id, reason: r.reason, reasonLabel: reportReasonLabel(r.reason), status: r.status, resolution: r.resolution, createdAt: r.createdAt, resolvedAt: r.resolvedAt, video: r.video })) };
  }
}
