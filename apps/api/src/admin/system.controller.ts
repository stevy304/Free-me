import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { RequireAuth } from '../common/auth.guard';
import { MediaQueue } from '../media/queue';

const startedAt = new Date();
const HOUR = 3_600_000;

/** One page an administrator can check before and after launch: are the parts up, is processing keeping up, how big is it. */
@ApiTags('admin')
@Controller('admin/system')
@RequireAuth('ADMIN')
export class SystemController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly media: MediaQueue, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'Health, processing queue, stuck and failed videos, storage used and accounts (administrators only)' })
  async status() {
    const now = Date.now();
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const).catch(() => 'down' as const);
    const [redis, queue, byStatus, stuck, failed24h, sizes, renditionBytes, users, newUsers24h, channels, openReports] = await Promise.all([
      this.redis.ping(),
      this.media.queue ? this.media.queue.getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => null) : Promise.resolve(null),
      this.prisma.video.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.video.count({ where: { OR: [{ status: 'PROCESSING' }, { status: 'READY', processingStage: 'SD ready · processing HD' }], updatedAt: { lt: new Date(now - 2 * HOUR) } } }),
      this.prisma.video.count({ where: { status: 'FAILED', updatedAt: { gte: new Date(now - 24 * HOUR) } } }),
      this.prisma.video.aggregate({ _sum: { sourceSizeBytes: true } }),
      this.prisma.videoRendition.aggregate({ _sum: { fileSizeBytes: true } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: new Date(now - 24 * HOUR) } } }),
      this.prisma.channel.count(),
      this.prisma.report.count({ where: { status: 'PENDING' } }),
    ]);
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
      services: { database: db, redis, storage: this.config.media.driver, email: this.config.mail.transport, googleSignIn: !!this.config.google },
      processing: { queue, stuckOver2h: stuck, failedLast24h: failed24h },
      videos: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      storage: { sourceBytes: (sizes._sum.sourceSizeBytes ?? 0n).toString(), mediaBytes: (renditionBytes._sum.fileSizeBytes ?? 0n).toString() },
      accounts: { users, newLast24h: newUsers24h, spaces: channels },
      moderation: { openReports },
    };
  }
}
