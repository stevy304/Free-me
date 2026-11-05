import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { AppRequest, AuthContext } from './request';

const AUTH_KEY = 'fm:auth';
/** The route needs a signed-in, active account; with roles, at least one of them. */
export const RequireAuth = (...roles: Role[]) => SetMetadata(AUTH_KEY, { roles });

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const rule = this.reflector.getAllAndOverride<{ roles: Role[] } | undefined>(AUTH_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!rule) return true;
    const auth = ctx.switchToHttp().getRequest<AppRequest>().auth;
    if (!auth) throw new UnauthorizedException('Sign in to continue.');
    if (auth.user.status !== 'ACTIVE') throw new ForbiddenException('This account is not active.');
    if (rule.roles.length && !rule.roles.some((r) => auth.user.roles.includes(r))) throw new ForbiddenException('You do not have permission to do this.');
    return true;
  }
}

/** The signed-in account (routes with @RequireAuth), or null on public routes. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext | null => ctx.switchToHttp().getRequest<AppRequest>().auth ?? null);
