import { BadRequestException, Controller, Delete, HttpCode, Inject, NotFoundException, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { STORAGE } from '../media/queue';
import type { Storage } from '../media/storage';
import { feedsChanged } from '../catalog/feed-cache';

const IMAGE: Array<[string, number[], string]> = [['image/jpeg', [0xff, 0xd8, 0xff], '.jpg'], ['image/png', [0x89, 0x50, 0x4e, 0x47], '.png'], ['image/webp', [0x52, 0x49, 0x46, 0x46], '.webp']];
const MAX_BYTES = 2 * 1024 * 1024;

/** Reads an image request body (JPEG, PNG or WebP, by its first bytes, not its name), up to 2 MB. */
async function readImage(req: AppRequest) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) { size += c.length; if (size > MAX_BYTES) throw new BadRequestException('The image must be 2 MB or smaller.'); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  const kind = IMAGE.find(([, magic]) => magic.every((b, i) => buf[i] === b));
  if (!kind || (kind[0] === 'image/webp' && buf.subarray(8, 12).toString() !== 'WEBP')) throw new BadRequestException('Use a JPEG, PNG or WebP image.');
  return { buf, type: kind[0], ext: kind[2] };
}

type Slot = 'profile-avatar' | 'channel-avatar' | 'channel-banner';

/**
 * Pictures: the profile picture (shown with comments), and a Space's avatar and banner. Stored on the public CDN
 * prefix under a new name each time (so caches never show the old one), and the previous file is removed.
 */
@ApiTags('me')
@Controller()
@RequireAuth()
export class ImagesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(STORAGE) private readonly storage: Storage, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private folder(slot: Slot, ownerId: string) {
    return slot === 'profile-avatar' ? `profiles/${ownerId}/avatar/` : slot === 'channel-avatar' ? `channels/${ownerId}/avatar/` : `channels/${ownerId}/banner/`;
  }

  /** Saves the image in the slot's folder and removes what was there before; returns its public address. */
  private async store(slot: Slot, ownerId: string, req: AppRequest) {
    const img = await readImage(req);
    const folder = `pub/${this.folder(slot, ownerId)}`;
    const old = await this.storage.list(folder).catch(() => []);
    const name = `${Date.now()}${img.ext}`;
    await this.storage.putBuffer(folder + name, img.buf, { contentType: img.type, cacheControl: 'public, max-age=31536000, immutable' });
    for (const k of old) await this.storage.deletePrefix(k).catch(() => undefined);
    return `${this.config.media.publicBaseUrl}/${this.folder(slot, ownerId)}${name}`;
  }

  private async clear(slot: Slot, ownerId: string) {
    await this.storage.deletePrefix(`pub/${this.folder(slot, ownerId)}`).catch(() => undefined);
  }

  private async myChannel(auth: AuthContext) {
    const ch = await this.prisma.channel.findUnique({ where: { userId: auth.user.id } });
    if (!ch) throw new NotFoundException('Create your Space first.');
    return ch;
  }

  @Put('me/avatar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set the profile picture: a JPEG, PNG or WebP image as the request body, up to 2 MB (square, 400x400 or more, works best)' })
  async profileAvatar(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const url = await this.store('profile-avatar', auth.user.id, req);
    await this.prisma.profile.upsert({ where: { userId: auth.user.id }, create: { userId: auth.user.id, displayName: auth.user.email.split('@')[0], avatarUrl: url }, update: { avatarUrl: url } });
    await this.audit.record({ userId: auth.user.id, action: 'PROFILE_UPDATED', entityType: 'User', entityId: auth.user.id, req, details: { fields: ['avatarUrl'] } });
    return { avatarUrl: url };
  }

  @Delete('me/avatar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove the profile picture' })
  async removeProfileAvatar(@CurrentAuth() auth: AuthContext) {
    await this.clear('profile-avatar', auth.user.id);
    await this.prisma.profile.updateMany({ where: { userId: auth.user.id }, data: { avatarUrl: null } });
    return { avatarUrl: null };
  }

  @Put('channels/mine/avatar')
  @HttpCode(200)
  @ApiOperation({ summary: "Set the Space's picture: a JPEG, PNG or WebP image as the request body, up to 2 MB (square works best)" })
  async channelAvatar(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const ch = await this.myChannel(auth);
    const url = await this.store('channel-avatar', ch.id, req);
    await this.prisma.channel.update({ where: { id: ch.id }, data: { avatarUrl: url } });
    await this.audit.record({ userId: auth.user.id, action: 'CHANNEL_UPDATED', entityType: 'Channel', entityId: ch.id, req, details: { fields: ['avatarUrl'] } });
    await feedsChanged();
    return { avatarUrl: url };
  }

  @Delete('channels/mine/avatar')
  @HttpCode(200)
  @ApiOperation({ summary: "Remove the Space's picture (its first letter shows instead)" })
  async removeChannelAvatar(@CurrentAuth() auth: AuthContext) {
    const ch = await this.myChannel(auth);
    await this.clear('channel-avatar', ch.id);
    await this.prisma.channel.update({ where: { id: ch.id }, data: { avatarUrl: null } });
    await feedsChanged();
    return { avatarUrl: null };
  }

  @Put('channels/mine/banner')
  @HttpCode(200)
  @ApiOperation({ summary: "Set the Space's banner: a JPEG, PNG or WebP image as the request body, up to 2 MB (2560x427, 6:1, works best)" })
  async channelBanner(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const ch = await this.myChannel(auth);
    const url = await this.store('channel-banner', ch.id, req);
    await this.prisma.channel.update({ where: { id: ch.id }, data: { bannerUrl: url } });
    await this.audit.record({ userId: auth.user.id, action: 'CHANNEL_UPDATED', entityType: 'Channel', entityId: ch.id, req, details: { fields: ['bannerUrl'] } });
    return { bannerUrl: url };
  }

  @Delete('channels/mine/banner')
  @HttpCode(200)
  @ApiOperation({ summary: "Remove the Space's banner" })
  async removeChannelBanner(@CurrentAuth() auth: AuthContext) {
    const ch = await this.myChannel(auth);
    await this.clear('channel-banner', ch.id);
    await this.prisma.channel.update({ where: { id: ch.id }, data: { bannerUrl: null } });
    return { bannerUrl: null };
  }
}
