import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const WEBHOOK = 'fm:webhook';
/** A server-to-server callback (payment providers): no browser origin; the handler checks its own signature. */
export const Webhook = () => SetMetadata(WEBHOOK, true);

/**
 * Cross-site request forgery defence: a request that changes something must come from the web app's own origin
 * (Origin header, or Referer when a browser leaves Origin out). Session cookies are also SameSite=Lax.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowed: Set<string>;
  constructor(@Inject(APP_CONFIG) config: AppConfig, private readonly reflector: Reflector) {
    this.allowed = new Set([config.appUrl, ...config.extraOrigins]);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(WEBHOOK, [ctx.getHandler(), ctx.getClass()])) return true;
    const origin = req.headers.origin ?? (() => { try { return req.headers.referer ? new URL(req.headers.referer).origin : undefined; } catch { return undefined; } })();
    if (origin && this.allowed.has(origin)) return true;
    throw new ForbiddenException('This request must come from the Free Me web app.');
  }
}
