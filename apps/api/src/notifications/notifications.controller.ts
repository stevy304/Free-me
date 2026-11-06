import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { MediaUrls } from '../videos/media-urls';

class ReadDto { @ApiPropertyOptional({ description: 'Mark these as read; none = all' }) @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) ids?: string[] }

/** Words for one notification, written for people. */
function sentence(type: string, actor: string, count: number, title: string) {
  const who = count > 1 ? `${actor} and ${count - 1} ${count === 2 ? 'other' : 'others'}` : actor;
  switch (type) {
    case 'NEW_VIDEO': return `${actor} posted a new video: ${title}`;
    case 'LIVE': return `${actor} is live: ${title}`;
    case 'COMMENT': return `${actor} joined the conversation on ${title}`;
    case 'REPLY': return `${actor} replied to you on ${title}`;
    default: return `${who} sparked ${title}`;
  }
}

@ApiTags('notifications')
@Controller('me/notifications')
@RequireAuth()
export class NotificationsController {
  constructor(private readonly prisma: PrismaService, private readonly urls: MediaUrls) {}

  @Get()
  @ApiOperation({ summary: 'My notifications, newest first (50 a page), with the unread count' })
  async list(@CurrentAuth() auth: AuthContext, @Query('cursor') cursor?: string) {
    const rows = await this.prisma.notification.findMany({
      where: { userId: auth.user.id, OR: [{ videoId: null }, { video: { takenDownAt: null } }] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { actor: { include: { profile: true, channel: true } }, video: true },
    });
    const liveIds = rows.map((n) => n.liveStreamId).filter((x): x is string => !!x);
    const lives = new Map((await this.prisma.liveStream.findMany({ where: { id: { in: liveIds } }, select: { id: true, title: true } })).map((l) => [l.id, l.title]));
    const items = await Promise.all(rows.slice(0, 50).map(async (n) => {
      const actor = n.actor ? { name: n.actor.channel?.name ?? n.actor.profile?.displayName ?? 'Someone', handle: n.actor.channel?.handle ?? null, avatarUrl: n.actor.channel?.avatarUrl ?? n.actor.profile?.avatarUrl ?? null } : { name: 'Someone', handle: null, avatarUrl: null };
      const title = n.liveStreamId ? `"${lives.get(n.liveStreamId) ?? 'live stream'}"` : n.video ? `"${n.video.title}"` : 'your video';
      const href = n.liveStreamId ? `/live/${n.liveStreamId}` : n.video ? `/watch?v=${n.video.id}${n.commentId ? `&c=${n.commentId}` : ''}` : '/';
      return {
        id: n.id, type: n.type, count: n.count, read: !!n.readAt, at: n.updatedAt, text: sentence(n.type, actor.name, n.count, title), href, actor,
        video: n.video ? { id: n.video.id, title: n.video.title, thumbnailUrl: await this.urls.thumb(n.video) } : null,
      };
    }));
    return { notifications: items, nextCursor: rows.length > 50 ? rows[49].id : null, unread: await this.unreadCount(auth.user.id) };
  }

  private unreadCount(userId: string) { return this.prisma.notification.count({ where: { userId, readAt: null, OR: [{ videoId: null }, { video: { takenDownAt: null } }] } }); }

  @Get('unread')
  @ApiOperation({ summary: 'How many are unread (for the bell; cheap to poll)' })
  async unread(@CurrentAuth() auth: AuthContext) { return { unread: await this.unreadCount(auth.user.id) }; }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark some, or all, as read' })
  async read(@CurrentAuth() auth: AuthContext, @Body() body: ReadDto) {
    await this.prisma.notification.updateMany({ where: { userId: auth.user.id, readAt: null, ...(body.ids?.length ? { id: { in: body.ids } } : {}) }, data: { readAt: new Date() } });
    return { unread: await this.unreadCount(auth.user.id) };
  }
}
