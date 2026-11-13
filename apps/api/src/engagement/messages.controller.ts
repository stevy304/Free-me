import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Delete } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { checkText, refusal } from '../safety/check';
import { publish, room } from '../realtime/publish';
import { dateCursor, parseDateCursor } from './access';

export const MESSAGE_MAX = 2000;
class SendDto { @ApiProperty() @IsString() @MaxLength(MESSAGE_MAX) body!: string }

const PERSON = { select: { id: true, profile: { select: { displayName: true, avatarUrl: true } }, channel: { select: { name: true, handle: true, avatarUrl: true } } } } as const;
type Person = Prisma.UserGetPayload<typeof PERSON>;
const personView = (u: Person) => ({ id: u.id, name: u.channel?.name ?? u.profile?.displayName ?? 'Free Me member', handle: u.channel?.handle ?? null, avatarUrl: u.channel?.avatarUrl ?? u.profile?.avatarUrl ?? null });

/**
 * Direct messages between two accounts. Any signed-in account can start a conversation with a Space (by its handle);
 * either side can block the other, which stops messages both ways. Every message passes the safety check before it is
 * delivered (a refused one is not sent, and the writer is told why), and sending is rate limited against spam.
 */
@ApiTags('messages')
@Controller('messages')
@RequireAuth()
export class MessagesController {
  constructor(private readonly prisma: PrismaService, private readonly limits: RateLimitService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** The conversation and which side I am, or 404 when it is not mine. */
  private async mine(id: string, me: string) {
    const c = await this.prisma.conversation.findUnique({ where: { id }, include: { userA: PERSON, userB: PERSON } });
    if (!c || (c.userAId !== me && c.userBId !== me)) throw new NotFoundException('This conversation does not exist.');
    const a = c.userAId === me;
    return { c, a, other: a ? c.userB : c.userA, readAt: a ? c.aReadAt : c.bReadAt };
  }

  private async blocked(me: string, other: string) {
    const rows = await this.prisma.userBlock.findMany({ where: { OR: [{ blockerId: me, blockedId: other }, { blockerId: other, blockedId: me }] }, select: { blockerId: true } });
    return { byMe: rows.some((r) => r.blockerId === me), byThem: rows.some((r) => r.blockerId === other) };
  }

  @Get()
  @ApiOperation({ summary: 'My conversations, latest first, with the last message and whether it is unread' })
  async list(@CurrentAuth() auth: AuthContext) {
    const me = auth.user.id;
    const rows = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: me }, { userBId: me }], messages: { some: {} } }, orderBy: { lastMessageAt: 'desc' }, take: 100,
      include: { userA: PERSON, userB: PERSON, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return {
      conversations: rows.map((c) => {
        const a = c.userAId === me; const last = c.messages[0]; const readAt = a ? c.aReadAt : c.bReadAt;
        return { id: c.id, other: personView(a ? c.userB : c.userA), last: last ? { body: last.body, at: last.createdAt, mine: last.senderId === me } : null,
          unread: !!last && last.senderId !== me && (!readAt || last.createdAt > readAt) };
      }),
    };
  }

  @Get('unread')
  @ApiOperation({ summary: 'How many conversations have messages I have not read (for the badge)' })
  async unread(@CurrentAuth() auth: AuthContext) {
    const me = auth.user.id;
    const [r] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "Conversation" c
      WHERE (c."userAId" = ${me} OR c."userBId" = ${me}) AND EXISTS (
        SELECT 1 FROM "DirectMessage" m WHERE m."conversationId" = c.id AND m."senderId" <> ${me}
          AND m."createdAt" > COALESCE(CASE WHEN c."userAId" = ${me} THEN c."aReadAt" ELSE c."bReadAt" END, 'epoch'::timestamp))`;
    return { count: Number(r?.n ?? 0n) };
  }

  @Post('with/:handle')
  @HttpCode(200)
  @ApiOperation({ summary: 'Open my conversation with a Space\'s owner (started when the first message is sent)' })
  async open(@Param('handle') handle: string, @CurrentAuth() auth: AuthContext) {
    const me = auth.user.id;
    const ch = await this.prisma.channel.findUnique({ where: { handle: handle.replace(/^@/, '').toLowerCase() }, select: { userId: true } });
    if (!ch) throw new NotFoundException('This Space does not exist.');
    if (ch.userId === me) throw new BadRequestException('This is your own Space.');
    const [userAId, userBId] = me < ch.userId ? [me, ch.userId] : [ch.userId, me];
    const existing = await this.prisma.conversation.findUnique({ where: { userAId_userBId: { userAId, userBId } }, select: { id: true } });
    if (existing) return { id: existing.id };
    // New conversations are limited, so one account cannot message everyone.
    await this.limits.consume(`dm:new:${me}`, 20, 86_400, 'You started many new conversations today. Try again tomorrow.');
    const c = await this.prisma.conversation.upsert({ where: { userAId_userBId: { userAId, userBId } }, create: { userAId, userBId }, update: {}, select: { id: true } });
    return { id: c.id };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Messages in one of my conversations, newest first (cursor for older ones)' })
  async read(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext, @Query('cursor') cursor?: string) {
    const me = auth.user.id;
    const { other } = await this.mine(id, me);
    const c = parseDateCursor(cursor);
    const rows = await this.prisma.directMessage.findMany({
      where: { conversationId: id, ...(c ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
    });
    const items = rows.slice(0, 50);
    const last = items.at(-1);
    return {
      id, other: personView(other), blocked: await this.blocked(me, other.id),
      messages: items.map((m) => ({ id: m.id, body: m.body, mine: m.senderId === me, at: m.createdAt })),
      nextCursor: rows.length > 50 && last ? dateCursor(last.createdAt, last.id) : null,
    };
  }

  @Post(':id')
  @ApiOperation({ summary: 'Send a message (checked by the safety check before it is delivered)' })
  async send(@Param('id', ParseUUIDPipe) id: string, @Body() body: SendDto, @CurrentAuth() auth: AuthContext) {
    const me = auth.user.id;
    await this.limits.consume(`dm:send:${me}`, 60, 3600, 'You are sending messages very fast. Please wait a little.');
    const { c, a, other } = await this.mine(id, me);
    const text = body.body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new BadRequestException('Write something first.');
    const b = await this.blocked(me, other.id);
    if (b.byMe) throw new ForbiddenException('You blocked this account. Unblock it to send messages.');
    if (b.byThem) throw new ForbiddenException('You cannot send messages to this account.');
    // Checked before it is delivered, like a comment: over the line, it is not sent and the writer is told why.
    const verdict = await checkText(this.prisma, this.config, text, undefined, { kind: 'comment' });
    if (verdict.hold) throw new BadRequestException(refusal(verdict, 'message'));
    const now = new Date();
    const m = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.directMessage.create({ data: { conversationId: c.id, senderId: me, body: text, createdAt: now } });
      await tx.conversation.update({ where: { id: c.id }, data: { lastMessageAt: now, ...(a ? { aReadAt: now } : { bReadAt: now }) } });
      return msg;
    });
    publish(room.user(other.id), 'messages', { conversationId: c.id });
    return { message: { id: m.id, body: m.body, mine: true, at: m.createdAt } };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a conversation as read' })
  async markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) {
    const { c, a } = await this.mine(id, auth.user.id);
    await this.prisma.conversation.update({ where: { id: c.id }, data: a ? { aReadAt: new Date() } : { bReadAt: new Date() } });
    publish(room.user(auth.user.id), 'messages', { conversationId: c.id });
    return { read: true };
  }

  @Post(':id/block')
  @HttpCode(200)
  @ApiOperation({ summary: 'Block the other person: no messages either way until unblocked' })
  async block(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) {
    const { other } = await this.mine(id, auth.user.id);
    await this.prisma.userBlock.upsert({ where: { blockerId_blockedId: { blockerId: auth.user.id, blockedId: other.id } }, create: { blockerId: auth.user.id, blockedId: other.id }, update: {} });
    return { blocked: true };
  }

  @Delete(':id/block')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unblock the other person' })
  async unblock(@Param('id', ParseUUIDPipe) id: string, @CurrentAuth() auth: AuthContext) {
    const { other } = await this.mine(id, auth.user.id);
    await this.prisma.userBlock.deleteMany({ where: { blockerId: auth.user.id, blockedId: other.id } });
    return { blocked: false };
  }
}
