import { Body, Controller, Delete, Get, HttpCode, Inject, OnModuleDestroy, OnModuleInit, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { createPushSender, pushTo, setPushSender, vapidKeys } from './push';

class KeysDto { @ApiProperty() @IsString() @MaxLength(200) p256dh!: string; @ApiProperty() @IsString() @MaxLength(100) auth!: string }
class SubscribeDto {
  @ApiProperty({ description: 'From PushSubscription.toJSON() in the browser' }) @IsUrl({ protocols: ['https'], require_tld: false }) @MaxLength(1000) endpoint!: string;
  @ApiProperty({ type: KeysDto }) @ValidateNested() @Type(() => KeysDto) keys!: KeysDto;
}
class EndpointDto { @ApiProperty() @IsString() @MaxLength(1000) endpoint!: string }

/** Notifications on this phone or computer (Web Push): new videos, replies and lives from Spaces you follow. */
@ApiTags('notifications')
@Controller('push')
export class PushController implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly prisma: PrismaService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}
  onModuleInit() { setPushSender(createPushSender(this.prisma, this.config)); }
  onModuleDestroy() { setPushSender(null); }

  @Get('key')
  @ApiOperation({ summary: 'The public key browsers subscribe with (VAPID)' })
  async key() { return { publicKey: (await vapidKeys(this.prisma, this.config)).publicKey }; }

  @Post('subscriptions')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn on notifications on this device' })
  async subscribe(@CurrentAuth() auth: AuthContext, @Body() body: SubscribeDto, @Req() req: AppRequest) {
    const data = { userId: auth.user.id, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null, failures: 0 };
    // A device belongs to whoever signed in on it last.
    await this.prisma.pushSubscription.upsert({ where: { endpoint: body.endpoint }, create: { endpoint: body.endpoint, ...data }, update: data });
    return { subscribed: true };
  }

  @Delete('subscriptions')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn off notifications on this device' })
  async unsubscribe(@CurrentAuth() auth: AuthContext, @Body() body: EndpointDto) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: auth.user.id } });
    return { subscribed: false };
  }

  @Post('test')
  @RequireAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a test notification to my devices' })
  async test(@CurrentAuth() auth: AuthContext) {
    const devices = await this.prisma.pushSubscription.count({ where: { userId: auth.user.id } });
    pushTo([auth.user.id], { title: 'Free Me', body: 'Notifications are on. You will hear about new videos, replies and lives here.', url: '/', tag: 'test' });
    return { devices };
  }
}
