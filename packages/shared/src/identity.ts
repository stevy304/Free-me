/** Rules shared by the API (validation) and the web app (form hints), so both say the same thing. */

/** Channel handles: 3-30 characters, letters, digits, dots, underscores and hyphens; shown as @handle. */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/;
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
/** Handles nobody can take: routes, roles and the brand. */
export const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'api', 'auth', 'login', 'logout', 'signin', 'signup', 'settings', 'studio', 'help',
  'support', 'about', 'terms', 'privacy', 'freeme', 'free-me', 'free_me', 'official', 'moderator', 'system',
  'root', 'null', 'undefined', 'channel', 'channels', 'watch', 'shorts', 'feed', 'results', 'search', 'upload',
  'advertise', 'ads', 'payments', 'payouts', 'security', 'staff', 'team',
]);

/** Lower-cases and trims a handle the way it is stored; "@Name" and "name" are the same handle. */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

/** Why a handle cannot be used, or null when it can. */
export function handleProblem(input: string): string | null {
  const h = normalizeHandle(input);
  if (h.length < HANDLE_MIN || h.length > HANDLE_MAX) return `A handle has ${HANDLE_MIN} to ${HANDLE_MAX} characters.`;
  if (!HANDLE_PATTERN.test(h)) return 'Use letters, numbers, dots, underscores or hyphens, starting and ending with a letter or number.';
  if (/[._-]{2}/.test(h)) return 'Do not put two dots, underscores or hyphens next to each other.';
  if (RESERVED_HANDLES.has(h)) return 'This handle is reserved.';
  return null;
}

export const DISPLAY_NAME_MAX = 50;
export const BIO_MAX = 1000;
export const CHANNEL_NAME_MAX = 100;
export const CHANNEL_DESCRIPTION_MAX = 5000;

/** Sign-in codes sent by email. */
export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;

/** Roles. Everyone is a VIEWER; CREATOR comes with a channel, ADVERTISER with an advertiser account. */
export const ROLES = ['VIEWER', 'CREATOR', 'ADVERTISER', 'MODERATOR', 'ADMIN'] as const;
export type RoleName = (typeof ROLES)[number];

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
/** Lower-cased, trimmed email, or null when it is not an email address. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const e = input.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}
