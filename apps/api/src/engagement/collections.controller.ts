import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Playlist, Visibility } from '@prisma/client';
import { COLLECTION_ITEMS_MAX, COLLECTION_TITLE_MAX } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AuthContext } from '../common/request';
import { LINKED_VIDEO, videoCard } from '../catalog/serialize';
import { MediaUrls } from '../videos/media-urls';
import { watchable } from './access';

class NewCollectionDto {
  @ApiProperty() @IsString() @MaxLength(COLLECTION_TITLE_MAX) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED', 'PRIVATE']) visibility?: Visibility;
}
class EditCollectionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(COLLECTION_TITLE_MAX) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED', 'PRIVATE']) visibility?: Visibility;
}

const MAX_COLLECTIONS = 200;

/** Collections: the private "Kept" list every account has (stored as kind SAVED), plus named collections that can be shared. */
@ApiTags('collections')
@Controller()
export class CollectionsController {
  constructor(private readonly prisma: PrismaService, private readonly limits: RateLimitService, private readonly urls: MediaUrls) {}

  /** The account's "Saved" collection, created the first time it is needed. */
  private async saved(userId: string) {
    const found = await this.prisma.playlist.findFirst({ where: { userId, kind: 'SAVED' }, orderBy: { createdAt: 'asc' } });
    return found ?? this.prisma.playlist.create({ data: { userId, kind: 'SAVED', title: 'Saved', visibility: 'PRIVATE' } });
  }

  /** "saved" or a collection id; only the owner's own collections. */
  private async own(auth: AuthContext, id: string) {
    if (id === 'saved') return this.saved(auth.user.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Collection not found.');
    const p = await this.prisma.playlist.findFirst({ where: { id, userId: auth.user.id } });
    if (!p) throw new NotFoundException('Collection not found.');
    return p;
  }

  private async summary(p: Playlist) {
    const where = { playlistId: p.id, video: LINKED_VIDEO };
    const [count, first] = await Promise.all([
      this.prisma.playlistItem.count({ where }),
      this.prisma.playlistItem.findFirst({ where, orderBy: [{ position: 'desc' }], include: { video: { include: { channel: true } } } }),
    ]);
    return { id: p.id, kind: p.kind, title: p.kind === 'SAVED' ? 'Kept' : p.title, description: p.description, visibility: p.visibility, updatedAt: p.updatedAt, videoCount: count, thumbnailUrl: first ? this.urls.publicThumb(first.video) : null };
  }

  @Get('me/collections')
  @RequireAuth()
  @ApiOperation({ summary: 'My collections, "Saved" first' })
  async mine(@CurrentAuth() auth: AuthContext) {
    await this.saved(auth.user.id);
    const rows = await this.prisma.playlist.findMany({ where: { userId: auth.user.id }, orderBy: [{ kind: 'asc' }, { updatedAt: 'desc' }] });
    return { collections: await Promise.all(rows.map((p) => this.summary(p))) };
  }

  @Get('me/collections/containing/:videoId')
  @RequireAuth()
  @ApiOperation({ summary: 'Which of my collections hold this video' })
  async containing(@Param('videoId', ParseUUIDPipe) videoId: string, @CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.playlistItem.findMany({ where: { videoId, playlist: { userId: auth.user.id } }, select: { playlistId: true } });
    return { collectionIds: rows.map((r) => r.playlistId) };
  }

  @Post('me/collections')
  @RequireAuth()
  @ApiOperation({ summary: 'Create a collection (private unless I choose otherwise)' })
  async create(@Body() body: NewCollectionDto, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`collections:${auth.user.id}`, 60, 3600);
    const title = body.title.trim();
    if (!title) throw new BadRequestException('Give the collection a name.');
    if (await this.prisma.playlist.count({ where: { userId: auth.user.id } }) >= MAX_COLLECTIONS) throw new BadRequestException(`You can have up to ${MAX_COLLECTIONS} collections.`);
    const p = await this.prisma.playlist.create({ data: { userId: auth.user.id, kind: 'CUSTOM', title, description: body.description?.trim() || null, visibility: body.visibility ?? 'PRIVATE' } });
    return { collection: await this.summary(p) };
  }

  @Patch('me/collections/:id')
  @RequireAuth()
  @ApiOperation({ summary: 'Rename a collection or change who can see it ("Saved" is always private)' })
  async edit(@Param('id') id: string, @Body() body: EditCollectionDto, @CurrentAuth() auth: AuthContext) {
    const p = await this.own(auth, id);
    if (p.kind === 'SAVED') throw new BadRequestException('"Kept" cannot be renamed or shared.');
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) { const t = body.title.trim(); if (!t) throw new BadRequestException('Give the collection a name.'); data.title = t; }
    if (body.description !== undefined) data.description = body.description.trim() || null;
    if (body.visibility !== undefined) data.visibility = body.visibility;
    return { collection: await this.summary(await this.prisma.playlist.update({ where: { id: p.id }, data })) };
  }

  @Delete('me/collections/:id')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Delete a collection (the videos themselves are not affected)' })
  async remove(@Param('id') id: string, @CurrentAuth() auth: AuthContext) {
    const p = await this.own(auth, id);
    if (p.kind === 'SAVED') throw new BadRequestException('"Kept" cannot be deleted. Remove videos from it instead.');
    await this.prisma.playlist.delete({ where: { id: p.id } });
    return { deleted: true };
  }

  @Put('me/collections/:id/videos/:videoId')
  @RequireAuth()
  @ApiOperation({ summary: 'Add a video to a collection (newest at the top)' })
  async add(@Param('id') id: string, @Param('videoId', ParseUUIDPipe) videoId: string, @CurrentAuth() auth: AuthContext) {
    await this.limits.consume(`collect:${auth.user.id}`, 600, 3600);
    const p = await this.own(auth, id);
    await watchable(this.prisma, videoId, auth);
    if (await this.prisma.playlistItem.count({ where: { playlistId: p.id } }) >= COLLECTION_ITEMS_MAX) throw new BadRequestException(`A collection can hold up to ${COLLECTION_ITEMS_MAX} videos.`);
    const top = await this.prisma.playlistItem.aggregate({ where: { playlistId: p.id }, _max: { position: true } });
    await this.prisma.playlistItem.createMany({ data: [{ playlistId: p.id, videoId, position: (top._max.position ?? 0) + 1 }], skipDuplicates: true });
    await this.prisma.playlist.update({ where: { id: p.id }, data: { updatedAt: new Date() } });
    return { added: true, collectionId: p.id };
  }

  @Delete('me/collections/:id/videos/:videoId')
  @HttpCode(200)
  @RequireAuth()
  @ApiOperation({ summary: 'Remove a video from a collection' })
  async drop(@Param('id') id: string, @Param('videoId', ParseUUIDPipe) videoId: string, @CurrentAuth() auth: AuthContext) {
    const p = await this.own(auth, id);
    const r = await this.prisma.playlistItem.deleteMany({ where: { playlistId: p.id, videoId } });
    return { removed: r.count > 0, collectionId: p.id };
  }

  @Get('collections/:id')
  @ApiOperation({ summary: 'A collection and its videos (public and unlisted ones for everyone; private ones for their owner)' })
  async get(@Param('id') id: string, @CurrentAuth() auth: AuthContext | null) {
    const p = id === 'saved' ? (auth ? await this.saved(auth.user.id) : null)
      : /^[0-9a-f-]{36}$/i.test(id) ? await this.prisma.playlist.findUnique({ where: { id } }) : null;
    const owner = !!p && p.userId === auth?.user.id;
    if (!p || (p.visibility === 'PRIVATE' && !owner)) throw new NotFoundException('This collection is private or does not exist.');
    const [items, author] = await Promise.all([
      this.prisma.playlistItem.findMany({ where: { playlistId: p.id, video: LINKED_VIDEO }, orderBy: [{ position: 'desc' }], take: 500, include: { video: { include: { channel: true } } } }),
      this.prisma.user.findUnique({ where: { id: p.userId }, include: { profile: true, channel: true } }),
    ]);
    return {
      collection: await this.summary(p), isOwner: owner,
      owner: { name: author?.channel?.name ?? author?.profile?.displayName ?? 'Free Me member', handle: author?.channel?.handle ?? null },
      videos: items.map((i) => videoCard(i.video, this.urls)),
    };
  }
}
