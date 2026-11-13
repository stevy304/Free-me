import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, type AppRequest, type AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { CODECS, DEVICES, DIMENSIONS, NETWORKS, QoeCounter, summarise, type Dimension } from '../media/qoe';
import { hotWatchable } from './hot-video';

class QoeDto {
  @IsOptional() @IsInt() @Min(0) @Max(120_000) startupMs?: number;
  @IsInt() @Min(0) @Max(3600) playedSeconds!: number;
  @IsInt() @Min(0) @Max(1000) stalls!: number;
  @IsInt() @Min(0) @Max(3_600_000) stallMs!: number;
  @IsInt() @Min(0) @Max(4320) shortSide!: number;
  @IsIn(CODECS) codec!: typeof CODECS[number];
  @IsIn(DEVICES) device!: typeof DEVICES[number];
  @IsIn(NETWORKS) network!: typeof NETWORKS[number];
  @IsBoolean() error!: boolean;
  @IsBoolean() first!: boolean;
  @IsBoolean() firstStall!: boolean;
}

/** Playback quality as viewers experience it (media/qoe.ts): reported by players, read by administrators. */
@ApiTags('engagement')
@Controller()
export class QoeController {
  private readonly counter: QoeCounter;
  constructor(private readonly prisma: PrismaService, redis: RedisService, private readonly limits: RateLimitService, @Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.counter = new QoeCounter(prisma, redis.client);
  }

  @Post('videos/:id/qoe')
  @HttpCode(200)
  @ApiOperation({ summary: 'A playback\'s summary (time to first frame, rebuffering, quality shown, errors); only counted, nothing about the viewer is kept' })
  async report(@Param('id', ParseUUIDPipe) id: string, @Body() b: QoeDto, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    await this.limits.consume(`qoe:${clientIp(req) ?? 'unknown'}`, 600, 3600);
    await hotWatchable(this.prisma, id, auth);
    const header = this.config.geoCountryHeader ? req.headers[this.config.geoCountryHeader] : undefined;
    const fromEdge = typeof header === 'string' && /^[A-Za-z]{2}$/.test(header) && header.toUpperCase() !== 'XX' ? header.toUpperCase() : null;
    const country = fromEdge ?? (auth ? (await this.prisma.profile.findUnique({ where: { userId: auth.user.id }, select: { country: true } }))?.country : null) ?? 'ZZ';
    await this.counter.record({ country, codec: b.codec, device: b.device, network: b.network, startupMs: b.startupMs ?? null, playedSeconds: b.playedSeconds,
      stalls: b.stalls, stallMs: b.stallMs, shortSide: b.shortSide, error: b.error, firstStall: b.firstStall }, b.first);
    return { recorded: true };
  }

  @Get('admin/qoe')
  @RequireAuth('ADMIN')
  @ApiOperation({ summary: 'Playback quality over the last hours, overall and by country, codec, device or connection' })
  async summary(@Query('hours') hoursArg?: string, @Query('by') byArg?: string) {
    const hours = Math.min(24 * 30, Math.max(1, Math.floor(Number(hoursArg) || 24)));
    const by = (DIMENSIONS as readonly string[]).includes(byArg ?? '') ? byArg as Dimension : null;
    const rows = await this.counter.read(new Date(Date.now() - hours * 3_600_000));
    return { hours, by, total: summarise(rows, null)[0] ?? null, groups: by ? summarise(rows, by) : [] };
  }
}
