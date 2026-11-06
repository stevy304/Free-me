import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { MediaUrls } from './media-urls';

const PERIODS = [7, 28, 90, 365];
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The last `days` days (UTC) ending today, oldest first. */
function window(days: number) {
  const end = new Date(`${iso(new Date())}T00:00:00Z`);
  const start = new Date(end.getTime() - (days - 1) * DAY);
  return { start, prevStart: new Date(start.getTime() - days * DAY), list: Array.from({ length: days }, (_, i) => iso(new Date(start.getTime() + i * DAY))) };
}

/** Creator Hub stats: how the Space and each video are doing, from the daily view counts and follows. */
@ApiTags('creator hub')
@Controller('hub')
@RequireAuth('CREATOR')
export class StatsController {
  constructor(private readonly prisma: PrismaService, private readonly urls: MediaUrls) {}

  private period(days?: string) {
    const d = Number(days ?? 28);
    if (!PERIODS.includes(d)) throw new BadRequestException(`Choose a period of ${PERIODS.join(', ')} days.`);
    return d;
  }

  @Get('stats')
  @ApiOperation({ summary: 'My Space over a period (7, 28, 90 or 365 days): views, watch time and new followers per day, totals with the previous period, top videos' })
  @ApiQuery({ name: 'days', required: false })
  async overview(@CurrentAuth() auth: AuthContext, @Query('days') daysQ?: string) {
    const days = this.period(daysQ);
    const channel = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!channel) throw new NotFoundException('Create your Space first.');
    const { start, prevStart, list } = window(days);
    const [daily, prev, follows, prevFollows, top] = await Promise.all([
      this.prisma.$queryRaw<Array<{ day: Date; views: bigint; watch: bigint }>>`
        SELECT s."day", SUM(s."views")::bigint AS views, SUM(s."watchSeconds")::bigint AS watch FROM "VideoDailyStat" s JOIN "Video" v ON v."id" = s."videoId"
        WHERE v."channelId" = ${channel.id} AND s."day" >= ${start} GROUP BY s."day"`,
      this.prisma.$queryRaw<Array<{ views: bigint | null; watch: bigint | null }>>`
        SELECT SUM(s."views")::bigint AS views, SUM(s."watchSeconds")::bigint AS watch FROM "VideoDailyStat" s JOIN "Video" v ON v."id" = s."videoId"
        WHERE v."channelId" = ${channel.id} AND s."day" >= ${prevStart} AND s."day" < ${start}`,
      this.prisma.$queryRaw<Array<{ day: Date; n: bigint }>>`
        SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::bigint AS n FROM "Subscription" WHERE "channelId" = ${channel.id} AND "createdAt" >= ${start} GROUP BY 1`,
      this.prisma.subscription.count({ where: { channelId: channel.id, createdAt: { gte: prevStart, lt: start } } }),
      this.prisma.$queryRaw<Array<{ videoId: string; views: bigint; watch: bigint }>>`
        SELECT s."videoId", SUM(s."views")::bigint AS views, SUM(s."watchSeconds")::bigint AS watch FROM "VideoDailyStat" s JOIN "Video" v ON v."id" = s."videoId"
        WHERE v."channelId" = ${channel.id} AND s."day" >= ${start} GROUP BY s."videoId" ORDER BY views DESC, watch DESC LIMIT 10`,
    ]);
    const byDay = new Map(daily.map((d) => [iso(d.day), d]));
    const followsByDay = new Map(follows.map((f) => [iso(f.day), Number(f.n)]));
    const series = list.map((day) => ({ day, views: Number(byDay.get(day)?.views ?? 0), watchSeconds: Number(byDay.get(day)?.watch ?? 0), newFollowers: followsByDay.get(day) ?? 0 }));
    const sum = (k: 'views' | 'watchSeconds' | 'newFollowers') => series.reduce((a, d) => a + d[k], 0);
    const videos = top.length ? await this.prisma.video.findMany({ where: { id: { in: top.map((t) => t.videoId) } } }) : [];
    const vById = new Map(videos.map((v) => [v.id, v]));
    return {
      days, from: list[0], to: list.at(-1),
      totals: {
        views: sum('views'), watchSeconds: sum('watchSeconds'), newFollowers: sum('newFollowers'), followers: channel.subscriberCount,
        previous: { views: Number(prev[0]?.views ?? 0), watchSeconds: Number(prev[0]?.watch ?? 0), newFollowers: prevFollows },
      },
      series,
      topVideos: await Promise.all(top.filter((t) => vById.has(t.videoId)).map(async (t) => {
        const v = vById.get(t.videoId)!;
        const views = Number(t.views);
        return { id: v.id, title: v.title, thumbnailUrl: await this.urls.thumb(v), durationSeconds: v.durationSeconds, views, watchSeconds: Number(t.watch), averageViewSeconds: views ? Math.round(Number(t.watch) / views) : 0 };
      })),
    };
  }

  @Get('videos/:id/stats')
  @ApiOperation({ summary: 'One of my videos: views and watch time per day, lifetime totals, and how far signed-in viewers watch (retention)' })
  @ApiQuery({ name: 'days', required: false })
  async video(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('days') daysQ?: string) {
    const days = this.period(daysQ);
    const v = await this.prisma.video.findFirst({ where: { id, channel: { userId: auth.user.id } } });
    if (!v) throw new NotFoundException('Video not found.');
    const { start, list } = window(days);
    const [rows, retention] = await Promise.all([
      this.prisma.videoDailyStat.findMany({ where: { videoId: id, day: { gte: start } } }),
      // Share of signed-in viewers still watching at each 5% of the video (from where each one got to).
      v.durationSeconds > 0 ? this.prisma.$queryRaw<Array<{ b: number; n: bigint; total: bigint }>>`
        SELECT b::int AS b, COUNT(*) FILTER (WHERE h."completed" OR h."progressSeconds" >= b * ${v.durationSeconds}::float / 20)::bigint AS n, COUNT(*)::bigint AS total
        FROM generate_series(0, 20) b CROSS JOIN "WatchHistory" h WHERE h."videoId" = ${id} GROUP BY b ORDER BY b` : Promise.resolve([]),
    ]);
    const byDay = new Map(rows.map((r) => [iso(r.day), r]));
    const series = list.map((day) => ({ day, views: byDay.get(day)?.views ?? 0, watchSeconds: Number(byDay.get(day)?.watchSeconds ?? 0n) }));
    const viewers = Number(retention[0]?.total ?? 0);
    const viewCount = Number(v.viewCount);
    return {
      days, from: list[0], to: list.at(-1),
      video: { id: v.id, title: v.title, durationSeconds: v.durationSeconds, publishedAt: v.publishedAt },
      lifetime: { views: viewCount, watchSeconds: Number(v.watchTimeSeconds), likes: v.likeCount, comments: v.commentCount, averageViewSeconds: viewCount ? Math.round(Number(v.watchTimeSeconds) / viewCount) : 0 },
      period: { views: series.reduce((a, d) => a + d.views, 0), watchSeconds: series.reduce((a, d) => a + d.watchSeconds, 0) },
      series,
      // Too few viewers make a misleading curve: shown from 5 signed-in viewers.
      retention: viewers >= 5 ? { viewers, points: retention.map((r) => ({ at: r.b * 5, percent: Math.round((Number(r.n) / viewers) * 1000) / 10 })) } : { viewers, points: null },
    };
  }
}
