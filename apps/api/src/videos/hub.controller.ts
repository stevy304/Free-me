import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { checkText, refusal, videoText } from '../safety/check';
import { AUTOMATED_MATCH } from '../media/screening';
import { forgetHotVideo } from '../engagement/hot-video';
import { feedsChanged } from '../catalog/feed-cache';
import { announceVideo } from '../notifications/notify';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Video, Visibility } from '@prisma/client';
import { isLanguageCode } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { mediaPrefix, wantedLocation } from '../media/keys';
import { MediaQueue, STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';
import { MediaUrls } from './media-urls';
import { CAPTION_MAX_BYTES, CaptionError, putMediaFile, toWebVtt } from '../media/captions';

class UpdateVideoDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED', 'PRIVATE'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED', 'PRIVATE']) visibility?: Visibility;
  @ApiPropertyOptional({ description: 'Category slug, or null', nullable: true }) @IsOptional() @IsString() category?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() language?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @ApiPropertyOptional({ description: 'Made for kids: personalised features and comments are limited' }) @IsOptional() @IsBoolean() madeForKids?: boolean;
  @ApiPropertyOptional({ description: 'Allow comments (always off for videos made for kids)' }) @IsOptional() @IsBoolean() commentsEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Choose a generated thumbnail (0, 1 or 2)' }) @IsOptional() @IsInt() @Min(0) thumbnail?: number;
  @ApiPropertyOptional({ description: 'Moments: the sound used (a song title); empty = original sound', nullable: true }) @IsOptional() @IsString() @MaxLength(100) soundTitle?: string | null;
  @ApiPropertyOptional({ description: 'Moments: the series this is an episode of (one of mine), or null', nullable: true }) @IsOptional() @IsString() seriesId?: string | null;
  @ApiPropertyOptional({ description: 'Its episode number in the series (default: after the last one)' }) @IsOptional() @IsInt() @Min(1) @Max(9999) episodeNumber?: number;
}

const IMAGE: Array<[string, number[], string]> = [['image/jpeg', [0xff, 0xd8, 0xff], '.jpg'], ['image/png', [0x89, 0x50, 0x4e, 0x47], '.png'], ['image/webp', [0x52, 0x49, 0x46, 0x46], '.webp']];

/** Creator Hub: the creator's own videos in every status and visibility; editing, thumbnails, deletion. */
@ApiTags('creator hub')
@Controller('hub/videos')
@RequireAuth('CREATOR')
export class HubController {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly queue: MediaQueue,
    private readonly urls: MediaUrls, @Inject(STORAGE) private readonly storage: Storage, @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async mine(auth: AuthContext, id: string) {
    const v = await this.prisma.video.findFirst({ where: { id, channel: { userId: auth.user.id } }, include: { category: true, tags: { include: { tag: true } }, renditions: true } });
    if (!v) throw new NotFoundException('Video not found.');
    return v;
  }

  private async view(v: Video & { category?: { slug: string; name: string } | null; tags?: Array<{ tag: { name: string } }>; renditions?: Array<{ resolution: string; height: number; width: number }> }) {
    return {
      id: v.id, title: v.title, description: v.description, visibility: v.visibility, status: v.status, madeForKids: v.madeForKids, isShort: v.isShort, isPodcast: v.isPodcast, isAd: v.isAd,
      language: v.language, category: v.category ? { slug: v.category.slug, name: v.category.name } : null, tags: v.tags?.map((t) => t.tag.name) ?? [],
      soundTitle: v.soundTitle, seriesId: v.seriesId, episodeNumber: v.episodeNumber,
      durationSeconds: v.durationSeconds, width: v.width, height: v.height, processingProgress: v.processingProgress, processingStage: v.processingStage,
      // The automatic safety decision (safety/ai.ts), what the creator reads, and whether they can still appeal.
      // A block by a rights claim (Content ID) is disputed with the owner (Creator Hub → Rights), not appealed.
      safety: { decision: v.safetyDecision, reason: v.safetyReason, limited: !!v.safetyLimitedAt, appealedAt: v.appealedAt, rightsClaim: v.safetyModel === 'content-id',
        canAppeal: v.safetyModel !== 'content-id' && !v.appealedAt && !v.takenDownAt && (v.safetyDecision === 'reject' || v.safetyDecision === 'limit') },
      processingError: v.processingError, viewCount: v.viewCount.toString(), likeCount: v.likeCount, dislikeCount: v.dislikeCount, commentCount: v.commentCount, commentsEnabled: v.commentsEnabled,
      takenDownAt: v.takenDownAt, takedownReason: v.takedownReason,
      createdAt: v.createdAt, publishedAt: v.publishedAt, thumbnailUrl: await this.urls.thumb(v), customThumbnail: v.customThumbnail,
      thumbnailCandidates: await Promise.all(v.thumbnailCandidates.map((k) => this.urls.file(v, k))),
      renditions: (v.renditions ?? []).sort((a, b) => a.height * a.width - b.height * b.width).map((r) => r.resolution).filter((name, i, all) => all.indexOf(name) === i),
      playbackUrl: this.urls.playback(v), sourceSizeBytes: v.sourceSizeBytes?.toString() ?? null,
      captions: (await this.prisma.caption.findMany({ where: { videoId: v.id }, orderBy: { language: 'asc' } }))
        .map((c) => ({ language: c.language, source: c.source, cues: c.cueCount, updatedAt: c.updatedAt, url: `/api/videos/${v.id}/captions/${c.language}.vtt` })),
    };
  }

  @Get()
  @ApiOperation({ summary: 'My videos, newest first' })
  async list(@CurrentAuth() auth: AuthContext, @Query('cursor') cursor?: string, @Query('status') status?: string, @Query('ads') ads?: string) {
    const rows = await this.prisma.video.findMany({
      // Ads live in Ad Studio (?ads=true), not with the Space's videos.
      where: { channel: { userId: auth.user.id }, isAd: ads === 'true', ...(status === 'UPLOADING' ? { status: 'UPLOADING' } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 31, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { category: true, renditions: { select: { resolution: true, width: true, height: true } } },
    });
    return { videos: await Promise.all(rows.slice(0, 30).map((v) => this.view(v))), nextCursor: rows.length > 30 ? rows[29].id : null };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my videos with its details' })
  async get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return { video: await this.view(await this.mine(auth, id)) }; }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit details and visibility; publishing sets the publish date' })
  async update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateVideoDto, @Req() req: AppRequest) {
    const v = await this.mine(auth, id);
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) { const t = body.title.trim(); if (!t) throw new BadRequestException('A title cannot be empty.'); data.title = t; }
    if (body.description !== undefined) data.description = body.description.trim() || null;
    if (body.language !== undefined) { if (body.language && !isLanguageCode(body.language)) throw new BadRequestException('Choose a language from the list.'); data.language = body.language?.toLowerCase() ?? null; }
    if (body.category !== undefined) {
      if (body.category === null || body.category === '') data.categoryId = null;
      else { const c = await this.prisma.category.findUnique({ where: { slug: body.category } }); if (!c) throw new BadRequestException('Choose a category from the list.'); data.categoryId = c.id; }
    }
    if (body.soundTitle !== undefined) data.soundTitle = body.soundTitle?.trim() || null;
    if (body.seriesId !== undefined) {
      if (!body.seriesId) { data.seriesId = null; data.episodeNumber = null; }
      else {
        const s = await this.prisma.series.findFirst({ where: { id: body.seriesId, channelId: v.channelId }, select: { id: true } });
        if (!s) throw new BadRequestException('Choose one of your series.');
        data.seriesId = s.id;
        if (body.episodeNumber === undefined && v.seriesId !== s.id) {
          const last = await this.prisma.video.aggregate({ where: { seriesId: s.id }, _max: { episodeNumber: true } });
          data.episodeNumber = (last._max.episodeNumber ?? 0) + 1;
        }
      }
    }
    if (body.episodeNumber !== undefined) {
      if (!(data.seriesId ?? v.seriesId)) throw new BadRequestException('Put the video in a series first.');
      data.episodeNumber = body.episodeNumber;
    }
    if (body.madeForKids !== undefined) data.madeForKids = body.madeForKids;
    if (body.commentsEnabled !== undefined) data.commentsEnabled = body.commentsEnabled;
    if (body.thumbnail !== undefined) {
      const key = v.thumbnailCandidates[body.thumbnail];
      if (!key) throw new BadRequestException('That thumbnail is not available yet.');
      data.thumbnailKey = key; data.customThumbnail = false;
      // Its small copy, when processing made one (videos processed before small copies existed have none).
      const small = key.replace(/\.jpg$/, '-s.jpg');
      data.thumbnailSmallKey = small !== key && (await this.storage.head(mediaPrefix(v.id, v.mediaLocation) + small).catch(() => null)) ? small : null;
    }
    if (v.isAd && body.visibility === 'PUBLIC') throw new BadRequestException('An ad stays out of feeds: it plays only before videos.');
    if (body.visibility !== undefined && body.visibility !== v.visibility) {
      data.visibility = body.visibility;
      if (body.visibility !== 'PRIVATE' && !v.publishedAt) data.publishedAt = new Date();
    }
    // Changed words are checked before they are saved (safety/): over the line, the video is hidden at the same moment
    // (reviewHoldAt) and a moderator is asked, so it is never shown with them.
    let flagged: Awaited<ReturnType<typeof checkText>> | null = null;
    if (body.title !== undefined || body.description !== undefined || body.tags !== undefined || body.soundTitle) {
      const tags = body.tags ?? (await this.prisma.videoTag.findMany({ where: { videoId: id }, select: { tag: { select: { name: true } } } })).map((t) => t.tag.name);
      const verdict = await checkText(this.prisma, this.config, videoText({ title: (data.title as string | undefined) ?? v.title, description: body.description !== undefined ? (data.description as string | null) : v.description, tags: body.soundTitle ? [...tags, body.soundTitle] : tags }), undefined, { kind: 'edit' });
      // The AI moderator decided: the words are not saved, and the creator is told why.
      if (verdict.hold && verdict.ai) throw new BadRequestException(refusal(verdict, 'title'));
      if (verdict.hold && !v.reviewHoldAt) { data.reviewHoldAt = new Date(); flagged = verdict; }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.video.update({ where: { id }, data });
      if (flagged) await tx.report.create({ data: { videoId: id, reason: AUTOMATED_MATCH, details: `${flagged.reason} — in the title, description or tags`, priority: flagged.priority } });
      forgetHotVideo(id);
      if (body.tags) {
        const names = [...new Set(body.tags.map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))].slice(0, 30);
        await tx.videoTag.deleteMany({ where: { videoId: id } });
        for (const name of names) {
          const tag = await tx.tag.upsert({ where: { name }, create: { name }, update: {} });
          await tx.videoTag.create({ data: { videoId: id, tagId: tag.id } });
        }
      }
    });
    // Media follows visibility: public/unlisted to the CDN prefix, private (and removed) behind signed links.
    const want = wantedLocation({ visibility: (data.visibility as string | undefined) ?? v.visibility, safetyCheckedAt: v.safetyCheckedAt, takenDownAt: v.takenDownAt });
    if (v.hlsMasterKey && want !== v.mediaLocation) await this.queue.add({ name: 'relocate', videoId: id });
    await feedsChanged();
    await announceVideo(this.prisma, id);
    await this.audit.record({ userId: auth.user.id, action: 'VIDEO_UPDATED', entityType: 'Video', entityId: id, req, details: { fields: Object.keys(data).concat(body.tags ? ['tags'] : []) } });
    return { video: await this.view(await this.mine(auth, id)) };
  }

  @Post(':id/appeal')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ask for an automatic safety decision (rejected or limited) to be looked at again, once per video' })
  async appeal(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: AppRequest) {
    const v = await this.mine(auth, id);
    if (v.takenDownAt) throw new BadRequestException('A moderator removed this video; reply to the removal email to ask for a review.');
    if (v.safetyDecision !== 'reject' && v.safetyDecision !== 'limit') throw new BadRequestException('There is nothing to appeal on this video.');
    if (v.safetyModel === 'content-id') throw new BadRequestException('This video matches someone else\'s work. Dispute the claim in Creator Hub → Rights.');
    if (v.appealedAt) throw new ConflictException('You already appealed this decision.');
    await this.prisma.video.update({ where: { id }, data: { appealedAt: new Date() } });
    await this.queue.add({ name: 'appeal', videoId: id });
    await this.audit.record({ userId: auth.user.id, action: 'VIDEO_APPEALED', entityType: 'Video', entityId: id, req, details: { decision: v.safetyDecision } });
    return { video: await this.view(await this.mine(auth, id)) };
  }

  @Put(':id/thumbnail')
  @ApiOperation({ summary: 'Upload a custom thumbnail (JPEG, PNG or WebP, up to 2 MB; 1280x720 recommended)' })
  async thumbnail(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: AppRequest) {
    const v = await this.mine(auth, id);
    // Podcasts send their cover while the sound file uploads, so it is in place when the podcast video is made.
    if (!v.hlsMasterKey && v.status !== 'UPLOADING' && v.status !== 'PROCESSING') throw new BadRequestException('Wait until the video has been processed.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > 2 * 1024 * 1024) throw new BadRequestException('The image must be 2 MB or smaller.'); chunks.push(c); }
    const buf = Buffer.concat(chunks);
    const kind = IMAGE.find(([, magic]) => magic.every((b, i) => buf[i] === b));
    if (!kind || (kind[0] === 'image/webp' && buf.subarray(8, 12).toString() !== 'WEBP')) throw new BadRequestException('Use a JPEG, PNG or WebP image.');
    const rel = `thumbs/custom-${Date.now()}${kind[2]}`;
    // The media may be moving between public and private storage right now (a visibility change). Save the image
    // where the files are, then record it only if they are still there; otherwise try again in the new place.
    // A move copies thumbs/ once more after switching places, so an image recorded before the switch is never lost.
    for (let attempt = 0; ; attempt++) {
      const cur = await this.mine(auth, id);
      await this.storage.putBuffer(mediaPrefix(id, cur.mediaLocation) + rel, buf, { contentType: kind[0], cacheControl: 'public, max-age=31536000, immutable' });
      const r = await this.prisma.video.updateMany({ where: { id, mediaLocation: cur.mediaLocation }, data: { thumbnailKey: rel, thumbnailSmallKey: null, customThumbnail: true } });
      if (r.count) break;
      if (attempt >= 2) throw new ConflictException('The video is being moved. Try again in a moment.');
    }
    return { video: await this.view(await this.mine(auth, id)) };
  }

  @Put(':id/captions/:lang')
  @ApiOperation({ summary: 'Add or replace captions in one language: a WebVTT or SubRip (.srt) file as the request body, up to 1 MB' })
  async putCaptions(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('lang') lang: string, @Req() req: AppRequest) {
    const language = lang.toLowerCase();
    if (!isLanguageCode(language)) throw new BadRequestException('Choose a language from the list.');
    const v = await this.mine(auth, id);
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > CAPTION_MAX_BYTES) throw new BadRequestException('A caption file must be 1 MB or smaller.'); chunks.push(c); }
    let parsed: { vtt: string; cues: number };
    try { parsed = toWebVtt(Buffer.concat(chunks).toString('utf8')); } catch (e) { if (e instanceof CaptionError) throw new BadRequestException(e.message); throw e; }
    const key = `captions/${language}.vtt`;
    await putMediaFile(this.prisma, this.storage, id, key, Buffer.from(parsed.vtt), { contentType: 'text/vtt; charset=utf-8', cacheControl: 'public, max-age=300' })
      .catch((e: Error) => { throw new ConflictException(e.message); });
    // An upload in a language replaces automatic captions in that language (their file goes too).
    const before = await this.prisma.caption.findUnique({ where: { videoId_language: { videoId: id, language } } });
    await this.prisma.caption.upsert({ where: { videoId_language: { videoId: id, language } }, create: { videoId: id, language, source: 'UPLOADED', key, cueCount: parsed.cues }, update: { source: 'UPLOADED', key, cueCount: parsed.cues } });
    if (before && before.key !== key) await this.storage.deletePrefix(mediaPrefix(id, v.mediaLocation) + before.key).catch(() => undefined);
    await this.audit.record({ userId: auth.user.id, action: 'CAPTIONS_UPLOADED', entityType: 'Video', entityId: id, req, details: { language, cues: parsed.cues } });
    return { video: await this.view(await this.mine(auth, v.id)) };
  }

  @Delete(':id/captions/:lang')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove captions in one language' })
  async deleteCaptions(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('lang') lang: string) {
    const v = await this.mine(auth, id);
    const c = await this.prisma.caption.findUnique({ where: { videoId_language: { videoId: id, language: lang.toLowerCase() } } });
    if (!c) throw new NotFoundException('No captions in that language.');
    await this.prisma.caption.delete({ where: { id: c.id } });
    await this.storage.deletePrefix(mediaPrefix(id, v.mediaLocation) + c.key);
    return { video: await this.view(await this.mine(auth, id)) };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a video and all its files' })
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: AppRequest) {
    const v = await this.mine(auth, id);
    if (v.uploadId && v.sourceFileS3Key) await this.storage.abortMultipart(v.sourceFileS3Key, v.uploadId);
    await this.prisma.video.delete({ where: { id } });
    forgetHotVideo(id);
    await this.queue.add({ name: 'purge', videoId: id });
    await feedsChanged();
    await this.audit.record({ userId: auth.user.id, action: 'VIDEO_DELETED', entityType: 'Video', entityId: id, req, details: { title: v.title } });
    return { deleted: true };
  }
}
