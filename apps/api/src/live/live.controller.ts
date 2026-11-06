import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import type { Channel, LiveStream } from '@prisma/client';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { Webhook } from '../common/origin.guard';
import type { AuthContext } from '../common/request';
import { publish, room } from '../realtime/publish';
import { LiveError, LiveService } from './live.service';
import { endLive, LIVE_PLAYLIST } from './sync';

class TitleDto { @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) title?: string }
/** nginx-rtmp posts its callbacks as a form: the stream name (the key the encoder used) and more. */
class RtmpDto { @IsOptional() @IsString() name?: string; @IsOptional() @IsString() call?: string; @IsOptional() @IsString() app?: string; @IsOptional() @IsString() addr?: string }

@ApiTags('live')
@Controller()
export class LiveController {
  constructor(private readonly prisma: PrismaService, private readonly live: LiveService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private playback(s: LiveStream) { return s.status === 'LIVE' ? `${this.config.media.publicBaseUrl}/live/${s.id}/${LIVE_PLAYLIST}` : null; }
  private async view(s: LiveStream & { channel: Channel }) {
    return {
      id: s.id, title: s.title, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, playbackUrl: this.playback(s), viewers: s.status === 'LIVE' ? await this.live.viewers(s.id) : 0,
      peakViewers: s.peakViewers, replayVideoId: s.replayVideoId,
      channel: { handle: s.channel.handle, name: s.channel.name, avatarUrl: s.channel.avatarUrl, isVerified: s.channel.isVerified },
    };
  }
  private attempt<T>(fn: () => Promise<T>) { return fn().catch((e) => { if (e instanceof LiveError) throw new BadRequestException(e.message); throw e; }); }

  @Get('live')
  @ApiOperation({ summary: 'Spaces live right now' })
  async now() {
    const rows = await this.prisma.liveStream.findMany({ where: { status: 'LIVE' }, orderBy: { startedAt: 'desc' }, take: 50, include: { channel: true } });
    return { streams: await Promise.all(rows.map((s) => this.view(s))) };
  }

  @Get('live/:id')
  @ApiOperation({ summary: 'One live stream (and the recent chat)' })
  async one(@Param('id', ParseUUIDPipe) id: string) {
    const s = await this.prisma.liveStream.findUnique({ where: { id }, include: { channel: true } });
    if (!s) throw new NotFoundException('This live stream does not exist.');
    const replay = s.replayVideoId ? await this.prisma.video.findFirst({ where: { id: s.replayVideoId, status: 'READY', visibility: { in: ['PUBLIC', 'UNLISTED'] }, takenDownAt: null }, select: { id: true } }) : null;
    return { stream: { ...(await this.view(s)), replayVideoId: replay?.id ?? null }, chat: s.status === 'LIVE' ? await this.live.recentChat(id) : [] };
  }

  @Get('hub/live')
  @RequireAuth()
  @ApiOperation({ summary: 'My Live Studio: the current stream, the encoder address and key' })
  async studio(@CurrentAuth() auth: AuthContext) {
    const s = await this.attempt(() => this.live.mine(auth.user.id));
    const full = await this.prisma.liveStream.findUniqueOrThrow({ where: { id: s.id }, include: { channel: true } });
    const past = await this.prisma.liveStream.findMany({ where: { channelId: s.channelId, status: 'ENDED' }, orderBy: { endedAt: 'desc' }, take: 10 });
    const premium = !!auth.user.premiumUntil && auth.user.premiumUntil > new Date();
    return {
      premium, stream: await this.view(full),
      encoder: this.config.live.rtmpUrl && premium ? { server: this.config.live.rtmpUrl, streamKey: await this.live.streamKey(auth.user.id) } : null,
      past: past.map((p) => ({ id: p.id, title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, peakViewers: p.peakViewers, replayVideoId: p.replayVideoId })),
    };
  }

  @Patch('hub/live')
  @RequireAuth()
  @ApiOperation({ summary: 'Set the title of my stream' })
  async setTitle(@CurrentAuth() auth: AuthContext, @Body() body: TitleDto) {
    const s = await this.attempt(() => this.live.mine(auth.user.id));
    if (body.title?.trim()) { await this.prisma.liveStream.update({ where: { id: s.id }, data: { title: body.title.trim() } }); publish(room.live(s.id), 'title', { title: body.title.trim() }); }
    return this.studio(auth);
  }

  @Post('hub/live/key')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Make a new encoder key (the old one stops working)' })
  async resetKey(@CurrentAuth() auth: AuthContext) {
    if (!(auth.user.premiumUntil && auth.user.premiumUntil > new Date())) throw new ForbiddenException('Live Studio is part of Premium.');
    return { streamKey: await this.live.streamKey(auth.user.id, true) };
  }

  @Post('hub/live/end')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'End my stream (encoder streams end by themselves when the encoder stops)' })
  async end(@CurrentAuth() auth: AuthContext) {
    const s = await this.attempt(() => this.live.mine(auth.user.id));
    if (!(await this.live.stopBrowser(s.id))) await endLive(this.prisma, s.id);
    return { ended: true };
  }

  // ----- nginx-rtmp callbacks (on the private network; the secret is in the configured address) -----

  private checkSecret(secret?: string) { if (!this.config.live.rtmpSecret || secret !== this.config.live.rtmpSecret) throw new ForbiddenException('Unknown sender.'); }

  @Post('live/rtmp/publish')
  @Webhook()
  @ApiOperation({ summary: 'nginx-rtmp on_publish: the encoder\'s key is checked; the stream is renamed to its id (never the key) so the key never appears in public addresses' })
  async rtmpPublish(@Query('secret') secret: string, @Body() body: RtmpDto, @Res() res: Response) {
    this.checkSecret(secret);
    const key = body.name ?? '';
    const ch = key ? await this.prisma.channel.findUnique({ where: { liveStreamKey: key }, include: { user: true } }) : null;
    if (!ch || ch.user.status !== 'ACTIVE') return res.status(403).send('unknown key');
    try {
      const s = await this.live.mine(ch.userId);
      await this.live.goLive(ch.user, s.id, 'rtmp');
      // A 3xx answer makes nginx-rtmp publish under the name in Location: the stream id.
      return res.redirect(302, s.id);
    } catch (e) { return res.status(403).send(e instanceof LiveError ? e.message : 'refused'); }
  }

  @Post('live/rtmp/done')
  @Webhook()
  @HttpCode(200)
  @ApiOperation({ summary: 'nginx-rtmp on_publish_done: the encoder stopped' })
  async rtmpDone(@Query('secret') secret: string, @Body() body: RtmpDto) {
    this.checkSecret(secret);
    const name = body.name ?? '';
    // After the rename, nginx reports the stream id; before it, the key.
    const s = /^[0-9a-f-]{36}$/.test(name) ? await this.prisma.liveStream.findUnique({ where: { id: name } })
      : await this.prisma.liveStream.findFirst({ where: { status: 'LIVE', source: 'rtmp', channel: { liveStreamKey: name } } });
    if (s?.source === 'rtmp') await endLive(this.prisma, s.id);
    return { ok: true };
  }
}
