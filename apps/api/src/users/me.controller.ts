import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { isCountryCode, isLanguageCode } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { SessionService } from '../auth/session.service';
import { UpdateProfileDto } from './users.dto';
import { ownAccount } from './serialize';

const validTimeZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

@ApiTags('me')
@Controller('me')
@RequireAuth()
export class MeController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sessions: SessionService) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in account, profile and channel' })
  async me(@CurrentAuth() auth: AuthContext) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id }, include: { profile: true, channel: true } });
    return ownAccount(u);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update the profile' })
  async updateProfile(@CurrentAuth() auth: AuthContext, @Body() body: UpdateProfileDto, @Req() req: AppRequest) {
    const data: Record<string, string | null> = {};
    if (body.displayName !== undefined) { const v = body.displayName.trim(); if (!v) throw new BadRequestException('A display name cannot be empty.'); data.displayName = v; }
    if (body.bio !== undefined) data.bio = body.bio.trim() || null;
    if (body.country !== undefined) {
      if (body.country !== null && !isCountryCode(body.country)) throw new BadRequestException('Choose a country from the list.');
      data.country = body.country?.toUpperCase() ?? null;
    }
    if (body.city !== undefined) data.city = body.city?.trim() || null;
    if (body.preferredLanguage !== undefined) {
      if (!isLanguageCode(body.preferredLanguage)) throw new BadRequestException('Choose a language from the list.');
      data.preferredLanguage = body.preferredLanguage.toLowerCase();
    }
    if (body.timezone !== undefined) {
      if (body.timezone !== null && !validTimeZone(body.timezone)) throw new BadRequestException('Choose a time zone from the list.');
      data.timezone = body.timezone;
    }
    await this.prisma.profile.upsert({ where: { userId: auth.user.id }, update: data, create: { userId: auth.user.id, displayName: data.displayName ?? auth.user.email.split('@')[0], ...data } });
    await this.audit.record({ userId: auth.user.id, action: 'PROFILE_UPDATED', entityType: 'Profile', entityId: auth.user.id, req, details: { fields: Object.keys(data) } });
    return this.me(auth);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Devices signed in to this account' })
  async listSessions(@CurrentAuth() auth: AuthContext) {
    const rows = await this.prisma.session.findMany({ where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' }, take: 50 });
    return { sessions: rows.map((s) => ({ id: s.id, method: s.method, userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === auth.session.id })) };
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out one device' })
  async revokeSession(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: AppRequest) {
    const s = await this.prisma.session.findFirst({ where: { id, userId: auth.user.id } });
    if (!s) throw new NotFoundException('Session not found.');
    await this.sessions.revoke(id);
    await this.audit.record({ userId: auth.user.id, action: 'SESSION_REVOKED', entityType: 'Session', entityId: id, req });
    return { revoked: true };
  }

  @Delete('sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out every other device' })
  async revokeOthers(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest) {
    const revoked = await this.sessions.revokeAll(auth.user.id, auth.session.id);
    await this.audit.record({ userId: auth.user.id, action: 'SESSIONS_REVOKED', entityType: 'User', entityId: auth.user.id, req, details: { revoked } });
    return { revoked };
  }
}
