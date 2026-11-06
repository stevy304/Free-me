import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { normalizeEmail } from '@free-me/shared';
import { PrismaService } from '../database/prisma.service';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { AuditService } from '../common/audit.service';
import { RateLimitService } from '../common/rate-limit.service';
import { clientIp, type AppRequest } from '../common/request';
import { AccountsService } from './accounts.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { GOOGLE_OAUTH, OAuthStateCookie, safeReturnPath, type GoogleOAuth } from './google.service';
import { RequestCodeDto, VerifyCodeDto } from './auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly oauthCookie: OAuthStateCookie;
  private readonly redirectUri: string;
  private readonly secure: boolean;

  constructor(
    private readonly prisma: PrismaService, private readonly otp: OtpService, private readonly accounts: AccountsService,
    private readonly sessions: SessionService, private readonly audit: AuditService, private readonly limits: RateLimitService,
    @Inject(GOOGLE_OAUTH) private readonly google: GoogleOAuth, @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.oauthCookie = new OAuthStateCookie(config.sessionSecret);
    // Google returns to the web origin; the web app forwards /api/* to this API, so cookies stay first-party.
    this.redirectUri = `${config.appUrl}/api/auth/google/callback`;
    this.secure = config.appUrl.startsWith('https://');
  }

  @Get('providers')
  @ApiOperation({ summary: 'Sign-in methods this server offers' })
  async providers() { await this.google.refresh?.(); return { google: this.google.enabled, emailCode: true }; }

  @Post('email/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a one-time sign-in code (creates the account on first sign-in)' })
  async requestCode(@Body() body: RequestCodeDto, @Req() req: Request) {
    const email = normalizeEmail(body.email);
    if (!email) throw new BadRequestException('Enter a valid email address.');
    await this.otp.request(email, clientIp(req));
    return { sent: true, email };
  }

  @Post('email/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with the emailed code; sets the session cookie' })
  async verifyCode(@Body() body: VerifyCodeDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const email = normalizeEmail(body.email);
    if (!email) throw new BadRequestException('Enter a valid email address.');
    await this.otp.verify(email, body.code.trim(), clientIp(req));
    const { user, created } = await this.accounts.signInEmail(email, req);
    const session = await this.sessions.create(user.id, 'email_otp', req, res);
    await this.audit.record({ userId: user.id, action: 'SIGN_IN', entityType: 'Session', entityId: session.id, req, details: { method: 'email_otp' } });
    return { signedIn: true, newAccount: created };
  }

  @Get('google')
  @ApiOperation({ summary: 'Start Google sign-in (redirects to Google)' })
  async googleStart(@Query('returnTo') returnTo: string | undefined, @Req() req: Request, @Res() res: Response) {
    const ip = clientIp(req);
    if (ip) await this.limits.consume(`google:start:${ip}`, 30, 600);
    await this.google.refresh?.();
    if (!this.google.enabled) return res.redirect(303, `/login?error=google_unavailable`);
    const { payload, value } = this.oauthCookie.issue(safeReturnPath(returnTo));
    res.cookie(OAuthStateCookie.name, value, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/api/auth/google', maxAge: 10 * 60_000 });
    const codeChallenge = createHash('sha256').update(payload.verifier).digest('base64url');
    return res.redirect(303, this.google.authorizationUrl({ state: payload.state, nonce: payload.nonce, codeChallenge, redirectUri: this.redirectUri }));
  }

  @Get('google/callback')
  @ApiOperation({ summary: 'Google returns here; signs in and redirects back into the app' })
  async googleCallback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Req() req: Request, @Res() res: Response) {
    const saved = this.oauthCookie.read(req.cookies?.[OAuthStateCookie.name]);
    res.clearCookie(OAuthStateCookie.name, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/api/auth/google' });
    const fail = (why: string) => res.redirect(303, `/login?error=${why}`);
    if (error) return fail(error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    if (!saved || !code || !state || state !== saved.state) return fail('google_expired');
    let profile;
    await this.google.refresh?.();
    try { profile = await this.google.exchange({ code, codeVerifier: saved.verifier, redirectUri: this.redirectUri }); } catch { return fail('google_failed'); }
    if (profile.nonce !== saved.nonce) return fail('google_failed');
    const email = normalizeEmail(profile.email);
    if (!email || !profile.emailVerified) return fail('google_unverified');

    // Link by Google's stable account id first, then by verified email (same person, same account).
    const linked = await this.prisma.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: 'google', providerAccountId: profile.sub } }, include: { user: true } });
    let userId: string;
    let created = false;
    try {
      const r = await this.accounts.signInEmail(linked?.user.email ?? email, req, { displayName: profile.name, avatarUrl: profile.picture });
      userId = r.user.id; created = r.created;
    } catch { return fail('account_suspended'); }
    if (linked) await this.prisma.oAuthAccount.update({ where: { id: linked.id }, data: { lastUsedAt: new Date(), email } });
    else {
      await this.prisma.oAuthAccount.create({ data: { userId, provider: 'google', providerAccountId: profile.sub, email } });
      await this.audit.record({ userId, action: 'GOOGLE_LINKED', entityType: 'User', entityId: userId, req });
    }
    const session = await this.sessions.create(userId, 'google', req, res);
    await this.audit.record({ userId, action: 'SIGN_IN', entityType: 'Session', entityId: session.id, req, details: { method: 'google', newAccount: created } });
    return res.redirect(303, saved.returnTo);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out of this device' })
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (req.auth) {
      await this.sessions.revoke(req.auth.session.id);
      await this.audit.record({ userId: req.auth.user.id, action: 'SIGN_OUT', entityType: 'Session', entityId: req.auth.session.id, req });
    }
    this.sessions.clearCookie(res);
    return { signedOut: true };
  }
}
