import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { notifySpark } from '../notifications/notify';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { videoCard } from '../catalog/serialize';
import { MediaUrls } from '../videos/media-urls';
import { dateCursor, parseDateCursor, watchable } from './access';

class ReactionDto { @ApiProperty({ enum: ['like', 'dislike', 'none'] }) @IsIn(['like', 'dislike', 'none']) value!: 'like' | 'dislike' | 'none' }
class ProgressDto {
  @ApiProperty({ description: 'Playback position in seconds' }) @IsNumber() @Min(0) @Max(86_400) seconds!: number;
  @ApiProperty({ required: false, description: 'True when playback reached the end' }) @IsOptional() @IsBoolean() ended?: boolean;
}

/** Likes (dislikes are private, shown only to the creator), watch history and resume position. */
@ApiTags('engagement')
@Controller()
export class ReactionsController {
  constructor(private readonly prisma: PrismaService, private readonly limits: RateLimitService, private readonly urls: MediaUrls) {}

  @Put('videos/:id/reaction')
  @RequireAuth()
  @ApiOperation({ summary: 'Like, dislike or clear my reaction; counts stay exact under concurrent taps' })
  async react(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReactionDto, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`react:${auth.user.id}`, 300, 3600);
    await watchable(this.prisma, id, auth);
    const userId = auth.user.id;
    const counts = await this.prisma.$transaction(async (tx) => {
      // Each count change matches a row that this request really removed or inserted, so racing requests cannot drift.
      const removed = await tx.$queryRaw<Array<{ isLike: boolean }>>`DELETE FROM "Like" WHERE "userId" = ${userId} AND "videoId" = ${id} RETURNING "isLike"`;
      const inserted = body.value === 'none' ? [] : await tx.$queryRaw<Array<{ isLike: boolean }>>`
        INSERT INTO "Like" ("id", "userId", "videoId", "isLike", "createdAt") VALUES (gen_random_uuid(), ${userId}, ${id}, ${body.value === 'like'}, now())
        ON CONFLICT ("userId", "videoId") DO NOTHING RETURNING "isLike"`;
      const delta = (rows: Array<{ isLike: boolean }>, like: boolean) => rows.filter((r) => r.isLike === like).length;
      const likes = delta(inserted, true) - delta(removed, true);
      const dislikes = delta(inserted, false) - delta(removed, false);
      return { ...(await tx.video.update({ where: { id }, data: { likeCount: { increment: likes }, dislikeCount: { increment: dislikes } }, select: { likeCount: true } })), sparked: likes > 0 };
    });
    if (counts.sparked) await notifySpark(this.prisma, id, userId);
    return { reaction: body.value, likeCount: counts.likeCount };
  }

  @Post('videos/:id/progress')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Remember where I am in a video (adds it to my history)' })
  async progress(@Param('id', ParseUUIDPipe) id: string, @Body() body: ProgressDto, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`progress:${auth.user.id}`, 1200, 3600);
    const v = await watchable(this.prisma, id, auth);
    const seconds = Math.min(Math.floor(body.seconds), v.durationSeconds || Math.floor(body.seconds));
    const completed = !!body.ended || (v.durationSeconds > 0 && seconds >= Math.max(v.durationSeconds - 10, v.durationSeconds * 0.95));
    await this.prisma.watchHistory.upsert({
      where: { userId_videoId: { userId: auth.user.id, videoId: id } },
      create: { userId: auth.user.id, videoId: id, progressSeconds: seconds, completed },
      update: { progressSeconds: seconds, completed, lastWatchedAt: new Date() },
    });
    return { saved: true, completed };
  }

  @Get('me/history')
  @RequireAuth()
  @ApiOperation({ summary: 'Videos I watched, most recent first, with how far I got' })
  async history(@CurrentAuth() auth: AuthContext, @Query('cursor') cursor?: string) {
    const c = parseDateCursor(cursor);
    const rows = await this.prisma.watchHistory.findMany({
      where: {
        userId: auth.user.id,
        video: { status: 'READY', takenDownAt: null, OR: [{ visibility: { in: ['PUBLIC', 'UNLISTED'] } }, { channel: { userId: auth.user.id } }] },
        ...(c ? { OR: [{ lastWatchedAt: { lt: c.at } }, { lastWatchedAt: c.at, id: { lt: c.id } }] } : {}),
      },
      orderBy: [{ lastWatchedAt: 'desc' }, { id: 'desc' }], take: 31, include: { video: { include: { channel: true } } },
    });
    const items = rows.slice(0, 30);
    const last = items.at(-1);
    return {
      items: items.map((h) => ({ watchedAt: h.lastWatchedAt, progressSeconds: h.progressSeconds, completed: h.completed, video: videoCard(h.video, this.urls) })),
      nextCursor: rows.length > 30 && last ? dateCursor(last.lastWatchedAt, last.id) : null,
    };
  }

  @Delete('me/history/:videoId')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Remove one video from my history' })
  async forget(@Param('videoId', ParseUUIDPipe) videoId: string, @CurrentAuth() auth: AuthContext) {
    const r = await this.prisma.watchHistory.deleteMany({ where: { userId: auth.user.id, videoId } });
    return { removed: r.count };
  }

  @Delete('me/history')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Clear my whole watch history' })
  async clear(@CurrentAuth() auth: AuthContext) {
    const r = await this.prisma.watchHistory.deleteMany({ where: { userId: auth.user.id } });
    return { removed: r.count };
  }
}
