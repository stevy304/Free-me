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
import { hasPlus } from '../billing/billing';

/** Who is watching, for counting: the account, or a hash of address and browser for visitors. */
const viewerKey = (auth: AuthContext | null, req: AppRequest) => auth ? `u:${auth.user.id}` : `a:${createHash('sha256').update(`${clientIp(req) ?? 'unknown'}|${userAgent(req) ?? ''}`).digest('hex').slice(0, 32)}`;

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
    if ((v.visibility === 'PRIVATE' || v.reviewHoldAt) && v.channel.userId !== auth?.user.id) throw new NotFoundException('This video is not available.');
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
    if (!/^(master(-full)?\.m3u8|((av1-)?\d{3,4}p|audio)\/index\.m3u8)$/.test(path)) throw new NotFoundException();
    const v = await this.viewable(id, auth);
    // Every quality is for Premium members and the owner; everyone else gets the limited master playlist.
    if (path === 'master-full.m3u8' && v.channel.userId !== auth?.user.id && !(auth && await hasPlus(this.prisma, auth.user))) throw new NotFoundException();
    const prefix = mediaPrefix(id, v.mediaLocation);
    const text = await this.storage.getText(`${prefix}hls/${path}`);
    if (text === null) throw new NotFoundException('This video is not available.');
    let body = text;
    if (!path.startsWith('master')) {
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

  @Get(':id/captions/:file')
  @ApiOperation({ summary: 'Captions in one language as WebVTT (file name is <language>.vtt)' })
  async captions(@Param('id', ParseUUIDPipe) id: string, @Param('file') file: string, @CurrentAuth() auth: AuthContext | null, @Res() res: Response) {
    const m = /^([a-z]{2,3})\.vtt$/.exec(file);
    if (!m) throw new NotFoundException();
    const v = await this.viewable(id, auth);
    const c = await this.prisma.caption.findUnique({ where: { videoId_language: { videoId: id, language: m[1] } } });
    const text = c ? await this.storage.getText(mediaPrefix(id, v.mediaLocation) + c.key) : null;
    if (text === null) throw new NotFoundException('No captions in that language.');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', v.visibility === 'PRIVATE' ? 'private, no-store' : 'public, max-age=300');
    res.send(text);
  }

  @Get(':id/storyboard.vtt')
  @ApiOperation({ summary: 'Seek-bar previews as WebVTT: each cue is a time range and the part of the sprite sheet (#xywh) to show' })
  async storyboard(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null, @Res() res: Response) {
    const v = await this.viewable(id, auth);
    const sb = v.storyboard as { key: string; interval: number; count: number; cols: number; width: number; height: number } | null;
    if (!sb?.key) throw new NotFoundException('This video has no previews.');
    const sheet = await this.urls.file(v, sb.key);
    const t = (s: number) => new Date(Math.min(s, 359_999) * 1000).toISOString().slice(11, 23);
    const cues: string[] = ['WEBVTT', ''];
    for (let i = 0; i < sb.count; i++) {
      const start = i * sb.interval;
      if (start >= (v.durationSeconds || Infinity)) break;
      const end = Math.min((i + 1) * sb.interval, v.durationSeconds || (i + 1) * sb.interval);
      cues.push(`${t(start)} --> ${t(end)}`, `${sheet}#xywh=${(i % sb.cols) * sb.width},${Math.floor(i / sb.cols) * sb.height},${sb.width},${sb.height}`, '');
    }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    // Private sheets are signed links that expire: never cache those for long.
    res.setHeader('Cache-Control', v.mediaLocation === 'PUBLIC' ? 'public, max-age=300' : 'private, no-store');
    res.send(cues.join('\n'));
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
    const viewer = viewerKey(auth, req);
    // Watch time of Plus, Family and Premium members shares their subscription money with creators.
    const plus = !!auth && await hasPlus(this.prisma, auth.user);
    return { counted: await this.views.record(id, viewer, Math.min(body.watchedSeconds, v.durationSeconds + 5), plus) };
  }

  @Post(':id/watch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Watch-time heartbeat after the view was counted: seconds played since the last report (checked against real time)' })
  async watch(@Param('id', ParseUUIDPipe) id: string, @Body() body: ViewDto, @CurrentAuth() auth: AuthContext | null, @Req() req: AppRequest) {
    await this.limits.consume(`watch:${clientIp(req) ?? 'unknown'}`, 1200, 3600);
    const v = await this.viewable(id, auth);
    if (v.channel.userId === auth?.user.id) return { seconds: 0 };
    const plus = !!auth && await hasPlus(this.prisma, auth.user);
    return { seconds: await this.views.addWatch(id, viewerKey(auth, req), body.watchedSeconds, v.durationSeconds, plus) };
  }
}
