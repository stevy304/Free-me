import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { authChanged } from './session-cache';
import type { Request } from 'express';
import { DISPLAY_NAME_MAX, isLanguageCode } from '@free-me/shared';
import type { User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from '../common/audit.service';
import { syncSpacePicture } from '../users/pictures';

/** The first supported language in the browser's Accept-Language header ("fr-CA,fr;q=0.9" → "fr"). */
export function languageFromHeader(header: string | undefined): string {
  for (const part of (header ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (isLanguageCode(tag)) return tag;
    const base = tag.split('-')[0];
    if (isLanguageCode(base)) return base;
  }
  return 'en';
}

/**
 * One account per email address, whichever way the person signs in (Google or an email code). The first sign-in
 * creates the account and its profile; there is no separate registration step.
 */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async signInEmail(email: string, req: Request, extras: { displayName?: string | null; avatarUrl?: string | null } = {}): Promise<{ user: User; created: boolean }> {
    let user = await this.prisma.user.findUnique({ where: { email } });
    let created = false;
    if (!user) {
      const displayName = (extras.displayName?.trim() || email.split('@')[0]).slice(0, DISPLAY_NAME_MAX);
      user = await this.prisma.user.create({ data: {
        email, emailVerifiedAt: new Date(),
        profile: { create: { displayName, avatarUrl: extras.avatarUrl ?? null, preferredLanguage: languageFromHeader(req.headers['accept-language']) } },
      } });
      created = true;
      await this.audit.record({ userId: user.id, action: 'ACCOUNT_CREATED', entityType: 'User', entityId: user.id, req });
    } else if (!user.emailVerifiedAt) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      authChanged(user.id);
    }
    if (user.status !== 'ACTIVE') throw new ForbiddenException('This account is suspended. Contact support if you think this is a mistake.');
    // Administrators are named in configuration (ADMIN_EMAILS), never by a request.
    if (this.config.adminEmails.includes(email) && !user.roles.includes('ADMIN')) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: { roles: { set: [...new Set([...user.roles, 'ADMIN' as const])] } } });
      authChanged(user.id);
      await this.audit.record({ userId: user.id, action: 'ADMIN_GRANTED_BY_CONFIG', entityType: 'User', entityId: user.id, req });
    }
    if (extras.avatarUrl && (await this.prisma.profile.updateMany({ where: { userId: user.id, avatarUrl: null }, data: { avatarUrl: extras.avatarUrl } })).count) await syncSpacePicture(this.prisma, user.id);
    return { user, created };
  }
}
