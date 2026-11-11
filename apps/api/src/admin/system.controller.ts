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
import { effective, loadStored } from '../billing/settings';
import { loadGoogleSettings } from '../auth/google-settings';
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

  /**
   * Before opening to the public: each thing a real launch needs, checked on this server, with what to do when it is
   * not ready. "required" ones block a launch; the others are strongly advised.
   */
  @Get('launch')
  @ApiOperation({ summary: 'Launch readiness checklist (administrators only)' })
  async launch() {
    const c = this.config;
    const [billing, google, admins, official, workers, pushKey] = await Promise.all([
      loadStored(this.prisma, c).then((s) => effective(c, s)).catch(() => null),
      loadGoogleSettings(this.prisma, c).catch(() => undefined),
      this.prisma.user.count({ where: { roles: { has: 'ADMIN' } } }),
      this.prisma.channel.findFirst({ where: { isVerified: true, user: { roles: { has: 'ADMIN' } } }, select: { name: true, handle: true } }),
      this.media.queue ? this.media.queue.getWorkers().then((w) => w.length).catch(() => 0) : Promise.resolve(-1),
      this.prisma.appSetting.findUnique({ where: { key: 'push' }, select: { key: true } }),
    ]);
    const googleOn = google === undefined ? !!c.google : !!(google?.enabled && google.clientId && google.clientSecret);
    const pay = billing ? [billing.momo && 'MTN MoMo', billing.flutterwave && 'cards (Flutterwave)', billing.manual && 'manual payments'].filter(Boolean) as string[] : [];
    const checks = [
      { id: 'https', required: true, ok: c.appUrl.startsWith('https://'), label: 'Secure address (https)', detail: c.appUrl, fix: 'Point your domain at the server, set APP_URL=https://your-domain in /etc/freeme/freeme.env and run the install again: Caddy gets the certificate by itself.' },
      { id: 'workers', required: true, ok: workers !== 0, label: 'Video workers running', detail: workers < 0 ? 'Videos are processed inside the API (no Redis): fine for one small server.' : `${workers} connected`, fix: 'Start the media worker: sudo systemctl enable --now freeme-worker@1 (see DEPLOYMENT.md).' },
      { id: 'storage', required: false, ok: c.media.driver === 's3', label: 'Object storage for videos', detail: c.media.driver === 's3' ? 'S3-compatible storage' : 'Files on this server’s disk', fix: 'For growth, use object storage (Hetzner, Wasabi, R2…): deploy/ubuntu/storage-setup.sh and the S3_* settings.' },
      { id: 'cdn', required: false, ok: c.media.driver === 's3' && !!process.env.MEDIA_PUBLIC_BASE_URL, label: 'CDN in front of videos', detail: c.media.publicBaseUrl || 'none', fix: 'Set MEDIA_PUBLIC_BASE_URL to your CDN address (e.g. https://media.your-domain) so videos load fast everywhere.' },
      { id: 'email', required: true, ok: c.mail.transport === 'smtp', label: 'Email delivery (sign-in codes)', detail: c.mail.transport === 'smtp' ? c.mail.from : 'Emails are only written to the log', fix: 'Set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM (any SMTP service: Brevo, Mailgun, Gmail Workspace…).' },
      { id: 'payments', required: false, ok: pay.length > 0, label: 'A way to pay', detail: pay.length ? pay.join(', ') : 'None switched on', fix: 'Administration → Money → Payment settings: start with “Send money (manual)” and your MoMo number.' },
      { id: 'google', required: false, ok: googleOn, label: 'Google sign-in', detail: googleOn ? 'On' : 'Off (email codes still work)', fix: 'Administration → Sign-in: paste the Client ID and secret from Google Cloud Console.' },
      { id: 'admin', required: true, ok: admins > 0, label: 'An administrator', detail: `${admins} administrator account(s)`, fix: 'npm run make-admin -- you@example.com' },
      { id: 'official', required: false, ok: !!official, label: 'Official verified Space', detail: official ? `${official.name} (@${official.handle})` : 'None', fix: 'npm run make-admin -- you@example.com --space "Free Me" --handle freeme' },
      { id: 'push', required: false, ok: !!pushKey && c.appUrl.startsWith('https://'), label: 'Phone notifications', detail: pushKey ? 'Ready' : 'Made automatically the first time someone turns them on', fix: 'Needs the https address; nothing else to set.' },
    ];
    return { ready: checks.every((x) => x.ok || !x.required), checks };
  }

  @Get()
  @ApiOperation({ summary: 'Health, processing queue, stuck and failed videos, storage used and accounts (administrators only)' })
  async status() {
    const now = Date.now();
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const).catch(() => 'down' as const);
    const [redis, queue, upgradeQueue, byStatus, stuck, failed24h, sizes, renditionBytes, users, newUsers24h, channels, openReports] = await Promise.all([
      this.redis.ping(),
      this.media.queue ? this.media.queue.getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => null) : Promise.resolve(null),
      this.media.upgradeQueue?.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed').catch(() => null) ?? Promise.resolve(null),
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
      processing: { queue, upgradeQueue, stuckOver2h: stuck, failedLast24h: failed24h, videosNeedingUpgrade: needsUpgrade },
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
