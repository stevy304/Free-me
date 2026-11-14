import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { PrismaService } from '../database/prisma.service';
import { MediaUrls } from '../videos/media-urls';
import { badgeOf, PUBLIC_VIDEO, videoCard } from './serialize';

class SeriesDto { @IsString() @MinLength(1) @MaxLength(80) title!: string }
const MAX_SERIES = 200;

/**
 * Series: Moments told in parts (episodes). A creator makes a series in Creator Hub and puts Moments in it with an
 * episode number (Creator Hub → a video's details); the Moments feed shows "Episode 2 of 5" and lists the others.
 */
@ApiTags('series')
@Controller()
export class SeriesController {
  constructor(private readonly prisma: PrismaService, private readonly urls: MediaUrls) {}

  @Get('series/:id')
  @ApiOperation({ summary: 'A series and its published episodes, in order' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const s = await this.prisma.series.findUnique({ where: { id }, include: { channel: true } });
    if (!s) throw new NotFoundException('This series is not available.');
    const episodes = await this.prisma.video.findMany({ where: { seriesId: id, ...PUBLIC_VIDEO }, include: { channel: true }, orderBy: [{ episodeNumber: 'asc' }, { publishedAt: 'asc' }], take: 500 });
    return {
      series: { id: s.id, title: s.title, channel: { handle: s.channel.handle, name: s.channel.name, avatarUrl: s.channel.avatarUrl, badge: badgeOf(s.channel) } },
      episodes: episodes.map((v, i) => ({ ...videoCard(v, this.urls), episode: v.episodeNumber ?? i + 1 })),
    };
  }

  private async myChannel(auth: AuthContext) {
    const ch = await this.prisma.channel.findUnique({ where: { userId: auth.user.id }, select: { id: true } });
    if (!ch) throw new NotFoundException('Create your Space first.');
    return ch.id;
  }
  private async mine(auth: AuthContext, id: string) {
    const s = await this.prisma.series.findFirst({ where: { id, channel: { userId: auth.user.id } } });
    if (!s) throw new NotFoundException('Series not found.');
    return s;
  }

  @Get('hub/series')
  @RequireAuth('CREATOR')
  @ApiOperation({ summary: 'My series, newest first, with how many episodes each has' })
  async list(@CurrentAuth() auth: AuthContext) {
    const channelId = await this.myChannel(auth);
    const rows = await this.prisma.series.findMany({ where: { channelId }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { videos: true } } } });
    return { series: rows.map((s) => ({ id: s.id, title: s.title, episodes: s._count.videos, createdAt: s.createdAt })) };
  }

  @Post('hub/series')
  @RequireAuth('CREATOR')
  @ApiOperation({ summary: 'Start a series' })
  async create(@CurrentAuth() auth: AuthContext, @Body() body: SeriesDto) {
    const channelId = await this.myChannel(auth);
    if ((await this.prisma.series.count({ where: { channelId } })) >= MAX_SERIES) throw new BadRequestException(`A Space can have up to ${MAX_SERIES} series.`);
    const s = await this.prisma.series.create({ data: { channelId, title: body.title.trim() } });
    return { series: { id: s.id, title: s.title, episodes: 0, createdAt: s.createdAt } };
  }

  @Patch('hub/series/:id')
  @RequireAuth('CREATOR')
  @ApiOperation({ summary: 'Rename a series' })
  async rename(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SeriesDto) {
    await this.mine(auth, id);
    const s = await this.prisma.series.update({ where: { id }, data: { title: body.title.trim() } });
    return { series: { id: s.id, title: s.title } };
  }

  @Delete('hub/series/:id')
  @RequireAuth('CREATOR')
  @ApiOperation({ summary: 'Delete a series (its Moments stay, no longer as episodes)' })
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.mine(auth, id);
    await this.prisma.$transaction([
      this.prisma.video.updateMany({ where: { seriesId: id }, data: { seriesId: null, episodeNumber: null } }),
      this.prisma.series.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }
}
