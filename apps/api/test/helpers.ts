import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loadConfig } from '../src/config/config';
import { GOOGLE_OAUTH, type GoogleOAuth, type GoogleProfile } from '../src/auth/google.service';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/database/prisma.service';
import { RedisService } from '../src/database/redis.service';

export const WEB = 'http://localhost:3000';

/** Stands in for Google: remembers the nonce it was given and returns the profile the test sets. */
export class FakeGoogle implements GoogleOAuth {
  enabled = true;
  last: { state: string; nonce: string; codeChallenge: string; redirectUri: string } | null = null;
  profile: Omit<GoogleProfile, 'nonce'> = { sub: 'google-sub-1', email: 'aline@example.com', emailVerified: true, name: 'Aline Uwase', picture: 'https://lh3.googleusercontent.com/a/test' };
  nonceOverride: string | null = null;
  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }) { this.last = p; return `https://accounts.google.test/o/oauth2/auth?state=${p.state}`; }
  async exchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleProfile> {
    if (p.code === 'bad') throw new Error('invalid_grant');
    return { ...this.profile, nonce: this.nonceOverride ?? this.last!.nonce };
  }
}

export async function makeApp(opts: { adminEmails?: string[]; google?: GoogleOAuth | 'real'; redis?: boolean; storageDir?: string; env?: Record<string, string> } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: opts.redis === false ? undefined : process.env.REDIS_URL, APP_URL: WEB, MAIL_TRANSPORT: 'memory',
    STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: opts.storageDir ?? `${require('node:os').tmpdir()}/freeme-test-storage`, SCRATCH_DIR: `${require('node:os').tmpdir()}/freeme-test-scratch`, QUEUE_PREFIX: 'fmtest', UPLOAD_PART_MB: '5',
    SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop', ADMIN_EMAILS: (opts.adminEmails ?? []).join(','),
    // Uploads are not limited by the Creator pass unless a test asks (creator-pass tests set it lower).
    CREATOR_FREE_VIDEOS: '1000',
    // No audience needed to join monetisation unless a test asks (the production defaults are YouTube's).
    MONETISE_MIN_WATCH_HOURS: '0', MONETISE_MIN_FOLLOWERS: '0', MONETISE_MIN_MOMENT_VIEWS: '0',
    ...opts.env,
  });
  const google = opts.google ?? Object.assign(new FakeGoogle(), { enabled: false });
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  // 'real': the real Google client (keys from Administration), for settings tests; nothing is sent to Google.
  const mod = await (google === 'real' ? builder : builder.overrideProvider(GOOGLE_OAUTH).useValue(google)).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app, config);
  await app.init();
  const prisma = app.get(PrismaService);
  const mail = app.get(MailService);
  /** Forgets rate-limit counters (in-process when REDIS_URL is not set), to sign in again within a minute. */
  const clearLimits = async () => { const r = app.get(RedisService); if (r.client) await r.client.flushdb(); else (r as any).local.clear(); };
  return { app, http: app.getHttpServer(), prisma, mail, config, clearLimits };
}

/** Empties every table except migrations and reference categories. */
export async function resetDb(prisma: PrismaService) {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'Category')`;
  if (rows.length) await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
}

/** Signs in with an emailed code; returns an agent that carries the session cookie. */
export async function signIn(http: any, mail: MailService, email: string, headers: Record<string, string> = {}) {
  const agent = request.agent(http);
  await agent.post('/api/auth/email/request').set('Origin', WEB).set(headers).send({ email }).expect(200);
  const msg = [...mail.outbox].reverse().find((m) => m.to === email)!;
  const code = /(\d{6})/.exec(msg.subject)![1];
  const res = await agent.post('/api/auth/email/verify').set('Origin', WEB).set(headers).send({ email, code }).expect(200);
  return { agent, code, res };
}
