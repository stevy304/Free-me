import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { hasAdAccess, hasPremiumAccess } from '../billing/billing';
import { extname } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { RateLimitService } from '../common/rate-limit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { VIDEO_TYPES, sourceKey } from '../media/keys';
import { MediaQueue, STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';

class StartUploadDto {
  @ApiProperty({ example: 'my-trip.mp4' }) @IsString() @MaxLength(255) fileName!: string;
  @ApiProperty({ example: 734003200 }) @IsInt() @Min(1) sizeBytes!: number;
  @ApiPropertyOptional({ description: 'An ad for Ad Studio (Premium): unlisted, kept out of feeds and the Space' }) @IsOptional() @IsBoolean() ad?: boolean;
}
class PartNumbersDto { @ApiProperty({ example: [1, 2, 3] }) @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true }) @Max(10_000, { each: true }) partNumbers!: number[] }
class PartDto { @IsInt() @Min(1) @Max(10_000) partNumber!: number; @IsString() @MaxLength(200) etag!: string }
class TransferDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) bytes!: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) durationMs!: number;
  @IsInt() @Min(0) @Max(100_000) retries!: number;
  @IsInt() @Min(0) @Max(32) peakParallel!: number;
}
class CompleteDto {
  @ApiProperty({ type: [PartDto], required: false }) @IsOptional() @IsArray() @ArrayMaxSize(10_000) @ValidateNested({ each: true }) @Type(() => PartDto) parts?: PartDto[];
  @IsOptional() @IsObject() @ValidateNested() @Type(() => TransferDto) transfer?: TransferDto;
}

/**
 * Resumable uploads straight to object storage: the API hands out a signed address per part, the browser sends the
 * parts (several at once, retrying any that fail), and a lost connection or closed tab resumes from the parts already
 * stored. The API never carries the video bytes (except with the local development driver).
 */
@ApiTags('uploads')
@Controller('uploads')
@RequireAuth('CREATOR')
export class UploadsController {
  private readonly log = new Logger(UploadsController.name);
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly limits: RateLimitService,
    private readonly queue: MediaQueue, @Inject(STORAGE) private readonly storage: Storage, @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async mine(auth: AuthContext, id: string) {
    const v = await this.prisma.video.findFirst({ where: { id, channel: { userId: auth.user.id } } });
    if (!v) throw new NotFoundException('Upload not found.');
    return v;
  }

  @Post()
  @ApiOperation({ summary: 'Start an upload: creates a private draft video and a multipart upload' })
  async start(@CurrentAuth() auth: AuthContext, @Body() body: StartUploadDto, @Req() req: AppRequest) {
    await this.limits.consume(`upload:start:${auth.user.id}`, 100, 24 * 3600, 'You reached the daily upload limit. Try again tomorrow.');
    // New accounts start small: fewer uploads a day during their first week (abuse usually comes from fresh accounts).
    if (auth.user.createdAt.getTime() > Date.now() - 7 * 24 * 3600_000) {
      const n = this.config.safety.newAccountDailyUploads;
      await this.limits.consume(`upload:new:${auth.user.id}`, n, 24 * 3600, `New accounts can upload up to ${n} videos a day during their first week.`);
    }
    const channel = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!channel) throw new BadRequestException('Create your channel before uploading.');
    const ext = extname(body.fileName).toLowerCase();
    const type = VIDEO_TYPES[ext];
    if (!type) throw new BadRequestException(`This file type is not supported. Upload ${Object.keys(VIDEO_TYPES).map((e) => e.slice(1).toUpperCase()).join(', ')}.`);
    const premium = hasPremiumAccess(auth.user);
    const maxFileBytes = Math.min(this.config.media.maxUploadBytes, (premium ? 100 : 2) * 1024 ** 3);
    const maxStorageBytes = BigInt(premium ? 500 : 10) * 1024n ** 3n;
    if (body.sizeBytes > maxFileBytes) throw new BadRequestException(`Your plan allows up to ${maxFileBytes / 1024 ** 3} GiB per video.`);
    const title = body.fileName.slice(0, body.fileName.length - ext.length).replace(/[_]+/g, ' ').trim().slice(0, 100) || 'Untitled video';
    const partSize = this.config.media.driver === 's3' && body.sizeBytes >= 4 * 1024 ** 3
      ? Math.max(this.config.media.partBytes, 64 * 1024 ** 2)
      : this.config.media.partBytes;
    if (body.ad && !hasAdAccess(auth.user)) throw new ForbiddenException('Ad Studio requires Premium or an advertiser badge.');
    const video = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Channel" WHERE id = ${channel.id} FOR UPDATE`;
      const open = await tx.video.count({ where: { channelId: channel.id, status: 'UPLOADING' } });
      if (open >= (premium ? 20 : 3)) throw new ConflictException('Finish or cancel your unfinished uploads first.');
      const usage = await tx.video.aggregate({ where: { channelId: channel.id }, _sum: { sourceSizeBytes: true } });
      if ((usage._sum.sourceSizeBytes ?? 0n) + BigInt(body.sizeBytes) > maxStorageBytes) {
        throw new BadRequestException(`Your ${premium ? 500 : 10} GiB original-video storage allowance is full.`);
      }
      return tx.video.create({ data: { channelId: channel.id, title, status: 'UPLOADING', visibility: body.ad ? 'UNLISTED' : 'PRIVATE', isAd: !!body.ad, sourceSizeBytes: BigInt(body.sizeBytes), uploadPartBytes: BigInt(partSize), processingStage: 'Uploading' } });
    });
    const key = sourceKey(video.id, ext);
    let uploadId: string | undefined;
    try {
      uploadId = await this.storage.createMultipart(key, type);
      await this.prisma.video.update({ where: { id: video.id }, data: { sourceFileS3Key: key, uploadId } });
    } catch (error) {
      if (uploadId) await this.storage.abortMultipart(key, uploadId);
      await this.prisma.video.delete({ where: { id: video.id } });
      throw error;
    }
    await this.audit.record({ userId: auth.user.id, action: 'UPLOAD_STARTED', entityType: 'Video', entityId: video.id, req, details: { sizeBytes: body.sizeBytes, ext } });
    return { videoId: video.id, title, partSize, parallelLimit: premium ? 6 : 2, partCount: Math.ceil(body.sizeBytes / partSize) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Upload state, for resuming: the parts already stored' })
  async state(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const v = await this.mine(auth, id);
    if (v.status !== 'UPLOADING' || !v.uploadId) return { videoId: v.id, status: v.status, isAd: v.isAd, parts: [] };
    const key = v.sourceFileS3Key!;
    const parts = await this.storage.listParts(key, v.uploadId).catch(async (error: unknown) => {
      if (await this.storage.head(key)) return [];
      throw error;
    });
    const assembled = parts.length === 0 && (await this.storage.head(key))?.size === Number(v.sourceSizeBytes);
    return { videoId: v.id, status: v.status, isAd: v.isAd, assembled, parallelLimit: hasPremiumAccess(auth.user) ? 6 : 2, sizeBytes: Number(v.sourceSizeBytes), partSize: Number(v.uploadPartBytes ?? this.config.media.partBytes), parts };
  }

  @Post(':id/parts')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed addresses to upload parts to (valid one hour)' })
  async parts(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PartNumbersDto) {
    const v = await this.mine(auth, id);
    if (v.status !== 'UPLOADING' || !v.uploadId) throw new ConflictException('This upload is already finished.');
    const max = Math.ceil(Number(v.sourceSizeBytes) / Number(v.uploadPartBytes ?? this.config.media.partBytes));
    if (body.partNumbers.some((n) => n > max)) throw new BadRequestException('Part number out of range.');
    // An upload can span days on a slow connection. Keep its cleanup clock tied to recent activity.
    if (Date.now() - v.updatedAt.getTime() >= 60 * 60_000) {
      await this.prisma.video.updateMany({
        where: { id: v.id, status: 'UPLOADING', updatedAt: v.updatedAt },
        data: { updatedAt: new Date() },
      });
    }
    const entries = await Promise.all([...new Set(body.partNumbers)].map(async (n) =>
      [n, await this.storage.partUrl(v.sourceFileS3Key!, v.uploadId!, n, 3600)] as const,
    ));
    return { urls: Object.fromEntries(entries) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish the upload and start processing' })
  async complete(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CompleteDto, @Req() req: AppRequest) {
    const started = performance.now();
    const v = await this.mine(auth, id);
    if (v.status === 'PROCESSING' || v.status === 'READY') {
      if (this.queue.queue && v.status === 'PROCESSING' && v.processingStage === 'Waiting to process') {
        await this.queue.add({ name: 'transcode', videoId: v.id });
      }
      return { videoId: v.id, status: v.status };
    }
    if (v.status !== 'UPLOADING' || !v.uploadId) throw new ConflictException('This upload is already finished.');
    const partSize = Number(v.uploadPartBytes ?? this.config.media.partBytes);
    const sourceSize = Number(v.sourceSizeBytes);
    const expected = Math.ceil(sourceSize / partSize);
    const key = v.sourceFileS3Key!;
    let stored = await this.storage.head(key);
    if (!stored) {
      const storedParts = await this.storage.listParts(key, v.uploadId).catch(async (error: unknown) => {
        stored = await this.storage.head(key);
        if (stored) return [];
        throw error;
      });
      const valid = storedParts.filter(({ partNumber, size }) =>
        partNumber >= 1 && partNumber <= expected && size === (partNumber === expected ? sourceSize - partSize * (expected - 1) : partSize));
      const parts = body.parts ?? valid;
      const numbers = new Set(parts.map((p) => p.partNumber));
      if (!stored && (valid.length !== expected || parts.length !== expected || numbers.size !== expected || [...numbers].some((n) => n > expected))) throw new BadRequestException(`Upload all ${expected} parts first.`);
      try { if (!stored) await this.storage.completeMultipart(key, v.uploadId, parts); }
      catch {
        // The object may already exist if storage completed the upload before the response was lost.
        stored = await this.storage.head(key);
        if (!stored) throw new BadRequestException('Some parts are missing or damaged. Resume the upload to send them again.');
      }
      stored ??= await this.storage.head(key);
    }
    if (!stored || stored.size !== Number(v.sourceSizeBytes)) {
      await this.storage.deletePrefix(`src/${v.id}/`);
      await this.prisma.video.updateMany({ where: { id: v.id, status: 'UPLOADING' }, data: { status: 'FAILED', uploadId: null, processingStage: 'Failed', processingError: 'The uploaded file is incomplete. Upload it again.' } });
      throw new BadRequestException('The uploaded file is incomplete. Upload it again.');
    }
    const size = stored.size;
    const transitioned = await this.prisma.$transaction(async (tx) => {
      const result = await tx.video.updateMany({
        where: { id: v.id, status: 'UPLOADING', uploadId: v.uploadId },
        data: { status: 'PROCESSING', uploadId: null, processingStage: 'Waiting to process', processingProgress: 0 },
      });
      if (!result.count) return false;
      await tx.videoFile.create({ data: { videoId: v.id, s3Key: key, bucketName: this.config.media.s3?.bucket ?? 'local', fileSize: BigInt(size), mimeType: VIDEO_TYPES[extname(key)] ?? 'application/octet-stream' } });
      return true;
    });
    if (!transitioned) {
      const latest = await this.prisma.video.findUnique({ where: { id } });
      if (!latest) {
        await this.storage.deletePrefix(`src/${id}/`);
        throw new NotFoundException('Upload not found.');
      }
      if (latest.status === 'PROCESSING' || latest.status === 'READY') return { videoId: v.id, status: latest.status };
      throw new ConflictException('This upload is already finished.');
    }
    const transfer = body.transfer;
    this.log.log({
      event: 'upload_completed', videoId: v.id, sourceBytes: size,
      transferBytes: transfer?.bytes, transferMs: transfer?.durationMs,
      transferBytesPerSecond: transfer?.durationMs ? Math.round(transfer.bytes * 1000 / transfer.durationMs) : undefined,
      retries: transfer?.retries, peakParallel: transfer?.peakParallel,
      finalizeMs: Math.round(performance.now() - started),
    });
    await this.queue.add({ name: 'transcode', videoId: v.id });
    await this.audit.record({ userId: auth.user.id, action: 'UPLOAD_COMPLETED', entityType: 'Video', entityId: v.id, req });
    return { videoId: v.id, status: 'PROCESSING' };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an unfinished upload' })
  async cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const v = await this.mine(auth, id);
    if (v.status !== 'UPLOADING') throw new ConflictException('This upload is finished; delete the video in Studio instead.');
    const deleted = await this.prisma.video.deleteMany({ where: { id: v.id, status: 'UPLOADING' } });
    if (!deleted.count) throw new ConflictException('This upload is finished; delete the video in Studio instead.');
    if (v.uploadId) await this.storage.abortMultipart(v.sourceFileS3Key!, v.uploadId);
    await this.storage.deletePrefix(`src/${v.id}/`);
    return { cancelled: true };
  }
}
