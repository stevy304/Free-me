import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Channel, Video } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { MediaUrls } from '../videos/media-urls';
import { PUBLIC_VIDEO, videoCard } from './serialize';
import { RedisService } from '../database/redis.service';
import { related } from '../recommend/related';

type Candidate = Video & { channel: Channel; tags: { tagId: string }[] };

const DAY = 86_400_000;

/**
 * Scores one candidate for "what to watch after this one". Pure, so it can be tested on its own.
 * Relevance first (same Space, shared tags, same topic, watched by the same people), then what the viewer likes,
 * then popularity and freshness; anything the viewer already finished sinks to the bottom.
 */
export function scoreNext(c: Candidate, ctx: { current: Video; tagIds: Set<string>; interests: Set<string>; finished: Set<string>; started: Set<string>; now: number; coWatch?: Map<string, number> }) {
  let s = 0;
  // Watched by at least 3 of the same people: 3 → +2, 7 → +3, 15 or more → +4; plus up to +3 for the share of this
  // video's audience that did (the latest 500 signed-in viewers are compared): when most viewers go on to it, that says
  // more than a shared Space or topic does.
  const together = ctx.coWatch?.get(c.id) ?? 0;
  if (together) {
    const audience = Math.max(together, Math.min(500, Number(ctx.current.viewCount)));
    s += Math.min(4, Math.log2(together + 1)) + 3 * Math.min(1, together / audience);
  }
  if (c.channelId === ctx.current.channelId) s += 3;
  const shared = c.tags.filter((t) => ctx.tagIds.has(t.tagId)).length;
  s += Math.min(3, shared) * 2;
  if (c.categoryId && c.categoryId === ctx.current.categoryId) s += 2;
  if (c.categoryId && ctx.interests.has(c.categoryId)) s += 1;
  if (c.language && ctx.current.language && c.language === ctx.current.language) s += 0.5;
  s += Math.log10(Number(c.viewCount) + 1) * 0.25; // popularity only breaks ties: 1M views adds 1.5
  s += Math.log10(c.likeCount + 1) * 0.3;
  const ageDays = c.publishedAt ? (ctx.now - c.publishedAt.getTime()) / DAY : 365;
  s += ageDays < 7 ? 1 : ageDays < 30 ? 0.5 : 0;
  if (ctx.finished.has(c.id)) s -= 6;
  else if (ctx.started.has(c.id)) s -= 1;
  return s;
}

/** Orders scored candidates, keeping a mix: at most 2 from the same Space in a row of 4, so "Next" is not one channel's list. */
export function arrangeNext<T extends { id: string; channelId: string; score: number }>(scored: T[], limit: number): T[] {
  const rest = [...scored].sort((a, b) => b.score - a.score);
  const out: T[] = [];
  while (out.length < limit && rest.length) {
    const window = out.slice(-3);
    const i = rest.findIndex((c) => window.filter((w) => w.channelId === c.channelId).length < 2);
    out.push(rest.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
}

@ApiTags('catalog')
@Controller()
export class NextController {
  constructor(private readonly prisma: PrismaService, private readonly urls: MediaUrls, private readonly redis: RedisService) {}

  @Get('videos/:id/next')
  @ApiOperation({ summary: 'What to watch after this video: same Space, shared tags and topic, the viewer\'s interests; finished videos last' })
  @ApiQuery({ name: 'limit', required: false })
  async next(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null, @Query('limit') limit?: string) {
    const take = Math.min(40, Math.max(1, Number(limit) || 20));
    const current = await this.prisma.video.findUnique({ where: { id } });
    const base = { ...PUBLIC_VIDEO, isShort: false, id: { not: id } };
    const include = { channel: true, tags: { select: { tagId: true } } } as const;
    if (!current) {
      const latest = await this.prisma.video.findMany({ where: base, orderBy: { publishedAt: 'desc' }, take, include });
      return { videos: latest.map((v) => videoCard(v, this.urls)) };
    }
    const [tagIds, coWatch] = await Promise.all([
      this.prisma.videoTag.findMany({ where: { videoId: id }, select: { tagId: true } }).then((rows) => rows.map((t) => t.tagId)),
      // Prepared by the worker for popular videos, else computed once and kept (recommend/related.ts).
      related(this.prisma, this.redis.client, id),
    ]);
    // A few small, indexed queries instead of scoring the whole catalogue.
    const pools = await Promise.all([
      this.prisma.video.findMany({ where: { ...base, channelId: current.channelId }, orderBy: { publishedAt: 'desc' }, take: 10, include }),
      tagIds.length ? this.prisma.video.findMany({ where: { ...base, tags: { some: { tagId: { in: tagIds } } } }, orderBy: { viewCount: 'desc' }, take: 40, include }) : [],
      current.categoryId ? this.prisma.video.findMany({ where: { ...base, categoryId: current.categoryId }, orderBy: { viewCount: 'desc' }, take: 30, include }) : [],
      this.prisma.video.findMany({ where: { ...base, publishedAt: { gte: new Date(Date.now() - 30 * DAY) } }, orderBy: { viewCount: 'desc' }, take: 20, include }),
      this.prisma.video.findMany({ where: base, orderBy: { publishedAt: 'desc' }, take: 20, include }),
      coWatch.size ? this.prisma.video.findMany({ where: { ...base, id: { in: [...coWatch.keys()] } }, include }) : [],
    ]);
    const byId = new Map<string, Candidate>();
    for (const v of pools.flat()) byId.set(v.id, v);
    const candidates = [...byId.values()];

    const [interests, history] = auth ? await Promise.all([
      this.prisma.userInterest.findMany({ where: { userId: auth.user.id }, select: { categoryId: true } }),
      this.prisma.watchHistory.findMany({ where: { userId: auth.user.id, videoId: { in: candidates.map((c) => c.id) } }, select: { videoId: true, completed: true } }),
    ]) : [[], []];
    const ctx = {
      current, tagIds: new Set(tagIds), coWatch, interests: new Set(interests.map((i) => i.categoryId)), now: Date.now(),
      finished: new Set(history.filter((h) => h.completed).map((h) => h.videoId)), started: new Set(history.filter((h) => !h.completed).map((h) => h.videoId)),
    };
    const ordered = arrangeNext(candidates.map((c) => Object.assign(c, { score: scoreNext(c, ctx) })), take);
    return { videos: ordered.map((v) => videoCard(v, this.urls)) };
  }
}
