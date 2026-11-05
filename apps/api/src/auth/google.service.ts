import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface GoogleProfile { sub: string; email: string; emailVerified: boolean; name: string | null; picture: string | null; nonce: string | null }

/** The Google side of sign-in, behind an interface so tests can stand in for Google. */
export interface GoogleOAuth {
  readonly enabled: boolean;
  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string;
  exchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleProfile>;
}
export const GOOGLE_OAUTH = Symbol('GOOGLE_OAUTH');

/** Google OpenID Connect: authorization code flow with PKCE; the ID token is verified (signature, audience, expiry). */
@Injectable()
export class GoogleOAuthClient implements GoogleOAuth {
  readonly enabled: boolean;
  private readonly client: OAuth2Client | null;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.enabled = !!config.google;
    this.client = config.google ? new OAuth2Client({ clientId: config.google.clientId, clientSecret: config.google.clientSecret }) : null;
  }

  private need() {
    if (!this.client) throw new ServiceUnavailableException('Google sign-in is not set up on this server. Use an email code instead.');
    return this.client;
  }

  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }) {
    return this.need().generateAuthUrl({
      scope: ['openid', 'email', 'profile'], state: p.state, redirect_uri: p.redirectUri, prompt: 'select_account',
      code_challenge: p.codeChallenge, code_challenge_method: CodeChallengeMethod.S256, nonce: p.nonce, access_type: 'online',
    } as Parameters<OAuth2Client['generateAuthUrl']>[0]);
  }

  async exchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleProfile> {
    const client = this.need();
    const { tokens } = await client.getToken({ code: p.code, codeVerifier: p.codeVerifier, redirect_uri: p.redirectUri });
    if (!tokens.id_token) throw new UnauthorizedException('Google did not return an identity.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.google!.clientId });
    const c = ticket.getPayload();
    if (!c?.sub || !c.email) throw new UnauthorizedException('Google did not share an email address.');
    return { sub: c.sub, email: c.email, emailVerified: c.email_verified === true, name: c.name ?? null, picture: c.picture ?? null, nonce: (c as { nonce?: string }).nonce ?? null };
  }
}

/** The short-lived, signed cookie that carries state, PKCE verifier, nonce and return path across the Google round trip. */
export class OAuthStateCookie {
  static readonly name = 'fm_oauth';
  constructor(private readonly secret: string) {}

  issue(returnTo: string) {
    const payload = { state: randomBytes(24).toString('base64url'), verifier: randomBytes(48).toString('base64url'), nonce: randomBytes(24).toString('base64url'), returnTo, exp: Date.now() + 10 * 60_000 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { payload, value: `${body}.${this.sign(body)}` };
  }

  read(value: string | undefined): { state: string; verifier: string; nonce: string; returnTo: string } | null {
    if (!value) return null;
    const [body, sig] = value.split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig); const b = Buffer.from(this.sign(body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      return p.exp > Date.now() ? p : null;
    } catch { return null; }
  }

  private sign(body: string) { return createHmac('sha256', this.secret).update(`oauth-state:${body}`).digest('base64url'); }
}

/** Only same-site paths are allowed as a return address ("/watch?v=1"), never "//evil.example" or a full URL. */
export function safeReturnPath(v: unknown): string {
  return typeof v === 'string' && /^\/(?!\/)[^\s\\]*$/.test(v) && v.length <= 500 ? v : '/';
}
