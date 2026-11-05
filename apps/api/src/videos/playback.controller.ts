import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth } from '../common/auth.guard';
import { clientIp, userAgent, type AppRequest, type AuthContext } from '../common/request';
import { mediaPrefix } from '../media/keys';
import { STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';
import { ViewCounter } from '../media/views';
import { MediaUrls } from './media-urls';

class ViewDto { @ApiProperty({ description: 'Seconds actually watched' }) @IsNumber() @Min(0) @Max(86_400) watchedSeconds!: number }

@ApiTags('playback')
@Controller('videos')
export class PlaybackController {
  private readonly views: ViewCounter;
  constructor(private readonly prisma: PrismaService, redis: RedisService, private readonly limits: RateLimitService, private readonly urls: MediaUrls, @Inject(STORAGE) private readonly storage: Storage) {
    this.views = new ViewCounter(prisma, redis.client);
  }

  private async viewable(id: string, auth: AuthContext | null) {
    const v = await this.prisma.video.findUnique({ where: { id }, include: { channel: { select: { userId: true } } } });
    if (!v || v.status !== 'READY' || !v.hlsMasterKey) throw new NotFoundException('This video is not available.');
    if (v.visibility === 'PRIVATE' && v.channel.userId !== auth?.user.id) throw new NotFoundException('This video is not available.');
    return v;
  }

  @Get(':id/hls/:a')
  @ApiOperation({ summary: 'Master playlist through the API (private media, or while media is moving)' })
  master(@Param('id', ParseUUIDPipe) id: string, @Param('a') a: string, @CurrentAuth() auth: AuthContext | null, @Res() res: Response) {
    return this.playlist(id, a, auth, res);
  }

  @Get(':id/hls/:a/:b')
  @ApiOperation({ summary: 'Variant playlist with short-lived signed segment links' })
  variant(@Param('id', ParseUUIDPipe) id: string, @Param('a') a: string, @Param('b') b: string, @CurrentAuth() auth: AuthContext | null, @Res() res: Response) {
    return this.playlist(id, `${a}/${b}`, auth, res);
  }

  private async playlist(id: string, path: string, auth: AuthContext | null, res: Response) {
    if (!/^(master\.m3u8|\d{3,4}p\/index\.m3u8)$/.test(path)) throw new NotFoundException();
    const v = await this.viewable(id, auth);
    const prefix = mediaPrefix(id, v.mediaLocation);
    const text = await this.storage.getText(`${prefix}hls/${path}`);
    if (text === null) throw new NotFoundException('This video is not available.');
    let body = text;
    if (path !== 'master.m3u8') {
      const dir = `hls/${path.split('/')[0]}/`;
      const link = (file: string) => this.urls.file(v, dir + file);
      const lines = await Promise.all(text.split('\n').map(async (line) => {
        if (/^#EXT-X-MAP:URI="([^"]+)"/.test(line)) { const f = /URI="([^"]+)"/.exec(line)![1]; return line.replace(f, await link(f)); }
        return line && !line.startsWith('#') && /^[\w.-]+$/.test(line) ? link(line) : line;
      }));
      body = lines.join('\n');
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
  }

  @Post(':id/views')
  @HttpCode(200)
  @ApiOperation({ summary: 'Count a view (sent by the player after real watching); once per viewer per 6 hours' })
  async view(@Param('id', ParseUUIDPipe) id: string, @Body() body: ViewDto, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    const ip = clientIp(req) ?? 'unknown';
    await this.limits.consume(`views:${ip}`, 600, 3600);
    const v = await this.viewable(id, auth);
    if (v.channel.userId === auth?.user.id) return { counted: false };
    const minimum = Math.min(30, v.durationSeconds * 0.5);
    if (body.watchedSeconds + 0.5 < minimum) throw new BadRequestException('Not watched long enough to count.');
    const viewer = auth ? `u:${auth.user.id}` : `a:${createHash('sha256').update(`${ip}|${userAgent(req) ?? ''}`).digest('hex').slice(0, 32)}`;
    return { counted: await this.views.record(id, viewer, Math.min(body.watchedSeconds, v.durationSeconds + 5)) };
  }
}
