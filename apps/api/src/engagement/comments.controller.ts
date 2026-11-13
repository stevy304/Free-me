import { Inject, BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { checkText, refusal } from '../safety/check';
import { badgeOf } from '../catalog/serialize';
import { notifyComment } from '../notifications/notify';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Channel, Comment, Profile, User } from '@prisma/client';
import { COMMENT_MAX } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { dateCursor, parseDateCursor, watchable } from './access';
import { publish, room } from '../realtime/publish';

class NewCommentDto {
  @ApiProperty() @IsString() @MaxLength(COMMENT_MAX) content!: string;
  @ApiPropertyOptional({ description: 'Reply to this comment' }) @IsOptional() @IsUUID() parentId?: string;
}
class EditCommentDto { @ApiProperty() @IsString() @MaxLength(COMMENT_MAX) content!: string }

type Row = Comment & { user: User & { profile: Profile | null; channel: Channel | null } };
const AUTHOR = { user: { include: { profile: true, channel: true } } } as const;

const clean = (text: string) => {
  const t = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) throw new BadRequestException('Write something first.');
  return t;
};
const isModerator = (auth: AuthContext | null) => !!auth && auth.user.roles.some((r) => r === 'ADMIN' || r === 'MODERATOR');

/** Comments and replies (one level, like most video sites), pinning by the creator, removal by author, creator or moderators. */
@ApiTags('comments')
@Controller()
export class CommentsController {
  constructor(private readonly prisma: PrismaService, private readonly limits: RateLimitService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private view(c: Row, video: { channelId: string; channel: { userId: string } }, auth: AuthContext | null) {
    const deleted = !!c.deletedAt;
    const ch = c.user.channel;
    const mine = auth?.user.id === c.userId;
    const owner = auth?.user.id === video.channel.userId;
    return {
      id: c.id, parentId: c.parentId, content: deleted ? '' : c.content, deleted, isPinned: c.isPinned, replyCount: c.replyCount,
      createdAt: c.createdAt, editedAt: c.editedAt,
      author: deleted ? null : {
        name: ch?.name ?? c.user.profile?.displayName ?? 'Free Me member', handle: ch?.handle ?? null,
        avatarUrl: ch?.avatarUrl ?? c.user.profile?.avatarUrl ?? null, isCreator: ch?.id === video.channelId, isVerified: !!ch?.isVerified, badge: ch ? badgeOf(ch) : null,
      },
      can: { edit: mine && !deleted, delete: !deleted && (mine || owner || isModerator(auth)), pin: owner && !c.parentId && !deleted },
    };
  }

  private async comment(id: string) {
    const c = await this.prisma.comment.findUnique({ where: { id }, include: { video: { include: { channel: { select: { userId: true } } } } } });
    if (!c) throw new NotFoundException('This comment no longer exists.');
    return c;
  }

  @Get('videos/:id/comments')
  @ApiOperation({ summary: 'Comments on a video: the pinned one first, then newest (or oldest) first' })
  async list(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null, @Query('sort') sort?: string, @Query('cursor') cursor?: string) {
    const v = await watchable(this.prisma, id, auth);
    const open = v.commentsEnabled && !v.madeForKids;
    if (!open) return { open, closedReason: v.madeForKids ? 'Comments are turned off for videos made for kids.' : 'Comments are turned off.', count: 0, comments: [], nextCursor: null };
    const oldest = sort === 'oldest';
    const c = parseDateCursor(cursor);
    const page = await this.prisma.comment.findMany({
      where: {
        videoId: id, parentId: null, isPinned: false, OR: [{ deletedAt: null }, { replyCount: { gt: 0 } }],
        ...(c ? (oldest ? { AND: [{ OR: [{ createdAt: { gt: c.at } }, { createdAt: c.at, id: { gt: c.id } }] }] } : { AND: [{ OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] }] }) : {}),
      },
      orderBy: oldest ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, include: AUTHOR,
    });
    const pinned = c ? [] : await this.prisma.comment.findMany({ where: { videoId: id, parentId: null, isPinned: true, deletedAt: null }, include: AUTHOR, take: 1 });
    const items = page.slice(0, 20);
    const last = items.at(-1);
    return {
      open, count: v.commentCount,
      comments: [...pinned, ...items].map((x) => this.view(x, v, auth)),
      nextCursor: page.length > 20 && last ? dateCursor(last.createdAt, last.id) : null,
    };
  }

  @Get('comments/:id/replies')
  @ApiOperation({ summary: 'Replies to a comment, oldest first' })
  async replies(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext | null, @Query('cursor') cursor?: string) {
    const parent = await this.comment(id);
    const v = await watchable(this.prisma, parent.videoId, auth);
    const c = parseDateCursor(cursor);
    const rows = await this.prisma.comment.findMany({
      where: { parentId: id, deletedAt: null, ...(c ? { OR: [{ createdAt: { gt: c.at } }, { createdAt: c.at, id: { gt: c.id } }] } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 51, include: AUTHOR,
    });
    const items = rows.slice(0, 50);
    const last = items.at(-1);
    return { replies: items.map((x) => this.view(x, v, auth)), nextCursor: rows.length > 50 && last ? dateCursor(last.createdAt, last.id) : null };
  }

  @Post('videos/:id/comments')
  @RequireAuth()
  @ApiOperation({ summary: 'Comment on a video, or reply to a comment' })
  async create(@Param('id', ParseUUIDPipe) id: string, @Body() body: NewCommentDto, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`comment:${auth.user.id}`, 30, 600, 'You are commenting very fast. Please wait a few minutes.');
    const v = await watchable(this.prisma, id, auth);
    if (!v.commentsEnabled || v.madeForKids) throw new ForbiddenException('Comments are turned off for this video.');
    const content = clean(body.content);
    // Checked before anyone sees it (safety/): over the line, it is not posted and the writer is told why.
    const verdict = await checkText(this.prisma, this.config, content);
    if (verdict.hold) throw new BadRequestException(refusal(verdict, 'comment'));
    let parentId: string | null = null;
    let replyingTo: string | null = null;
    if (body.parentId) {
      const p = await this.prisma.comment.findUnique({ where: { id: body.parentId } });
      if (!p || p.videoId !== id) throw new BadRequestException('You can only reply to a comment on this video.');
      if (p.deletedAt && !p.parentId) throw new BadRequestException('This comment was removed.');
      parentId = p.parentId ?? p.id; // replies to a reply join the same thread
      replyingTo = p.userId; // the person answered, even inside a thread
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await tx.comment.create({ data: { videoId: id, userId: auth.user.id, parentId, content }, include: AUTHOR });
      await tx.video.update({ where: { id }, data: { commentCount: { increment: 1 } } });
      if (parentId) await tx.comment.update({ where: { id: parentId }, data: { replyCount: { increment: 1 } } });
      return c;
    });
    await notifyComment(this.prisma, created, replyingTo);
    publish(room.video(id), 'comments', { videoId: id, parentId });
    return { comment: this.view(created, v, auth) };
  }

  @Patch('comments/:id')
  @RequireAuth()
  @ApiOperation({ summary: 'Edit my comment' })
  async edit(@Param('id', ParseUUIDPipe) id: string, @Body() body: EditCommentDto, @CurrentAuth() auth: AuthContext) {
    const c = await this.comment(id);
    if (c.userId !== auth.user.id || c.deletedAt) throw new ForbiddenException('You can only edit your own comments.');
    const updated = await this.prisma.comment.update({ where: { id }, data: { content: clean(body.content), editedAt: new Date() }, include: AUTHOR });
    return { comment: this.view(updated, c.video, auth) };
  }

  @Delete('comments/:id')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Remove a comment (its author, the video\'s creator or a moderator)' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) {
    const c = await this.comment(id);
    if (c.deletedAt) return { removed: true };
    if (c.userId !== auth.user.id && c.video.channel.userId !== auth.user.id && !isModerator(auth)) throw new ForbiddenException('You cannot remove this comment.');
    await this.prisma.$transaction(async (tx) => {
      await tx.video.update({ where: { id: c.videoId }, data: { commentCount: { decrement: 1 } } });
      // A comment with replies stays as "removed" so the thread still makes sense.
      if (!c.parentId && c.replyCount > 0) { await tx.comment.update({ where: { id }, data: { deletedAt: new Date(), content: '', isPinned: false } }); return; }
      await tx.comment.delete({ where: { id } });
      if (c.parentId) {
        const p = await tx.comment.update({ where: { id: c.parentId }, data: { replyCount: { decrement: 1 } } });
        if (p.deletedAt && p.replyCount <= 0) await tx.comment.delete({ where: { id: p.id } });
      }
    });
    publish(room.video(c.videoId), 'comments', { videoId: c.videoId });
    return { removed: true };
  }

  @Post('comments/:id/pin')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Pin a comment to the top (the video\'s creator; one pinned comment per video)' })
  async pin(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) { return this.setPinned(id, auth, true); }

  @Delete('comments/:id/pin')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Unpin a comment' })
  async unpin(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) { return this.setPinned(id, auth, false); }

  private async setPinned(id: string, auth: AuthContext, pinned: boolean) {
    const c = await this.comment(id);
    if (c.video.channel.userId !== auth.user.id) throw new ForbiddenException('Only the creator of this video can pin comments.');
    if (c.parentId || c.deletedAt) throw new BadRequestException('Only comments (not replies) can be pinned.');
    await this.prisma.$transaction([
      ...(pinned ? [this.prisma.comment.updateMany({ where: { videoId: c.videoId, isPinned: true }, data: { isPinned: false } })] : []),
      this.prisma.comment.update({ where: { id }, data: { isPinned: pinned } }),
    ]);
    return { pinned };
  }
}
