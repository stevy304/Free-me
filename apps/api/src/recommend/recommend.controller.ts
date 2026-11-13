import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { CurrentAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { MediaUrls } from '../videos/media-urls';
import { PUBLIC_VIDEO, videoCard } from '../catalog/serialize';
import { FEED_SIZE, PAGE, forYouFeed, recordShown } from './for-you';

@ApiTags('catalog')
@Controller()
export class RecommendController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly urls: MediaUrls) {}

  @Get('feed/for-you')
  @ApiOperation({ summary: 'For you: ranked for this viewer (see ALGORITHM.md), 24 a page, each with why it is shown' })
  @ApiQuery({ name: 'page', required: false })
  async forYou(@CurrentAuth() auth: AuthContext | null, @Query('page') pageArg?: string) {
    const page = Math.max(0, Math.min(FEED_SIZE / PAGE - 1, Math.floor(Number(pageArg) || 0)));
    const ranked = await forYouFeed(this.prisma, this.redis.client, auth?.user.id ?? null);
    const slice = ranked.slice(page * PAGE, (page + 1) * PAGE);
    const seeds = [...new Set(slice.flatMap((r) => (r.reason.kind === 'related' ? [r.reason.videoId] : [])))];
    const topics = [...new Set(slice.flatMap((r) => (r.reason.kind === 'topic' ? [r.reason.categoryId] : [])))];
    // Checked again here: a video made private or removed since the ranking is never shown.
    const [videos, seedRows, categories] = await Promise.all([
      this.prisma.video.findMany({ where: { ...PUBLIC_VIDEO, id: { in: slice.map((r) => r.id) } }, include: { channel: true } }),
      seeds.length ? this.prisma.video.findMany({ where: { id: { in: seeds } }, select: { id: true, title: true } }) : [],
      topics.length ? this.prisma.category.findMany({ where: { id: { in: topics } }, select: { id: true, slug: true, name: true } }) : [],
    ]);
    const byId = new Map(videos.map((v) => [v.id, v]));
    const out = slice.flatMap((r) => {
      const v = byId.get(r.id);
      if (!v) return [];
      const why = r.reason;
      const reason = why.kind === 'related' ? { kind: why.kind, title: seedRows.find((s) => s.id === why.videoId)?.title ?? null }
        : why.kind === 'topic' ? { kind: why.kind, topic: categories.find((c) => c.id === why.categoryId) ?? null }
        : { kind: why.kind };
      return [{ ...videoCard(v, this.urls), reason }];
    });
    if (auth) await recordShown(this.redis.client, auth.user.id, out.map((v) => v.id));
    return { videos: out, page, nextPage: (page + 1) * PAGE < ranked.length ? page + 1 : null };
  }
}
