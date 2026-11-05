import { normalizeEmail } from '@free-me/shared';

/**
 * Configuration from environment variables, checked once at start-up. A missing or unsafe setting stops the API
 * with a message that names it, instead of failing later on a user's request.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Public origin of the web app (https://freeme.example). Cookies, redirects and the CSRF check use it. */
  appUrl: string;
  /** Extra origins allowed to send state-changing requests (comma-separated), e.g. a staging web app. */
  extraOrigins: string[];
  databaseUrl: string;
  redisUrl: string | null;
  /** 32+ random characters; signs the short-lived OAuth state cookie and keys the sign-in code hashes. */
  sessionSecret: string;
  sessionTtlDays: number;
  google: { clientId: string; clientSecret: string } | null;
  mail: { transport: 'smtp' | 'console' | 'memory'; from: string; smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string } | null };
  /** Accounts that are administrators (their email addresses). Applied each time they sign in. */
  adminEmails: string[];
  /** Number of proxies in front of the API (Caddy = 1), so client IPs come from X-Forwarded-For. */
  trustProxy: number;
  docsEnabled: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const nodeEnv = (env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development') as AppConfig['nodeEnv'];
  const prod = nodeEnv === 'production';
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) problems.push(`${k} is required.`); return v ?? ''; };

  const appUrl = (env.APP_URL?.trim() || (prod ? '' : 'http://localhost:3000')).replace(/\/+$/, '');
  if (!appUrl) problems.push('APP_URL is required (the public address of the web app).');
  else if (!/^https?:\/\/[^/]+$/.test(appUrl)) problems.push('APP_URL must be an origin such as https://freeme.example, without a path.');
  else if (prod && !appUrl.startsWith('https://')) problems.push('APP_URL must use https in production.');

  const databaseUrl = need('DATABASE_URL');
  const sessionSecret = env.SESSION_SECRET?.trim() || (prod ? '' : 'development-only-session-secret-change-me-0000');
  if (sessionSecret.length < 32) problems.push('SESSION_SECRET must have at least 32 characters.');
  if (prod && /development-only/.test(sessionSecret)) problems.push('SESSION_SECRET must be set in production.');

  const googleId = env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!!googleId !== !!googleSecret) problems.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.');

  const transport = (env.MAIL_TRANSPORT?.trim() || (env.SMTP_HOST ? 'smtp' : prod ? 'smtp' : 'console')) as AppConfig['mail']['transport'];
  if (!['smtp', 'console', 'memory'].includes(transport)) problems.push('MAIL_TRANSPORT must be smtp, console or memory.');
  if (prod && transport !== 'smtp') problems.push('Production sends sign-in codes by SMTP: set SMTP_HOST (MAIL_TRANSPORT=console only prints codes, for development).');
  const smtp = transport === 'smtp'
    ? { host: need('SMTP_HOST'), port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true' || env.SMTP_PORT === '465', user: env.SMTP_USER || undefined, pass: env.SMTP_PASS || undefined }
    : null;
  const from = env.MAIL_FROM?.trim() || (prod ? '' : 'Free Me <no-reply@localhost>');
  if (!from) problems.push('MAIL_FROM is required, e.g. "Free Me <no-reply@freeme.example>".');

  const adminEmails = (env.ADMIN_EMAILS ?? '').split(',').map((e) => normalizeEmail(e)).filter((e): e is string => !!e);
  const extraOrigins = (env.EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

  if (problems.length) throw new ConfigError(`Free Me API configuration:\n- ${problems.join('\n- ')}`);
  return {
    nodeEnv, port: Number(env.PORT || 4000), appUrl, extraOrigins, databaseUrl, redisUrl: env.REDIS_URL?.trim() || null, sessionSecret,
    sessionTtlDays: Math.min(90, Math.max(1, Number(env.SESSION_TTL_DAYS || 30))),
    google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
    mail: { transport, from, smtp }, adminEmails, trustProxy: Number(env.TRUST_PROXY ?? (prod ? 1 : 0)),
    docsEnabled: env.API_DOCS === 'true' || (!prod && env.API_DOCS !== 'false'),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
