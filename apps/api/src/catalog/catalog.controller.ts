import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { publicChannel } from '../users/serialize';
import { PUBLIC_VIDEO, videoCard } from './serialize';

/** Keyset pagination cursor: "<publishedAt ISO>_<id>", stable while new videos arrive. */
function parseCursor(cursor?: string) {
  if (!cursor) return null;
  const i = cursor.lastIndexOf('_');
  const at = new Date(cursor.slice(0, i));
  if (i < 0 || Number.isNaN(at.getTime())) throw new BadRequestException('Invalid cursor.');
  return { at, id: cursor.slice(i + 1) };
}
const pageSize = (v?: string) => Math.min(48, Math.max(1, Number(v) || 24));

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('categories')
  @ApiOperation({ summary: 'Video categories' })
  async categories() {
    return { categories: await this.prisma.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }) };
  }

  private async page(where: Prisma.VideoWhereInput, cursor?: string, limit?: string) {
    const c = parseCursor(cursor);
    const take = pageSize(limit);
    const rows = await this.prisma.video.findMany({
      where: { AND: [where, PUBLIC_VIDEO, ...(c ? [{ OR: [{ publishedAt: { lt: c.at } }, { publishedAt: c.at, id: { lt: c.id } }] }] : [])] },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: take + 1, include: { channel: true },
    });
    const more = rows.length > take;
    const items = rows.slice(0, take);
    const last = items.at(-1);
    return { videos: items.map(videoCard), nextCursor: more && last ? `${last.publishedAt!.toISOString()}_${last.id}` : null };
  }

  @Get('videos')
  @ApiOperation({ summary: 'Latest public videos (home feed), optionally in one category' })
  @ApiQuery({ name: 'category', required: false }) @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'shorts', required: false, description: 'true = only Shorts, false = no Shorts' })
  async videos(@Query('category') category?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string, @Query('shorts') shorts?: string) {
    const where: Prisma.VideoWhereInput = {
      ...(category ? { category: { slug: category } } : {}),
      ...(shorts === 'true' ? { isShort: true } : shorts === 'false' ? { isShort: false } : {}),
    };
    return this.page(where, cursor, limit);
  }

  @Get('feed/subscriptions')
  @RequireAuth()
  @ApiOperation({ summary: 'Channels I subscribe to and their latest public videos' })
  async subscriptions(@CurrentAuth() auth: AuthContext, @Query('cursor') cursor?: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId: auth.user.id }, include: { channel: true }, orderBy: { createdAt: 'desc' }, take: 500 });
    const page = subs.length ? await this.page({ channelId: { in: subs.map((s) => s.channelId) } }, cursor) : { videos: [], nextCursor: null };
    return { channels: subs.map((s) => publicChannel(s.channel)), ...page };
  }
}
