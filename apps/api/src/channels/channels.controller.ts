import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { handleProblem, isCountryCode, isLanguageCode, normalizeHandle } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { publicChannel } from '../users/serialize';
import { PUBLIC_VIDEO, videoCard } from '../catalog/serialize';
import { CreateChannelDto, UpdateChannelDto } from './channels.dto';
import { MediaUrls } from '../videos/media-urls';
import { hasPremiumAccess } from '../billing/billing';

@ApiTags('channels')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly limits: RateLimitService, private readonly urls: MediaUrls) {}

  @Get('handle-available')
  @ApiOperation({ summary: 'Whether a handle can be taken' })
  async handleAvailable(@Query('handle') handle = '') {
    const problem = handleProblem(handle);
    if (problem) return { available: false, reason: problem };
    const taken = await this.prisma.channel.findUnique({ where: { handle: normalizeHandle(handle) }, select: { id: true } });
    return taken ? { available: false, reason: 'This handle is taken.' } : { available: true, handle: normalizeHandle(handle) };
  }

  @Post()
  @RequireAuth()
  @ApiOperation({ summary: 'Create my channel (one per account); makes the account a creator' })
  async create(@CurrentAuth() auth: AuthContext, @Body() body: CreateChannelDto, @Req() req: AppRequest) {
    await this.limits.consume(`channel:create:${auth.user.id}`, 10, 3600);
    const problem = handleProblem(body.handle);
    if (problem) throw new BadRequestException(problem);
    if (body.country && !isCountryCode(body.country)) throw new BadRequestException('Choose a country from the list.');
    if (body.defaultLanguage && !isLanguageCode(body.defaultLanguage)) throw new BadRequestException('Choose a language from the list.');
    if (await this.prisma.channel.findUnique({ where: { userId: auth.user.id }, select: { id: true } })) throw new ConflictException('You already have a channel.');
    const handle = normalizeHandle(body.handle);
    if (await this.prisma.channel.findUnique({ where: { handle }, select: { id: true } })) throw new ConflictException('This handle is taken.');
    const channel = await this.prisma.$transaction(async (tx) => {
      const c = await tx.channel.create({ data: { userId: auth.user.id, handle, name: body.name.trim(), description: body.description?.trim() || null, country: body.country?.toUpperCase() ?? null, defaultLanguage: body.defaultLanguage?.toLowerCase() ?? null, avatarUrl: (await tx.profile.findUnique({ where: { userId: auth.user.id } }))?.avatarUrl ?? null,
        // Premium members' Spaces carry the verified badge from the start.
        ...(hasPremiumAccess(auth.user) ? { isVerified: true, verificationSource: 'PREMIUM' } : {}) } });
      if (!auth.user.roles.includes('CREATOR')) await tx.user.update({ where: { id: auth.user.id }, data: { roles: { set: [...auth.user.roles, 'CREATOR'] } } });
      return c;
    });
    await this.audit.record({ userId: auth.user.id, action: 'CHANNEL_CREATED', entityType: 'Channel', entityId: channel.id, req, details: { handle } });
    return { channel: publicChannel(channel) };
  }

  @Patch('mine')
  @RequireAuth()
  @ApiOperation({ summary: 'Update my channel' })
  async update(@CurrentAuth() auth: AuthContext, @Body() body: UpdateChannelDto, @Req() req: AppRequest) {
    const mine = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!mine) throw new NotFoundException('You do not have a channel yet.');
    const data: Record<string, string | null> = {};
    if (body.name !== undefined) { const v = body.name.trim(); if (!v) throw new BadRequestException('A channel name cannot be empty.'); data.name = v; }
    if (body.description !== undefined) data.description = body.description.trim() || null;
    if (body.country !== undefined) { if (body.country && !isCountryCode(body.country)) throw new BadRequestException('Choose a country from the list.'); data.country = body.country?.toUpperCase() ?? null; }
    if (body.defaultLanguage !== undefined) { if (body.defaultLanguage && !isLanguageCode(body.defaultLanguage)) throw new BadRequestException('Choose a language from the list.'); data.defaultLanguage = body.defaultLanguage?.toLowerCase() ?? null; }
    const channel = await this.prisma.channel.update({ where: { id: mine.id }, data });
    await this.audit.record({ userId: auth.user.id, action: 'CHANNEL_UPDATED', entityType: 'Channel', entityId: mine.id, req, details: { fields: Object.keys(data) } });
    return { channel: publicChannel(channel) };
  }

  @Get(':handle')
  @ApiOperation({ summary: 'A channel and its latest public videos' })
  async get(@Param('handle') raw: string, @CurrentAuth() auth: AuthContext | null) {
    const channel = await this.prisma.channel.findUnique({ where: { handle: normalizeHandle(raw) } });
    if (!channel) throw new NotFoundException('This channel does not exist.');
    const [videos, videoCount, following] = await Promise.all([
      this.prisma.video.findMany({ where: { channelId: channel.id, ...PUBLIC_VIDEO }, orderBy: { publishedAt: 'desc' }, take: 30, include: { channel: true } }),
      this.prisma.video.count({ where: { channelId: channel.id, ...PUBLIC_VIDEO } }),
      auth ? this.prisma.subscription.findUnique({ where: { userId_channelId: { userId: auth.user.id, channelId: channel.id } }, select: { id: true } }) : null,
    ]);
    return { channel: publicChannel(channel), videoCount, videos: videos.map((v) => videoCard(v, this.urls)), viewer: { following: !!following, isOwner: auth?.user.id === channel.userId } };
  }

  @Post(':handle/follow')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Follow a channel' })
  async follow(@Param('handle') raw: string, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`follow:${auth.user.id}`, 120, 3600);
    const channel = await this.prisma.channel.findUnique({ where: { handle: normalizeHandle(raw) } });
    if (!channel) throw new NotFoundException('This channel does not exist.');
    if (channel.userId === auth.user.id) throw new BadRequestException('You cannot follow your own channel.');
    const count = await this.prisma.$transaction(async (tx) => {
      const r = await tx.subscription.createMany({ data: [{ userId: auth.user.id, channelId: channel.id }], skipDuplicates: true });
      const c = r.count ? await tx.channel.update({ where: { id: channel.id }, data: { subscriberCount: { increment: 1 } } }) : channel;
      return c.subscriberCount;
    });
    return { following: true, followerCount: count };
  }

  @Delete(':handle/follow')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Stop following a channel' })
  async unfollow(@Param('handle') raw: string, @CurrentAuth() auth: AuthContext) {
    const channel = await this.prisma.channel.findUnique({ where: { handle: normalizeHandle(raw) } });
    if (!channel) throw new NotFoundException('This channel does not exist.');
    const count = await this.prisma.$transaction(async (tx) => {
      const r = await tx.subscription.deleteMany({ where: { userId: auth.user.id, channelId: channel.id } });
      const c = r.count ? await tx.channel.update({ where: { id: channel.id }, data: { subscriberCount: { decrement: 1 } } }) : channel;
      return c.subscriberCount;
    });
    return { following: false, followerCount: count };
  }
}
