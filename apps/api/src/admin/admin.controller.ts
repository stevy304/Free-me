import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsString } from 'class-validator';
import type { Role, UserStatus } from '@prisma/client';
import { ROLES } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentAuth, RequireAuth } from '../common/auth.guard';
import type { AppRequest, AuthContext } from '../common/request';
import { SessionService } from '../auth/session.service';

class SetRolesDto { @ApiProperty({ example: ['VIEWER', 'MODERATOR'] }) @IsArray() @ArrayMaxSize(5) @IsIn(ROLES, { each: true }) roles!: Role[] }
class SetStatusDto { @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) @IsString() @IsIn(['ACTIVE', 'SUSPENDED']) status!: UserStatus }

@ApiTags('admin')
@Controller('admin')
@RequireAuth('ADMIN')
export class AdminController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sessions: SessionService) {}

  @Get('users')
  @ApiOperation({ summary: 'Find accounts (administrators only)' })
  async users(@Query('q') q?: string, @Query('cursor') cursor?: string) {
    const rows = await this.prisma.user.findMany({
      where: q ? { OR: [{ email: { contains: q.trim(), mode: 'insensitive' } }, { profile: { displayName: { contains: q.trim(), mode: 'insensitive' } } }, { channel: { handle: { contains: q.trim().replace(/^@/, '').toLowerCase() } } }] } : {},
      orderBy: { createdAt: 'desc' }, take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { profile: true, channel: true },
    });
    return {
      users: rows.slice(0, 50).map((u) => ({ id: u.id, email: u.email, roles: u.roles, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, displayName: u.profile?.displayName ?? null, channelHandle: u.channel?.handle ?? null })),
      nextCursor: rows.length > 50 ? rows[49].id : null,
    };
  }

  @Patch('users/:id/roles')
  @ApiOperation({ summary: 'Set an account\'s roles (recorded in the audit log)' })
  async setRoles(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetRolesDto, @Req() req: AppRequest) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: { channel: { select: { id: true } } } });
    if (!user) throw new NotFoundException('Account not found.');
    const roles = [...new Set<Role>(['VIEWER', ...body.roles])];
    if (id === auth.user.id && !roles.includes('ADMIN')) throw new BadRequestException('You cannot remove your own administrator role.');
    if (user.channel && !roles.includes('CREATOR')) roles.push('CREATOR');
    const updated = await this.prisma.user.update({ where: { id }, data: { roles: { set: roles } } });
    await this.audit.record({ userId: auth.user.id, action: 'ROLES_CHANGED', entityType: 'User', entityId: id, req, details: { before: user.roles, after: updated.roles } });
    return { id, roles: updated.roles };
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend or reactivate an account; suspension signs it out everywhere' })
  async setStatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetStatusDto, @Req() req: AppRequest) {
    if (id === auth.user.id) throw new BadRequestException('You cannot change your own status.');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Account not found.');
    const updated = await this.prisma.user.update({ where: { id }, data: { status: body.status } });
    const signedOut = body.status === 'SUSPENDED' ? await this.sessions.revokeAll(id) : 0;
    await this.audit.record({ userId: auth.user.id, action: body.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_REACTIVATED', entityType: 'User', entityId: id, req, details: { before: user.status, signedOut } });
    return { id, status: updated.status, signedOut };
  }

  @Get('audit')
  @ApiOperation({ summary: 'Latest audit log entries' })
  async auditLog(@Query('cursor') cursor?: string) {
    const rows = await this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 101, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { user: { select: { email: true } } } });
    return { entries: rows.slice(0, 100).map(({ user, ...e }) => ({ ...e, actorEmail: user?.email ?? null })), nextCursor: rows.length > 100 ? rows[99].id : null };
  }
}
