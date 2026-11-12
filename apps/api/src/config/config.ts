import { normalizeEmail } from '@free-me/shared';

/**
 * Configuration from environment variables, checked once at start-up. A missing or unsafe setting stops the API
 * with a message that names it, instead of failing later on a user's request.
 */
export interface SafetyConfig {
  /** Optional outside matching service: POST { videoId, sha256, md5, durationSeconds, frames: [base64 JPEG] } → { match, label? }. */
  scanUrl: string | null;
  scanToken: string | null;
  timeoutMs: number;
  /** When the scanner cannot be reached: hold the upload (true) or let it through (false, default). */
  failClosed: boolean;
  /** Uploads a day for accounts in their first week. */
  newAccountDailyUploads: number;
}

/** Prices and payment providers (see ENVIRONMENT.md → Payments). Money is in US cents unless named otherwise. */
export interface BillingConfig {
  premiumUsdCents: number;
  adDayUsdCents: number;
  /** What 1,000 ad views cost; a paid day buys `adDayUsdCents * 1000 / adCpmUsdCents` views at most. */
  adCpmUsdCents: number;
  /** Smallest balance a creator can withdraw. */
  payoutMinUsdCents: number;
  payouts?: { rwfPerUsd: number; feeRwf: number } | null;
  payoutSandbox?: { secretKey: string } | null;
  /** MTN MoMo Collections (request to pay). The charge is in `currency`, at `perUsd` units of it for one US dollar. */
  momo: { baseUrl: string; subscriptionKey: string; apiUser: string; apiKey: string; targetEnvironment: string; currency: string; perUsd: number } | null;
  /** Flutterwave Standard checkout (cards worldwide, and mobile money in many countries). Charged in US dollars. */
  flutterwave: { baseUrl: string; secretKey: string; webhookHash: string | null } | null;
}

/** Live streaming (see DEPLOYMENT.md → Live). */
export interface LiveConfig {
  browserLimit: number;
  turn: { urls: string[]; secret: string } | null;
  /** Encoder address shown to creators for OBS and TV encoders, e.g. rtmp://live.freeme.example/live (null: browser only). */
  rtmpUrl: string | null;
  /** Shared secret in nginx-rtmp's on_publish / on_publish_done callback addresses. */
  rtmpSecret: string | null;
  /** Where nginx-rtmp writes HLS (hls_path, with hls_nested on), on the server running the worker. */
  rtmpHlsDir: string | null;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** json: one JSON object per line (production default, for log collectors); text: readable lines. */
  logFormat: 'json' | 'text';
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
  /** Bearer token for /api/metrics and the worker's metrics port (Prometheus); null turns /api/metrics off. */
  metricsToken: string | null;
  /** Port where the worker serves its metrics (bind it to the private network); null: none. */
  workerMetricsPort: number | null;
  /** Address the worker's metrics port listens on: its private network address (default: this machine only). */
  workerMetricsHost: string;
  media: MediaConfig;
  safety: SafetyConfig;
  /** Who runs the service, shown on the legal pages and in notices (see ENVIRONMENT.md). */
  legal: LegalConfig;
  billing: BillingConfig;
  live: LiveConfig;
}

export interface LegalConfig {
  operatorName: string;
  contactEmail: string | null;
  /** Where copyright notices and counter-notices go (also the designated agent's address). */
  copyrightEmail: string | null;
  postalAddress: string | null;
  /** Country whose law governs the Terms, e.g. "Rwanda". */
  jurisdiction: string | null;
}

/** Where videos live and how they are processed (see ENVIRONMENT.md). */
export interface MediaConfig {
  /** s3: any S3-compatible object storage (Hetzner Object Storage, MinIO, ...). local: a folder, for development and tests. */
  driver: 's3' | 'local';
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean } | null;
  localDir: string;
  /** Public base address of the pub/ prefix (the CDN). Local driver: served by the API under /api/storage/local/pub. */
  publicBaseUrl: string;
  maxUploadBytes: number;
  /** Automatic captions with whisper.cpp on the media server; null turns them off. */
  whisper: { bin: string; model: string; threads: number } | null;
  /** Size of each upload part (S3 needs 5 MiB+, at most 10,000 parts). */
  partBytes: number;
  scratchDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** x264 preset: faster presets transcode quicker at a slightly larger size. */
  preset: string;
  /** x264 preset for 1080p and above, the rungs that cost the most CPU. */
  presetHigh: string;
  /** libx264 (CPU), or a GPU encoder: nvenc (NVIDIA) or qsv (Intel Quick Sync). Falls back to libx264 if it fails. */
  encoder: 'libx264' | 'nvenc' | 'qsv';
  /** Use the upload's own H.264 for the top rung when it is already suitable (no re-encoding). */
  copyTopRung: boolean;
  /**
   * Popularity-based encoding: 1080p and above are made only once a video has this many views (Premium creators'
   * uploads get them at once). Most uploads are rarely watched, so their most expensive rungs are never paid for.
   * 0 makes every quality straight away.
   */
  hdMinViews: number;
  /** Highest quality (short side, e.g. 720) in the master playlist free viewers get; 0 = no limit. Premium sees all. */
  freeMaxShort: number;
  workerConcurrency: number;
  upgradeConcurrency: number;
  /** Long videos are encoded in pieces any worker server can take (see media/chunks.ts). */
  chunked: boolean;
  /** Videos at least this long (seconds) are encoded in pieces. */
  chunkMinSeconds: number;
  /** Length of one piece in seconds (even, so keyframes stay on the 2-second grid). */
  chunkSeconds: number;
  /** Pieces one worker process encodes at the same time. */
  chunkConcurrency: number;
  /** BullMQ key prefix (lets tests run beside a real queue). */
  queuePrefix: string;
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
  const metricsToken = env.METRICS_TOKEN?.trim() || null;
  if (metricsToken && metricsToken.length < 24) problems.push('METRICS_TOKEN must have at least 24 characters.');
  const workerMetricsPort = env.WORKER_METRICS_PORT?.trim() ? Number(env.WORKER_METRICS_PORT) : null;
  if (workerMetricsPort !== null && !(Number.isInteger(workerMetricsPort) && workerMetricsPort > 0 && workerMetricsPort < 65536)) problems.push('WORKER_METRICS_PORT must be a port number.');
  if (workerMetricsPort !== null && !metricsToken) problems.push('WORKER_METRICS_PORT needs METRICS_TOKEN.');
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

  const driver = (env.STORAGE_DRIVER?.trim() || (prod ? 's3' : 'local')) as MediaConfig['driver'];
  if (!['s3', 'local'].includes(driver)) problems.push('STORAGE_DRIVER must be s3 or local.');
  if (prod && driver !== 's3') problems.push('Production stores videos in object storage: set STORAGE_DRIVER=s3 and the S3_* variables.');
  const s3 = driver === 's3'
    ? { endpoint: need('S3_ENDPOINT'), region: env.S3_REGION?.trim() || 'us-east-1', bucket: need('S3_BUCKET'), accessKeyId: need('S3_ACCESS_KEY'), secretAccessKey: need('S3_SECRET_KEY'), forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false' }
    : null;
  const mib = (k: string, d: number) => Math.round((Number(env[k]) > 0 ? Number(env[k]) : d) * 1024 * 1024);
  const partBytes = mib('UPLOAD_PART_MB', 16);
  if (partBytes < 5 * 1024 * 1024) problems.push('UPLOAD_PART_MB must be at least 5.');
  const maxUploadBytes = mib('MAX_UPLOAD_MB', 20 * 1024);
  if (Math.ceil(maxUploadBytes / partBytes) > 10_000) problems.push('MAX_UPLOAD_MB / UPLOAD_PART_MB must not exceed 10,000 parts.');
  const publicBaseUrl = (env.MEDIA_PUBLIC_BASE_URL?.trim() || (driver === 'local' ? `${appUrl}/api/storage/local/pub` : '')).replace(/\/+$/, '');
  if (driver === 's3' && !publicBaseUrl) problems.push('MEDIA_PUBLIC_BASE_URL is required (the CDN address of the pub/ prefix).');
  const presets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
  for (const k of ['TRANSCODE_PRESET', 'TRANSCODE_PRESET_HIGH']) if (env[k]?.trim() && !presets.includes(env[k]!.trim())) problems.push(`${k} must be one of ${presets.join(', ')}.`);
  if (env.VIDEO_ENCODER?.trim() && !['libx264', 'nvenc', 'qsv'].includes(env.VIDEO_ENCODER.trim())) problems.push('VIDEO_ENCODER must be libx264, nvenc or qsv.');
  const count = (k: string, d: number) => { const v = env[k]?.trim(); if (!v) return d; const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) { problems.push(`${k} must be a whole number of 0 or more.`); return d; } return n; };
  const hdMinViews = count('HD_MIN_VIEWS', 100);
  const freeMaxShort = count('FREE_MAX_QUALITY', 720);
  if (freeMaxShort && ![144, 240, 360, 480, 720, 1080, 1440, 2160].includes(freeMaxShort)) problems.push('FREE_MAX_QUALITY must be 0 (no limit) or one of 144, 240, 360, 480, 720, 1080, 1440, 2160.');
  const media: MediaConfig = {
    driver, s3, localDir: env.LOCAL_STORAGE_DIR?.trim() || './.data/storage', publicBaseUrl, maxUploadBytes, partBytes,
    scratchDir: env.SCRATCH_DIR?.trim() || '/tmp/freeme-scratch', ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg', ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    preset: env.TRANSCODE_PRESET?.trim() || 'veryfast', presetHigh: env.TRANSCODE_PRESET_HIGH?.trim() || 'superfast',
    copyTopRung: env.COPY_TOP_RUNG !== 'false',
    hdMinViews, freeMaxShort,
    chunked: env.CHUNKED_ENCODING !== 'false', chunkMinSeconds: Math.max(10, Number(env.CHUNK_MIN_SECONDS) || 120),
    chunkSeconds: Math.max(4, Math.round((Number(env.CHUNK_SECONDS) || 30) / 2) * 2), chunkConcurrency: Math.max(1, Number(env.CHUNK_CONCURRENCY) || 1),
    encoder: (['nvenc', 'qsv'].includes(env.VIDEO_ENCODER?.trim() ?? '') ? env.VIDEO_ENCODER!.trim() : 'libx264') as MediaConfig['encoder'], workerConcurrency: Math.max(1, Number(env.WORKER_CONCURRENCY) || 2), upgradeConcurrency: Math.max(1, Math.floor(Number(env.WORKER_UPGRADE_CONCURRENCY) || 1)), queuePrefix: env.QUEUE_PREFIX?.trim() || 'fm',
    whisper: env.WHISPER_CPP_PATH?.trim() && env.WHISPER_MODEL?.trim()
      ? { bin: env.WHISPER_CPP_PATH.trim(), model: env.WHISPER_MODEL.trim(), threads: Math.max(1, Number(env.WHISPER_THREADS) || 4) } : null,
  };
  if (!!env.WHISPER_CPP_PATH?.trim() !== !!env.WHISPER_MODEL?.trim()) problems.push('Set both WHISPER_CPP_PATH and WHISPER_MODEL for automatic captions, or neither.');
  if (prod && !env.REDIS_URL) problems.push('REDIS_URL is required in production (rate limits, video jobs and view counts).');

  const email = (k: string) => { const v = env[k]?.trim(); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) problems.push(`${k} must be an email address.`); return v || null; };
  const legal: LegalConfig = {
    operatorName: env.LEGAL_OPERATOR_NAME?.trim() || 'Free Me', contactEmail: email('LEGAL_CONTACT_EMAIL'), copyrightEmail: email('COPYRIGHT_EMAIL'),
    postalAddress: env.LEGAL_POSTAL_ADDRESS?.trim() || null, jurisdiction: env.LEGAL_JURISDICTION?.trim() || null,
  };

  const cents = (k: string, d: number) => { const v = env[k]?.trim(); if (!v) return d; const n = Number(v); if (!Number.isInteger(n) || n < 1) problems.push(`${k} must be a whole number of US cents (e.g. 1000 for $10).`); return n; };
  const momoKeys = ['MOMO_SUBSCRIPTION_KEY', 'MOMO_API_USER', 'MOMO_API_KEY'];
  const momoSet = momoKeys.filter((k) => env[k]?.trim());
  if (momoSet.length && momoSet.length < momoKeys.length) problems.push(`Set all of ${momoKeys.join(', ')} for MTN MoMo, or none.`);
  const momoCurrency = (env.MOMO_CURRENCY?.trim() || 'RWF').toUpperCase();
  const perUsd = Number(env.MOMO_RATE_PER_USD);
  if (momoSet.length && momoCurrency !== 'USD' && !(perUsd > 0)) problems.push(`MOMO_RATE_PER_USD is required: how many ${momoCurrency} make one US dollar (prices are set in dollars).`);
  const payoutRate = Number(env.PAYOUT_RWF_PER_USD || 0);
  const payoutFee = Number(env.PAYOUT_FEE_RWF || 0);
  if (!Number.isSafeInteger(payoutRate) || payoutRate < 0 || payoutRate > 1_000_000) problems.push('PAYOUT_RWF_PER_USD must be a whole number from 1 to 1000000, or unset.');
  if (!Number.isSafeInteger(payoutFee) || payoutFee < 0 || payoutFee > 1_000_000) problems.push('PAYOUT_FEE_RWF must be a whole number from 0 to 1000000.');
  const payoutTestKey = env.FLW_PAYOUT_TEST_KEY?.trim() || null;
  if (payoutTestKey && !payoutTestKey.startsWith('FLWSECK_TEST-')) problems.push('FLW_PAYOUT_TEST_KEY must be a Flutterwave TEST key.');
  const billing: BillingConfig = {
    premiumUsdCents: cents('PREMIUM_PRICE_USD_CENTS', 1000), adDayUsdCents: cents('AD_PRICE_PER_DAY_USD_CENTS', 300), adCpmUsdCents: cents('AD_CPM_USD_CENTS', 100), payoutMinUsdCents: cents('PAYOUT_MINIMUM_USD_CENTS', 1000),
    payouts: payoutRate > 0 ? { rwfPerUsd: payoutRate, feeRwf: payoutFee } : null,
    payoutSandbox: payoutTestKey ? { secretKey: payoutTestKey } : null,
    momo: momoSet.length === momoKeys.length ? {
      baseUrl: (env.MOMO_BASE_URL?.trim() || 'https://sandbox.momodeveloper.mtn.com').replace(/\/+$/, ''), subscriptionKey: env.MOMO_SUBSCRIPTION_KEY!.trim(),
      apiUser: env.MOMO_API_USER!.trim(), apiKey: env.MOMO_API_KEY!.trim(), targetEnvironment: env.MOMO_TARGET_ENVIRONMENT?.trim() || 'sandbox',
      currency: momoCurrency, perUsd: momoCurrency === 'USD' ? 1 : perUsd,
    } : null,
    flutterwave: env.FLW_SECRET_KEY?.trim() ? { baseUrl: (env.FLW_BASE_URL?.trim() || 'https://api.flutterwave.com').replace(/\/+$/, ''), secretKey: env.FLW_SECRET_KEY.trim(), webhookHash: env.FLW_WEBHOOK_HASH?.trim() || null } : null,
  };

  const rtmpUrl = env.LIVE_RTMP_URL?.trim() || null;
  if (rtmpUrl && !/^rtmps?:\/\/[^/]+\/.+/.test(rtmpUrl)) problems.push('LIVE_RTMP_URL must look like rtmp://live.freeme.example/live.');
  const rtmpSecret = env.LIVE_RTMP_SECRET?.trim() || null;
  if (rtmpUrl && (!rtmpSecret || rtmpSecret.length < 24)) problems.push('LIVE_RTMP_SECRET (24+ random characters) is required with LIVE_RTMP_URL.');
  const browserLimit = Number(env.LIVE_BROWSER_LIMIT ?? 3);
  if (!Number.isInteger(browserLimit) || browserLimit < 1) problems.push('LIVE_BROWSER_LIMIT must be a positive integer.');
  const turnUrls = (env.LIVE_TURN_URLS ?? '').split(',').map((url) => url.trim()).filter(Boolean);
  const turnSecret = env.LIVE_TURN_SECRET?.trim() || '';
  if (turnUrls.some((url) => !/^turns?:[^\s]+$/.test(url))) problems.push('LIVE_TURN_URLS must contain TURN URLs.');
  if ((turnUrls.length && turnSecret.length < 24) || (!turnUrls.length && turnSecret)) problems.push('Configure LIVE_TURN_URLS together with a LIVE_TURN_SECRET of at least 24 characters.');
  const turn = turnUrls.length ? { urls: turnUrls, secret: turnSecret } : null;
  const live: LiveConfig = { turn, browserLimit, rtmpUrl, rtmpSecret, rtmpHlsDir: env.LIVE_RTMP_HLS_DIR?.trim() || null };

  if (problems.length) throw new ConfigError(`Free Me API configuration:\n- ${problems.join('\n- ')}`);
  return {
    nodeEnv, port: Number(env.PORT || 4000), logFormat: env.LOG_FORMAT === 'json' || (prod && env.LOG_FORMAT !== 'text') ? 'json' : 'text', appUrl, extraOrigins, databaseUrl, redisUrl: env.REDIS_URL?.trim() || null, sessionSecret,
    sessionTtlDays: Math.min(90, Math.max(1, Number(env.SESSION_TTL_DAYS || 30))),
    google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
    mail: { transport, from, smtp }, adminEmails, trustProxy: Number(env.TRUST_PROXY ?? (prod ? 1 : 0)), metricsToken, workerMetricsPort, workerMetricsHost: env.WORKER_METRICS_HOST?.trim() || '127.0.0.1',
    docsEnabled: env.API_DOCS === 'true' || (!prod && env.API_DOCS !== 'false'),
    media, legal, billing, live,
    safety: {
      scanUrl: env.SAFETY_SCAN_URL?.trim() || null, scanToken: env.SAFETY_SCAN_TOKEN?.trim() || null,
      timeoutMs: Math.max(1000, Number(env.SAFETY_SCAN_TIMEOUT_MS) || 60_000), failClosed: env.SAFETY_SCAN_FAIL_CLOSED === 'true',
      newAccountDailyUploads: Math.max(1, Number(env.NEW_ACCOUNT_DAILY_UPLOADS) || 5),
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
