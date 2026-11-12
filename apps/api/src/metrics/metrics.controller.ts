import { Controller, Get, Headers, Inject, NotFoundException, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Gauge, type Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { MediaQueue } from '../media/queue';
import { METRICS, tokenMatches } from './metrics';

const STATES = ['waiting', 'active', 'delayed', 'failed', 'prioritized'] as const;

/**
 * GET /api/metrics for Prometheus (Authorization: Bearer METRICS_TOKEN). Besides this instance's own numbers it
 * reports platform-wide ones read when scraped: media queue backlog and videos waiting to be processed.
 * Answers 404 when METRICS_TOKEN is not set or the token is wrong, so it does not advertise itself.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly registry: Registry, @Inject(APP_CONFIG) private readonly config: AppConfig, prisma: PrismaService, queue: MediaQueue) {
    if (registry.getSingleMetric('freeme_media_queue_jobs')) return;
    new Gauge({
      name: 'freeme_media_queue_jobs', help: 'Media jobs by queue and state', labelNames: ['queue', 'state'] as const, registers: [registry],
      async collect() {
        for (const [name, q] of [['media', queue.queue], ['upgrades', queue.upgradeQueue]] as const) {
          if (!q) continue;
          const counts = await q.getJobCounts(...STATES);
          for (const state of STATES) this.set({ queue: name, state }, counts[state] ?? 0);
        }
      },
    });
    new Gauge({
      name: 'freeme_videos_processing', help: 'Videos uploaded and not yet playable, and the age of the oldest (seconds)', labelNames: ['measure'] as const, registers: [registry],
      async collect() {
        const [count, oldest] = await Promise.all([
          prisma.video.count({ where: { status: 'PROCESSING' } }),
          prisma.video.findFirst({ where: { status: 'PROCESSING' }, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }),
        ]);
        this.set({ measure: 'count' }, count);
        this.set({ measure: 'oldest_seconds' }, oldest ? Math.round((Date.now() - oldest.updatedAt.getTime()) / 1000) : 0);
      },
    });
    new Gauge({
      name: 'freeme_videos_hd_pending', help: 'Videos whose 1080p and above wait for viewers (HD_MIN_VIEWS)', registers: [registry],
      async collect() { this.set(await prisma.video.count({ where: { hdPending: true } })); },
    });
  }

  @Get()
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    if (!tokenMatches(auth, this.config.metricsToken)) throw new NotFoundException();
    res.setHeader('Content-Type', this.registry.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(await this.registry.metrics());
  }
}
