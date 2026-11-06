import { BadRequestException, Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { mask } from '../billing/settings';
import { GOOGLE_OAUTH, type GoogleOAuth } from './google.service';
import { GOOGLE_CLIENT_ID, loadGoogleSettings, saveGoogleSettings } from './google-settings';

class GoogleDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ example: '1234-abcd.apps.googleusercontent.com' }) @IsOptional() @IsString() @MaxLength(200) clientId?: string;
  @ApiPropertyOptional({ description: 'Leave out to keep the saved secret' }) @IsOptional() @IsString() @MaxLength(200) clientSecret?: string;
}

/** Administration → Sign-in: Google keys set in the app (no server files to edit), the secret stored encrypted. */
@ApiTags('admin')
@Controller('admin/auth/google')
@RequireAuth('ADMIN')
export class AdminGoogleController {
  constructor(private readonly prisma: PrismaService, @Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(GOOGLE_OAUTH) private readonly google: GoogleOAuth, private readonly audit: AuditService) {}

  private async view() {
    const saved = await loadGoogleSettings(this.prisma, this.config);
    await this.google.refresh?.();
    const env = this.config.google;
    return {
      source: saved !== undefined ? 'app' : env ? 'environment' : 'none',
      active: this.google.enabled,
      enabled: saved ? saved.enabled : !!env,
      clientId: saved?.clientId || env?.clientId || '',
      clientSecret: mask(saved?.clientSecret || env?.clientSecret),
      // What to paste into Google Cloud Console → Credentials → OAuth client (Web application).
      origin: this.config.appUrl,
      redirectUri: `${this.config.appUrl}/api/auth/google/callback`,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Google sign-in settings (secret masked)' })
  get() { return this.view(); }

  @Put()
  @ApiOperation({ summary: 'Save Google sign-in keys and switch it on or off' })
  async save(@CurrentAuth() auth: AuthContext, @Body() body: GoogleDto, @Req() req: AppRequest) {
    const saved = await loadGoogleSettings(this.prisma, this.config);
    const clientId = (body.clientId ?? saved?.clientId ?? this.config.google?.clientId ?? '').trim();
    const clientSecret = (body.clientSecret?.trim() || saved?.clientSecret || this.config.google?.clientSecret || '').trim();
    const enabled = body.enabled ?? saved?.enabled ?? true;
    if (enabled) {
      if (!GOOGLE_CLIENT_ID.test(clientId)) throw new BadRequestException('The Client ID ends in .apps.googleusercontent.com. Copy it from Google Cloud Console → Credentials.');
      if (clientSecret.length < 10) throw new BadRequestException('Enter the Client secret from the same Google OAuth client.');
    }
    await saveGoogleSettings(this.prisma, this.config, { enabled, clientId, clientSecret }, auth.user.id);
    await this.google.refresh?.(true);
    await this.audit.record({ userId: auth.user.id, action: 'SETTINGS_CHANGED', entityType: 'AppSetting', entityId: 'google', req, details: { enabled } });
    return this.view();
  }
}
