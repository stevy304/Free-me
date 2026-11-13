import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../database/redis.service';
import { SessionCache, authChanged } from './session-cache';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { clientIp, userAgent, type AuthContext } from '../common/request';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Refresh lastSeenAt at most this often, so reading a session is not a write on every request. */
const TOUCH_MS = 5 * 60_000;

/**
 * Server-side sessions. The browser keeps a random 256-bit token in an HttpOnly cookie; the database keeps only its
 * SHA-256, so a database leak does not hand out working sessions. Sessions slide: each use within the lifetime
 * extends them; revoking (sign out, admin suspension) ends them at once on every server.
 */
@Injectable()
export class SessionService implements OnModuleDestroy {
  readonly cookieName: string;
  private readonly secure: boolean;
  private readonly cache: SessionCache;

  constructor(private readonly prisma: PrismaService, @Inject(APP_CONFIG) private readonly config: AppConfig, redis: RedisService) {
    this.cache = new SessionCache(config.sessionCacheSeconds * 1000, redis.client);
    this.secure = config.appUrl.startsWith('https://');
    // __Host- cookies are bound to this exact origin (Secure, Path=/, no Domain): only possible over https.
    this.cookieName = this.secure ? '__Host-fm_session' : 'fm_session';
  }

  private ttlMs() { return this.config.sessionTtlDays * 86_400_000; }

  async create(userId: string, method: 'google' | 'email_otp', req: Request, res: Response) {
    const token = randomBytes(32).toString('base64url');
    const session = await this.prisma.session.create({ data: {
      tokenHash: sha256(token), userId, method, ipAddress: clientIp(req), userAgent: userAgent(req), expiresAt: new Date(Date.now() + this.ttlMs()),
    } });
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    this.setCookie(res, token);
    return session;
  }

  /** The session behind a cookie, if it is live and its account is not deleted. */
  async resolve(token: string | undefined): Promise<AuthContext | null> {
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const cached = this.cache.get(hash);
    // Expiry is checked on every request, cached or not.
    if (cached) return cached.session.expiresAt.getTime() > Date.now() ? cached : null;
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || session.user.status === 'DELETED') return null;
    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + this.ttlMs()) } });
    }
    const { user, ...rest } = session;
    const ctx = { user, session: rest };
    this.cache.set(hash, ctx);
    return ctx;
  }

  async onModuleDestroy() { await this.cache.close(); }

  async revoke(sessionId: string) {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (s) authChanged(s.userId);
  }

  async revokeAll(userId: string, exceptSessionId?: string) {
    const r = await this.prisma.session.updateMany({ where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) }, data: { revokedAt: new Date() } });
    authChanged(userId);
    return r.count;
  }

  setCookie(res: Response, token: string) {
    res.cookie(this.cookieName, token, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/', maxAge: this.ttlMs() });
  }

  clearCookie(res: Response) {
    res.clearCookie(this.cookieName, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/' });
  }
}
