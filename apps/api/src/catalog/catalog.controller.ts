import { BadRequestException, Controller, Get, GoneException, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { publicChannel } from '../users/serialize';
import { PUBLIC_VIDEO, videoCard } from './serialize';
import { MediaUrls } from '../videos/media-urls';
import { hasPremiumAccess } from '../billing/billing';

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
  constructor(private readonly prisma: PrismaService, private readonly urls: MediaUrls) {}

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
    return { videos: items.map((v) => videoCard(v, this.urls)), nextCursor: more && last ? `${last.publishedAt!.toISOString()}_${last.id}` : null };
  }

  @Get('videos')
  @ApiOperation({ summary: 'Latest public videos (home feed), optionally in one category' })
  @ApiQuery({ name: 'category', required: false }) @ApiQuery({ name: 'cursor', required: false }) @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'moments', required: false, description: 'true = only Moments (short vertical videos), false = no Moments' })
  async videos(@Query('category') category?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string, @Query('moments') moments?: string) {
    const where: Prisma.VideoWhereInput = {
      ...(category ? { category: { slug: category } } : {}),
      ...(moments === 'true' ? { isShort: true } : moments === 'false' ? { isShort: false } : {}),
    };
    return this.page(where, cursor, limit);
  }

  @Get('videos/:id')
  @ApiOperation({ summary: 'One video for its watch page (public and unlisted when ready; private only for its owner), with the viewer\'s own state' })
  async video(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null) {
    const v = await this.prisma.video.findUnique({ where: { id }, include: { channel: true, category: true, captions: { select: { language: true, source: true }, orderBy: { language: 'asc' } } } });
    const owner = !!auth && v?.channel.userId === auth.user.id;
    if (v?.takenDownAt && !owner) {
      throw new GoneException(v.takedownReason === 'COPYRIGHT' ? 'This video is no longer available because of a copyright notice.' : 'This video was removed for breaking the Community Guidelines.');
    }
    if (!v || (!owner && (v.status !== 'READY' || v.visibility === 'PRIVATE'))) throw new NotFoundException('This video is not available.');
    if (v.reviewHoldAt && !owner) throw new NotFoundException('This video is being reviewed by our moderators.');
    const card = videoCard(v, this.urls);
    const fullQuality = owner || (!!auth && hasPremiumAccess(auth.user));
    const [reaction, history, following, saved] = auth ? await Promise.all([
      this.prisma.like.findUnique({ where: { userId_videoId: { userId: auth.user.id, videoId: id } }, select: { isLike: true } }),
      this.prisma.watchHistory.findUnique({ where: { userId_videoId: { userId: auth.user.id, videoId: id } }, select: { progressSeconds: true, completed: true } }),
      this.prisma.subscription.findUnique({ where: { userId_channelId: { userId: auth.user.id, channelId: v.channelId } }, select: { id: true } }),
      this.prisma.playlistItem.count({ where: { videoId: id, playlist: { userId: auth.user.id } } }),
    ]) : [null, null, null, 0];
    return {
      video: { ...card, thumbnailUrl: await this.urls.thumb(v), description: v.description, status: v.status, visibility: v.visibility, likeCount: v.likeCount, commentCount: v.commentCount,
        commentsOpen: v.commentsEnabled && !v.madeForKids, takenDownAt: v.takenDownAt,
        category: v.category ? { name: v.category.name, slug: v.category.slug } : null, playbackUrl: this.urls.playback(v, fullQuality),
        // Set when this viewer gets a limited playlist: the player can say that higher qualities come with Premium.
        qualityLimit: fullQuality ? null : this.urls.qualityLimit(v),
        processingStage: v.processingStage, width: v.width, height: v.height, madeForKids: v.madeForKids,
        storyboardUrl: v.storyboard && v.status === 'READY' ? `/api/videos/${v.id}/storyboard.vtt` : null,
        captions: v.captions.map((c) => ({ language: c.language, auto: c.source === 'AUTO', url: `/api/videos/${v.id}/captions/${c.language}.vtt` })),
        channel: { ...card.channel, followerCount: v.channel.subscriberCount } },
      viewer: {
        signedIn: !!auth, isOwner: owner, following: !!following, saved: saved > 0,
        reaction: reaction ? (reaction.isLike ? 'like' : 'dislike') : 'none',
        // Resume where the viewer stopped, unless they finished it or barely started.
        resumeAt: history && !history.completed && history.progressSeconds >= 10 ? history.progressSeconds : 0,
      },
    };
  }

  @Get('search')
  @ApiOperation({ summary: 'Search public videos (ranked by how well they match, typos forgiven) and channels' })
  async search(@Query('q') q = '', @Query('cursor') cursor?: string) {
    const term = q.trim().replace(/\s+/g, ' ').slice(0, 100);
    if (!term) return { query: '', channels: [], videos: [], nextCursor: null };
    const offset = cursor && /^o:\d{1,5}$/.test(cursor) ? Number(cursor.slice(2)) : 0;
    const take = 24;
    const words = term.toLowerCase().replace(/^@/, '').split(' ').filter(Boolean).slice(0, 8);
    const handle = term.replace(/^@/, '').toLowerCase();
    // One ranked query: whole words in the title count most, then the description, tags, the Space's name and a
    // close spelling of the title (pg_trgm, so "gorrilas" finds "Gorillas"); views only break ties.
    const [, rows, channels] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL pg_trgm.word_similarity_threshold = 0.4`,
      this.prisma.$queryRaw<{ id: string }[]>`
        WITH q AS (SELECT plainto_tsquery('simple', ${term}) AS tsq)
        SELECT v.id FROM "Video" v JOIN "Channel" c ON c.id = v."channelId", q
        WHERE v.status = 'READY' AND v.visibility = 'PUBLIC' AND v."mediaLocation" = 'PUBLIC' AND v."publishedAt" IS NOT NULL AND v."takenDownAt" IS NULL AND v."reviewHoldAt" IS NULL
          AND (
            to_tsvector('simple', v.title || ' ' || coalesce(v.description, '')) @@ q.tsq
            OR ${term} <% v.title
            OR ${term} <% c.name
            OR EXISTS (SELECT 1 FROM "VideoTag" vt JOIN "Tag" t ON t.id = vt."tagId" WHERE vt."videoId" = v.id AND t.name = ANY(${words}))
          )
        ORDER BY (
            ts_rank(to_tsvector('simple', v.title), q.tsq) * 4
          + ts_rank(to_tsvector('simple', coalesce(v.description, '')), q.tsq)
          + word_similarity(${term}, v.title) * 2
          + CASE WHEN EXISTS (SELECT 1 FROM "VideoTag" vt JOIN "Tag" t ON t.id = vt."tagId" WHERE vt."videoId" = v.id AND t.name = ANY(${words})) THEN 1.5 ELSE 0 END
          + CASE WHEN ${term} <% c.name THEN 1 ELSE 0 END
          + ln(v."viewCount"::float8 + 1) * 0.05
        ) DESC, v."publishedAt" DESC, v.id
        LIMIT ${take + 1} OFFSET ${offset}`,
      this.prisma.channel.findMany({
        where: { OR: [{ name: { contains: term, mode: 'insensitive' } }, { handle: { contains: handle } }] },
        orderBy: { subscriberCount: 'desc' }, take: offset ? 0 : 5, // Spaces only on the first page
      }),
    ]);
    const ids = rows.slice(0, take).map((r) => r.id);
    const found = await this.prisma.video.findMany({ where: { id: { in: ids } }, include: { channel: true } });
    const byId = new Map(found.map((v) => [v.id, v]));
    const videos = ids.map((id) => byId.get(id)).filter((v) => !!v).map((v) => videoCard(v, this.urls));
    return { query: term, channels: channels.map(publicChannel), videos, nextCursor: rows.length > take ? `o:${offset + take}` : null };
  }

  @Get('search/suggest')
  @ApiOperation({ summary: 'Search suggestions while typing (titles and channels)' })
  async suggest(@Query('q') q = '') {
    const term = q.trim().slice(0, 60);
    if (term.length < 2) return { suggestions: [] };
    const [videos, channels] = await Promise.all([
      this.prisma.video.findMany({ where: { ...PUBLIC_VIDEO, title: { contains: term, mode: 'insensitive' } }, orderBy: { viewCount: 'desc' }, take: 8, select: { title: true } }),
      this.prisma.channel.findMany({ where: { OR: [{ name: { contains: term, mode: 'insensitive' } }, { handle: { startsWith: term.replace(/^@/, '').toLowerCase() } }] }, orderBy: { subscriberCount: 'desc' }, take: 3, select: { name: true } }),
    ]);
    return { suggestions: [...new Set([...channels.map((c) => c.name), ...videos.map((v) => v.title)])].slice(0, 10) };
  }

  @Get('feed/following')
  @RequireAuth()
  @ApiOperation({ summary: 'Channels I follow and their latest public videos' })
  async following(@CurrentAuth() auth: AuthContext, @Query('cursor') cursor?: string) {
    const subs = await this.prisma.subscription.findMany({ where: { userId: auth.user.id }, include: { channel: true }, orderBy: { createdAt: 'desc' }, take: 500 });
    const page = subs.length ? await this.page({ channelId: { in: subs.map((s) => s.channelId) } }, cursor) : { videos: [], nextCursor: null };
    return { channels: subs.map((s) => publicChannel(s.channel)), ...page };
  }
}
