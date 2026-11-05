import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { APP_CONFIG, type AppConfig } from '../config/config';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @ApiOperation({ summary: 'Liveness and dependencies, for the load balancer and monitoring' })
  async health(@Res() res: Response) {
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const).catch(() => 'down' as const);
    const redis = await this.redis.ping();
    // Several API instances must share rate limits: production without Redis is unhealthy.
    const ok = db === 'ok' && (redis === 'ok' || (redis === 'not configured' && this.config.nodeEnv !== 'production'));
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', database: db, redis, time: new Date().toISOString() });
  }
}
