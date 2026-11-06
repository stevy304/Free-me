import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
}
class PartNumbersDto { @ApiProperty({ example: [1, 2, 3] }) @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true }) @Max(10_000, { each: true }) partNumbers!: number[] }
class PartDto { @IsInt() @Min(1) @Max(10_000) partNumber!: number; @IsString() @MaxLength(200) etag!: string }
class CompleteDto { @ApiProperty({ type: [PartDto], required: false }) @IsOptional() @IsArray() @ArrayMaxSize(10_000) @ValidateNested({ each: true }) @Type(() => PartDto) parts?: PartDto[] }

/**
 * Resumable uploads straight to object storage: the API hands out a signed address per part, the browser sends the
 * parts (several at once, retrying any that fail), and a lost connection or closed tab resumes from the parts already
 * stored. The API never carries the video bytes (except with the local development driver).
 */
@ApiTags('uploads')
@Controller('uploads')
@RequireAuth('CREATOR')
export class UploadsController {
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
    if (body.sizeBytes > this.config.media.maxUploadBytes) throw new BadRequestException(`Videos can be up to ${Math.floor(this.config.media.maxUploadBytes / 1024 ** 3)} GB.`);
    const open = await this.prisma.video.count({ where: { channelId: channel.id, status: 'UPLOADING' } });
    if (open >= 20) throw new ConflictException('Finish or cancel your unfinished uploads first.');
    const title = body.fileName.slice(0, body.fileName.length - ext.length).replace(/[_]+/g, ' ').trim().slice(0, 100) || 'Untitled video';
    const video = await this.prisma.video.create({ data: { channelId: channel.id, title, status: 'UPLOADING', visibility: 'PRIVATE', sourceSizeBytes: BigInt(body.sizeBytes), processingStage: 'Uploading' } });
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
    return { videoId: video.id, title, partSize: this.config.media.partBytes, partCount: Math.ceil(body.sizeBytes / this.config.media.partBytes) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Upload state, for resuming: the parts already stored' })
  async state(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const v = await this.mine(auth, id);
    if (v.status !== 'UPLOADING' || !v.uploadId) return { videoId: v.id, status: v.status, parts: [] };
    const key = v.sourceFileS3Key!;
    const parts = await this.storage.listParts(key, v.uploadId).catch(async (error: unknown) => {
      if (await this.storage.head(key)) return [];
      throw error;
    });
    const assembled = parts.length === 0 && (await this.storage.head(key))?.size === Number(v.sourceSizeBytes);
    return { videoId: v.id, status: v.status, assembled, sizeBytes: Number(v.sourceSizeBytes), partSize: this.config.media.partBytes, parts };
  }

  @Post(':id/parts')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed addresses to upload parts to (valid one hour)' })
  async parts(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PartNumbersDto) {
    const v = await this.mine(auth, id);
    if (v.status !== 'UPLOADING' || !v.uploadId) throw new ConflictException('This upload is already finished.');
    const max = Math.ceil(Number(v.sourceSizeBytes) / this.config.media.partBytes);
    if (body.partNumbers.some((n) => n > max)) throw new BadRequestException('Part number out of range.');
    const entries = await Promise.all([...new Set(body.partNumbers)].map(async (n) =>
      [n, await this.storage.partUrl(v.sourceFileS3Key!, v.uploadId!, n, 3600)] as const,
    ));
    return { urls: Object.fromEntries(entries) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish the upload and start processing' })
  async complete(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CompleteDto, @Req() req: AppRequest) {
    const v = await this.mine(auth, id);
    if (v.status === 'PROCESSING' || v.status === 'READY') return { videoId: v.id, status: v.status };
    if (v.status !== 'UPLOADING' || !v.uploadId) throw new ConflictException('This upload is already finished.');
    const expected = Math.ceil(Number(v.sourceSizeBytes) / this.config.media.partBytes);
    const key = v.sourceFileS3Key!;
    let stored = await this.storage.head(key);
    if (!stored) {
      const parts = body.parts ?? await this.storage.listParts(key, v.uploadId).catch(async (error: unknown) => {
        stored = await this.storage.head(key);
        if (stored) return [];
        throw error;
      });
      const numbers = new Set(parts.map((p) => p.partNumber));
      if (!stored && (parts.length !== expected || numbers.size !== expected || [...numbers].some((n) => n > expected))) throw new BadRequestException(`Upload all ${expected} parts first.`);
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
      await this.prisma.video.update({ where: { id: v.id }, data: { status: 'FAILED', uploadId: null, processingStage: 'Failed', processingError: 'The uploaded file is incomplete. Upload it again.' } });
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
      const latest = await this.mine(auth, id);
      if (latest.status === 'PROCESSING' || latest.status === 'READY') return { videoId: v.id, status: latest.status };
      throw new ConflictException('This upload is already finished.');
    }
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
    if (v.uploadId) await this.storage.abortMultipart(v.sourceFileS3Key!, v.uploadId);
    await this.prisma.video.delete({ where: { id: v.id } });
    return { cancelled: true };
  }
}
