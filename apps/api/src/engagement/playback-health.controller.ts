import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, type AppRequest, type AuthContext } from '../common/request';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { watchable } from './access';

const KINDS = ['startup', 'buffer', 'recovery'] as const;
type Kind = typeof KINDS[number];
interface Sample { kind: Kind; durationMs: number; at: number }
const KEY = 'fm:playback-health:v1';
const WINDOW = 24 * 60 * 60 * 1000;
const LIMIT = 1000;

class PlaybackSampleDto {
  @IsIn(KINDS) kind!: Kind;
  @IsInt() @Min(0) @Max(WINDOW) durationMs!: number;
}

/** Bounded diagnostic samples. No account, video, IP address, or device identifiers are retained. */
@Controller()
export class PlaybackHealthController {
  private local: Sample[] = [];

  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly limits: RateLimitService) {}

  @Post('videos/:id/playback-health')
  @HttpCode(200)
  async record(@Param('id', ParseUUIDPipe) id: string, @Body() body: PlaybackSampleDto, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    await this.limits.consume(`playback-health:${clientIp(req) ?? 'unknown'}`, 300, 3600);
    await watchable(this.prisma, id, auth);
    const sample: Sample = { kind: body.kind, durationMs: body.durationMs, at: Date.now() };
    if (this.redis.client) {
      const result = await this.redis.client.multi()
        .lpush(KEY, JSON.stringify(sample)).ltrim(KEY, 0, LIMIT - 1).expire(KEY, WINDOW / 1000).exec();
      if (!result || result.some(([error]) => error)) throw new Error('Playback samples could not be stored.');
    } else {
      this.local = [sample, ...this.local.filter((s) => s.at > sample.at - WINDOW)].slice(0, LIMIT);
    }
    return { recorded: true };
  }

  @Get('admin/playback-health')
  @RequireAuth('ADMIN')
  async summary() {
    const since = Date.now() - WINDOW;
    const rows: Sample[] = this.redis.client
      ? (await this.redis.client.lrange(KEY, 0, LIMIT - 1)).flatMap((raw) => {
        try {
          const s = JSON.parse(raw) as Sample;
          return KINDS.includes(s.kind) && Number.isInteger(s.durationMs) && s.durationMs >= 0 && s.durationMs <= WINDOW && s.at > since ? [s] : [];
        } catch { return []; }
      })
      : this.local.filter((s) => s.at > since);
    return {
      storage: this.redis.client ? 'shared' : 'this server',
      windowHours: 24, sampleLimit: LIMIT,
      metrics: KINDS.map((kind) => {
        const values = rows.filter((s) => s.kind === kind).map((s) => s.durationMs).sort((a, b) => a - b);
        const percentile = (p: number) => values.length ? values[Math.ceil(values.length * p) - 1] : null;
        return { kind, count: values.length, medianMs: percentile(0.5), p95Ms: percentile(0.95) };
      }),
    };
  }
}
