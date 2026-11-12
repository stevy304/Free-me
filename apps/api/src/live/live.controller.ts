import { createHmac } from 'node:crypto';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Channel, LiveStream, Prisma } from '@prisma/client';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import { Webhook } from '../common/origin.guard';
import type { AuthContext } from '../common/request';
import { publish, room } from '../realtime/publish';
import { LiveError, LiveService } from './live.service';
import { hasPremiumAccess } from '../billing/billing';
import { endLive, LIVE_PLAYLIST } from './sync';

/** Live settings: every field optional; only those sent change. */
class LiveSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED']) visibility?: 'PUBLIC' | 'UNLISTED';
  @ApiPropertyOptional({ description: 'ISO date and time it is planned to start; null clears it' }) @IsOptional() @IsDateString() scheduledFor?: string | null;
  @ApiPropertyOptional({ enum: ['everyone', 'followers', 'off'] }) @IsOptional() @IsIn(['everyone', 'followers', 'off']) chatMode?: string;
  @ApiPropertyOptional({ enum: [0, 5, 10, 30, 60, 120] }) @IsOptional() @IsInt() @IsIn([0, 5, 10, 30, 60, 120]) slowModeSeconds?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() captionsEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() saveReplay?: boolean;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED', 'PRIVATE']) replayVisibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  @ApiPropertyOptional({ enum: ['normal', 'low'], description: 'normal: about 10-15 s behind, steadiest; low: about 4-6 s, for talking with chat' }) @IsOptional() @IsIn(['normal', 'low']) latencyMode?: 'normal' | 'low';
}
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
      description: s.description, visibility: s.visibility, scheduledFor: s.scheduledFor,
      chat: { mode: s.chatMode, slowModeSeconds: s.slowModeSeconds }, captionsEnabled: s.captionsEnabled, latencyMode: s.latencyMode,
      poll: s.status === 'LIVE' ? await this.live.poll(s.id) : null,
      channel: { handle: s.channel.handle, name: s.channel.name, avatarUrl: s.channel.avatarUrl, isVerified: s.channel.isVerified },
    };
  }
  private attempt<T>(fn: () => Promise<T>) { return fn().catch((e) => { if (e instanceof LiveError) throw new BadRequestException(e.message); throw e; }); }

  @Get('live')
  @ApiOperation({ summary: 'Spaces live right now, and streams planned for the next 7 days (public ones only)' })
  async now() {
    const [rows, upcoming] = await Promise.all([
      this.prisma.liveStream.findMany({ where: { status: 'LIVE', visibility: 'PUBLIC' }, orderBy: { startedAt: 'desc' }, take: 50, include: { channel: true } }),
      this.prisma.liveStream.findMany({ where: { status: 'IDLE', visibility: 'PUBLIC', scheduledFor: { gt: new Date(Date.now() - 3600_000), lt: new Date(Date.now() + 7 * 86_400_000) } }, orderBy: { scheduledFor: 'asc' }, take: 20, include: { channel: true } }),
    ]);
    return { streams: await Promise.all(rows.map((s) => this.view(s))), upcoming: await Promise.all(upcoming.map((s) => this.view(s))) };
  }

  @Get('live/ice')
  @Header('Cache-Control', 'private, no-store')
  @RequireAuth()
  @ApiOperation({ summary: 'Temporary ICE configuration for an authenticated broadcast participant' })
  ice(@CurrentAuth() auth: AuthContext) {
    const turn = this.config.live.turn;
    if (!turn) return { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
    const username = `${Math.floor(Date.now() / 1000) + 8 * 3600}:${auth.user.id}`;
    const credential = createHmac('sha1', turn.secret).update(username).digest('base64');
    return { iceServers: [{ urls: turn.urls, username, credential }] };
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
    const premium = hasPremiumAccess(auth.user);
    const past = premium ? await this.prisma.liveStream.findMany({ where: { channelId: s.channelId, status: 'ENDED' }, orderBy: { endedAt: 'desc' }, take: 10 }) : [];
    return {
      // The host also sees what happens to the recording (not part of the public view).
      premium, stream: { ...(await this.view(full)), saveReplay: full.saveReplay, replayVisibility: full.replayVisibility },
      encoder: this.config.live.rtmpUrl && premium ? { server: this.config.live.rtmpUrl, streamKey: await this.live.streamKey(auth.user.id) } : null,
      past: past.map((p) => ({ id: p.id, title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, peakViewers: p.peakViewers, replayVideoId: p.replayVideoId })),
    };
  }

  @Patch('hub/live')
  @RequireAuth()
  @ApiOperation({ summary: 'Change my stream\'s settings: title, description, who can find it, schedule, chat, live captions and the replay' })
  async setTitle(@CurrentAuth() auth: AuthContext, @Body() body: LiveSettingsDto) {
    const s = await this.attempt(() => this.live.mine(auth.user.id));
    const data: Prisma.LiveStreamUpdateInput = {};
    if (body.title?.trim()) data.title = body.title.trim();
    if (body.description !== undefined) data.description = body.description.trim() || null;
    if (body.visibility) data.visibility = body.visibility;
    if (body.scheduledFor !== undefined) {
      const at = body.scheduledFor ? new Date(body.scheduledFor) : null;
      if (at && (at.getTime() < Date.now() - 60_000 || at.getTime() > Date.now() + 90 * 86_400_000)) throw new BadRequestException('Choose a time in the next 90 days.');
      data.scheduledFor = at;
    }
    if (body.chatMode) data.chatMode = body.chatMode;
    if (body.slowModeSeconds !== undefined) data.slowModeSeconds = body.slowModeSeconds;
    if (body.captionsEnabled !== undefined) data.captionsEnabled = body.captionsEnabled;
    if (body.latencyMode) data.latencyMode = body.latencyMode;
    if (body.saveReplay !== undefined) data.saveReplay = body.saveReplay;
    if (body.replayVisibility) data.replayVisibility = body.replayVisibility;
    if (Object.keys(data).length) {
      const next = await this.prisma.liveStream.update({ where: { id: s.id }, data });
      // Viewers see title, description and chat rules change at once.
      publish(room.live(s.id), 'settings', { title: next.title, description: next.description, chat: { mode: next.chatMode, slowModeSeconds: next.slowModeSeconds }, captionsEnabled: next.captionsEnabled, latencyMode: next.latencyMode });
      if (data.title) publish(room.live(s.id), 'title', { title: next.title });
    }
    return this.studio(auth);
  }

  @Post('hub/live/key')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Make a new encoder key (the old one stops working)' })
  async resetKey(@CurrentAuth() auth: AuthContext) {
    if (!hasPremiumAccess(auth.user)) throw new ForbiddenException('Live Studio is part of Premium.');
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
