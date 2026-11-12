import { BadRequestException, Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { MediaUrls } from '../videos/media-urls';
import { PUBLIC_VIDEO, videoCard } from './serialize';
import { trendingVideos } from './trending';

class InterestsDto { @ApiProperty({ example: ['travel-events', 'howto-style'] }) @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) categories!: string[] }

const SHELVES = 6;
const PER_SHELF = 8;

/**
 * The "For you" home. Built only from what is transparent to the viewer: the topics they picked, the creators
 * they tune in to, what is trending (everyone's views, counted together) and recency. No ranking by the viewer's
 * own watching.
 */
@ApiTags('catalog')
@Controller()
export class HomeController {
  constructor(private readonly prisma: PrismaService, private readonly urls: MediaUrls, private readonly redis: RedisService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('me/interests')
  @RequireAuth()
  @ApiOperation({ summary: 'Topics I picked for my home' })
  async interests(@CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.userInterest.findMany({ where: { userId: auth.user.id }, include: { category: true }, orderBy: { createdAt: 'asc' } });
    return { categories: rows.map((r) => r.category.slug) };
  }

  @Put('me/interests')
  @RequireAuth()
  @ApiOperation({ summary: 'Replace the topics I picked (up to 12)' })
  async setInterests(@CurrentAuth() auth: AuthContext, @Body() body: InterestsDto) {
    const slugs = [...new Set(body.categories)];
    const cats = await this.prisma.category.findMany({ where: { slug: { in: slugs } } });
    if (cats.length !== slugs.length) throw new BadRequestException('Choose topics from the list.');
    await this.prisma.$transaction([
      this.prisma.userInterest.deleteMany({ where: { userId: auth.user.id } }),
      this.prisma.userInterest.createMany({ data: slugs.map((s) => ({ userId: auth.user.id, categoryId: cats.find((c) => c.slug === s)!.id })) }),
    ]);
    return { categories: slugs };
  }

  @Get('feed/home')
  @ApiOperation({ summary: 'For you: spotlight, topic shelves, Moments and new videos from creators I tune in to' })
  async home(@CurrentAuth() auth: AuthContext | null) {
    // What is the same for everyone (topic shelves, Moments, newest, trending) is computed once a minute and shared
    // by every visitor (FEED_CACHE_SECONDS); only the viewer's own parts are read for each request.
    const ttl = this.config.feedCacheSeconds;
    const card = (v: Parameters<typeof videoCard>[0]) => videoCard(v, this.urls);
    const [categories, picked, follows, profile, unfinished] = await Promise.all([
      this.redis.cached('home:categories', 300, () => this.prisma.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, slug: true, name: true } })),
      auth ? this.prisma.userInterest.findMany({ where: { userId: auth.user.id }, select: { categoryId: true }, orderBy: { createdAt: 'asc' } }) : [],
      auth ? this.prisma.subscription.findMany({ where: { userId: auth.user.id }, select: { channelId: true }, take: 500 }) : [],
      auth ? this.prisma.profile.findUnique({ where: { userId: auth.user.id }, select: { country: true } }) : null,
      auth ? this.prisma.watchHistory.findMany({
        where: { userId: auth.user.id, completed: false, progressSeconds: { gte: 10 }, video: { ...PUBLIC_VIDEO, isShort: false } },
        orderBy: [{ lastWatchedAt: 'desc' }, { id: 'desc' }], take: 12, include: { video: { include: { channel: true } } },
      }) : [],
    ]);
    const pickedIds = picked.map((p) => p.categoryId);

    // Topics to show: the picked ones first, then the busiest topics this month so a new visitor still sees something.
    const busy = await this.redis.cached('home:busy', ttl, async () => {
      const since = new Date(Date.now() - 30 * 86_400_000);
      const rows = await this.prisma.video.groupBy({ by: ['categoryId'], where: { ...PUBLIC_VIDEO, isShort: false, categoryId: { not: null }, publishedAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { categoryId: 'desc' } }, take: 20 });
      return rows.map((b) => b.categoryId!);
    });
    const order = [...pickedIds, ...busy.filter((id) => !pickedIds.includes(id))];
    const shelfFor = (id: string) => this.redis.cached(`home:shelf:${id}`, ttl, async () =>
      (await this.prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: false, categoryId: id }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: PER_SHELF, include: { channel: true } })).map(card));

    // Spotlight: the most watched video of the last week in the viewer's topics (any topic for visitors), else the newest.
    const spotlightFor = (ids: string[]) => this.redis.cached(`home:spot:${[...ids].sort().join(',')}`, ttl, async () => {
      const week = new Date(Date.now() - 7 * 86_400_000);
      const topicFilter = ids.length ? { categoryId: { in: ids } } : {};
      const spot = await this.prisma.video.findFirst({ where: { ...PUBLIC_VIDEO, isShort: false, ...topicFilter, publishedAt: { gte: week } }, orderBy: [{ viewCount: 'desc' }, { publishedAt: 'desc' }], include: { channel: true, category: true } })
        ?? await this.prisma.video.findFirst({ where: { ...PUBLIC_VIDEO, isShort: false }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], include: { channel: true, category: true } });
      return spot ? { ...card(spot), category: spot.category ? { slug: spot.category.slug, name: spot.category.name } : null, channelFollowers: spot.channel.subscriberCount } : null;
    });
    // Trending: from creators in the viewer's country when there are enough of them, else everywhere.
    const trendingIn = (country: string | null) => this.redis.cached(`home:trending:${country ?? 'all'}`, ttl, async () =>
      (await trendingVideos(this.prisma, { country, take: 8 })).map(card));
    const country = profile?.country ?? null;

    const [shelfRows, spotlight, near, everywhere, moments, latest, fromCreators] = await Promise.all([
      Promise.all(order.slice(0, SHELVES + 4).map(async (id) => ({ id, videos: await shelfFor(id) }))),
      spotlightFor(pickedIds),
      country ? trendingIn(country) : Promise.resolve([]),
      trendingIn(null),
      this.redis.cached('home:moments', ttl, async () => (await this.prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: true }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: 12, include: { channel: true } })).map(card)),
      this.redis.cached('home:latest', ttl, async () => (await this.prisma.video.findMany({ where: { ...PUBLIC_VIDEO, isShort: false }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: 12, include: { channel: true } })).map(card)),
      follows.length ? this.prisma.video.findMany({ where: { ...PUBLIC_VIDEO, channelId: { in: follows.map((f) => f.channelId) } }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }], take: 6, include: { channel: true } }) : [],
    ]);
    const shelves = shelfRows.filter((r) => r.videos.length).slice(0, SHELVES).flatMap((r) => {
      const c = categories.find((x) => x.id === r.id);
      return c ? [{ category: { slug: c.slug, name: c.name }, reason: pickedIds.includes(r.id) ? 'picked' as const : 'popular' as const, videos: r.videos }] : [];
    });
    const trending = near.length >= 4 ? { country, videos: near } : { country: null, videos: everywhere };

    return {
      spotlight,
      interests: categories.map((c) => ({ slug: c.slug, name: c.name, picked: pickedIds.includes(c.id) })),
      hasPicked: pickedIds.length > 0,
      shelves,
      continueWatching: unfinished
        .filter((h) => h.progressSeconds < h.video.durationSeconds - 5)
        .slice(0, 4)
        .map((h) => ({ video: card(h.video), progressSeconds: h.progressSeconds })),
      fromCreators: fromCreators.map(card),
      trending,
      moments,
      latest: latest.filter((v) => v.id !== spotlight?.id),
    };
  }

  @Get('feed/rising')
  @ApiOperation({ summary: 'Rising: public videos of the last 30 days with the most views in the last two days; ?country=RW for local creators' })
  @ApiQuery({ name: 'country', required: false })
  async rising(@Query('country') country?: string) {
    const c = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null;
    return { videos: await this.redis.cached(`rising:${c ?? 'all'}`, this.config.feedCacheSeconds, async () => (await trendingVideos(this.prisma, { country: c, take: 24 })).map((v) => videoCard(v, this.urls))) };
  }
}
