import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { MediaJobs, type MediaJob } from './jobs';
import { createStorage, type Storage } from './storage';

export const MEDIA_QUEUE = 'media';
export const STORAGE = Symbol('STORAGE');

/** Job options: transcodes retry twice; moves wait while a video is busy; deletes retry until done. */
export function jobOptions(name: MediaJob['name']) {
  return {
    jobId: undefined as string | undefined,
    attempts: name === 'transcode' ? 3 : 20,
    backoff: { type: 'exponential' as const, delay: name === 'transcode' ? 30_000 : 5_000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
}

/**
 * Sends media jobs to the media node (BullMQ on Redis). Without Redis (local development) the API runs the job
 * itself in the background, so uploading works on one machine without a worker.
 */
@Injectable()
export class MediaQueue implements OnModuleDestroy {
  private readonly log = new Logger('MediaQueue');
  readonly queue: Queue | null;
  private readonly connection: Redis | null;
  private readonly inline: MediaJobs | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig, redis: RedisService, prisma: PrismaService, @Inject(STORAGE) storage: Storage) {
    // BullMQ does not close a connection it was given, so this service owns and closes it.
    this.connection = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: null }) : null;
    this.queue = this.connection ? new Queue(MEDIA_QUEUE, { connection: this.connection, prefix: config.media.queuePrefix }) : null;
    this.inline = this.queue ? null : new MediaJobs(prisma, storage, config, redis.client);
    if (this.inline) this.log.warn('REDIS_URL is not set: media jobs run inside the API (development only).');
  }

  async add(job: MediaJob) {
    if (this.queue) { await this.queue.add(job.name, job, jobOptions(job.name)); return; }
    void this.inline!.run(job, true).catch((e) => this.log.error(`${job.name} ${job.videoId}: ${(e as Error).message}`));
  }

  async onModuleDestroy() { await this.queue?.close(); await this.connection?.quit().catch(() => undefined); }
}

export const storageProvider = { provide: STORAGE, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createStorage(c) };
