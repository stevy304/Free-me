import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { RequireAuth } from '../common/auth.guard';
import { MediaQueue, STORAGE } from '../media/queue';
import { MediaJobs, VideoBusy } from '../media/jobs';
import type { Storage } from '../media/storage';

const startedAt = new Date();

/** Ready videos processed before the current pipeline (no seek previews yet): they lack HDR colour, even loudness, shared audio and previews. */
const NEEDS_UPGRADE: Prisma.VideoWhereInput = { status: 'READY', storyboard: { equals: Prisma.DbNull }, sourceFileS3Key: { not: null }, takenDownAt: null };

class RepairDto {
  @ApiPropertyOptional({ description: 'Fix what is found (default: only report)' }) @IsOptional() @IsBoolean() apply?: boolean;
}

class ReprocessDto {
  @ApiPropertyOptional({ description: 'How many to queue now (1-500, default 50)' }) @IsOptional() @IsInt() @Min(1) @Max(500) limit?: number;
  @ApiPropertyOptional({ description: 'Only count, queue nothing' }) @IsOptional() @IsBoolean() dryRun?: boolean;
}
const HOUR = 3_600_000;

/** One page an administrator can check before and after launch: are the parts up, is processing keeping up, how big is it. */
@ApiTags('admin')
@Controller('admin/system')
@RequireAuth('ADMIN')
export class SystemController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly media: MediaQueue, @Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(STORAGE) private readonly storage: Storage) {}

  @Get()
  @ApiOperation({ summary: 'Health, processing queue, stuck and failed videos, storage used and accounts (administrators only)' })
  async status() {
    const now = Date.now();
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const).catch(() => 'down' as const);
    const [redis, queue, byStatus, stuck, failed24h, sizes, renditionBytes, users, newUsers24h, channels, openReports] = await Promise.all([
      this.redis.ping(),
      this.media.queue ? this.media.queue.getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => null) : Promise.resolve(null),
      this.prisma.video.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.video.count({ where: { OR: [{ status: 'PROCESSING' }, { status: 'READY', processingStage: { not: 'Ready' } }], updatedAt: { lt: new Date(now - 2 * HOUR) } } }),
      this.prisma.video.count({ where: { status: 'FAILED', updatedAt: { gte: new Date(now - 24 * HOUR) } } }),
      this.prisma.video.aggregate({ _sum: { sourceSizeBytes: true } }),
      this.prisma.videoRendition.aggregate({ _sum: { fileSizeBytes: true } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: new Date(now - 24 * HOUR) } } }),
      this.prisma.channel.count(),
      this.prisma.report.count({ where: { status: 'PENDING' } }),
    ]);
    const needsUpgrade = await this.prisma.video.count({ where: NEEDS_UPGRADE });
    const warnings: string[] = [];
    if (db !== 'ok') warnings.push('The database is not answering.');
    if (redis === 'down') warnings.push('Redis is not answering: rate limits and video jobs are affected.');
    if (this.config.nodeEnv === 'production' && redis === 'not configured') warnings.push('REDIS_URL is not set.');
    if (queue && (queue.waiting ?? 0) > 20) warnings.push(`${queue.waiting} videos are waiting to be processed: add worker capacity.`);
    if (stuck) warnings.push(`${stuck} video(s) have been processing for more than 2 hours.`);
    if (failed24h) warnings.push(`${failed24h} video(s) failed to process in the last 24 hours.`);
    if (this.config.mail.transport === 'console' && this.config.nodeEnv === 'production') warnings.push('Email is printed to the log instead of sent: set up SMTP.');
    if (!this.config.google) warnings.push('Google sign-in is not configured.');
    return {
      ok: warnings.length === 0, warnings,
      app: { environment: this.config.nodeEnv, startedAt, uptimeSeconds: Math.round((now - startedAt.getTime()) / 1000), node: process.version, memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
      services: { database: db, redis, storage: this.config.media.driver, email: this.config.mail.transport, googleSignIn: !!this.config.google, autoCaptions: !!this.config.media.whisper },
      processing: { queue, stuckOver2h: stuck, failedLast24h: failed24h, videosNeedingUpgrade: needsUpgrade },
      videos: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      storage: { sourceBytes: (sizes._sum.sourceSizeBytes ?? 0n).toString(), mediaBytes: (renditionBytes._sum.fileSizeBytes ?? 0n).toString() },
      accounts: { users, newLast24h: newUsers24h, spaces: channels },
      moderation: { openReports },
    };
  }

  @Post('reprocess')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run older videos through the current pipeline (oldest first), in batches; they stay watchable meanwhile' })
  async reprocess(@Body() body: ReprocessDto) {
    const take = body.limit ?? 50;
    const rows = await this.prisma.video.findMany({ where: NEEDS_UPGRADE, orderBy: { createdAt: 'asc' }, take, select: { id: true } });
    if (!body.dryRun) for (const r of rows) await this.media.add({ name: 'transcode', videoId: r.id });
    const remaining = await this.prisma.video.count({ where: NEEDS_UPGRADE });
    return { queued: body.dryRun ? 0 : rows.length, wouldQueue: rows.length, remaining: body.dryRun ? remaining : Math.max(0, remaining - rows.length) };
  }

  @Post('repair-media')
  @HttpCode(200)
  @ApiOperation({ summary: 'Find (and with apply, bring back) files videos left in the wrong storage place: broken thumbnails or playback. Same as tools/repair-media' })
  async repair(@Body() body: RepairDto) {
    const jobs = new MediaJobs(this.prisma, this.storage, this.config, this.redis.client);
    const videos = await this.prisma.video.findMany({ where: { hlsMasterKey: { not: null } }, select: { id: true, title: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const found: Array<{ id: string; title: string; missing: string[]; leftovers: number; repaired: boolean }> = [];
    let busy = 0;
    for (const v of videos) {
      try {
        const r = await jobs.repair(v.id, !!body.apply);
        if (r && (r.leftovers || r.missing.length)) found.push({ id: v.id, title: v.title, missing: r.missing, leftovers: r.leftovers, repaired: !!body.apply && r.leftovers > 0 });
      } catch (e) { if (e instanceof VideoBusy) busy++; else throw e; }
    }
    return { checked: videos.length, needingRepair: found.length, applied: !!body.apply, busy, videos: found.slice(0, 100) };
  }
}
