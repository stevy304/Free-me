import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/config';
import { seal, unseal } from '../billing/settings';

/**
 * Keys for outside services, entered by an administrator (Administration → Secrets) instead of in the servers'
 * environment. Stored encrypted (AES-256-GCM, key derived from SESSION_SECRET), readable only by the API and
 * worker, and never sent back to a browser: the page only learns whether each one is set. A key set in the
 * environment is used when none was saved here.
 */
export const SECRETS = {
  ANTHROPIC_API_KEY: { label: 'Anthropic API key', purpose: 'The AI moderator (Claude) that decides whether videos, comments and transcripts may be shown', pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: 'Starts with sk-ant-' },
  SAFETY_OPENAI_KEY: { label: 'OpenAI API key', purpose: 'Optional second opinion on pictures (OpenAI moderation model)', pattern: /^sk-[A-Za-z0-9_-]{20,}$/, hint: 'Starts with sk-' },
  SAFETY_SCAN_TOKEN: { label: 'Outside scanner token', purpose: 'Sent to the fingerprint or picture scanner at SAFETY_SCAN_URL (for example a child-safety hash-matching partner)', pattern: /^\S{8,}$/, hint: 'At least 8 characters' },
} as const;
export type SecretName = keyof typeof SECRETS;
export const SECRET_NAMES = Object.keys(SECRETS) as SecretName[];

const KEY = 'secrets';
type Stored = Partial<Record<SecretName, { value: string; updatedAt: string; updatedBy: string }>>;

let cache: { at: number; values: Partial<Record<SecretName, string>> } | null = null;
const TTL_MS = 30_000;

async function stored(prisma: Pick<PrismaClient, 'appSetting'>): Promise<Stored> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  return (row?.value as Stored | undefined) ?? {};
}

/** The value of a secret: saved in the app, else the environment, else null. Kept 30 s in each process. */
export async function secret(prisma: Pick<PrismaClient, 'appSetting'>, config: AppConfig, name: SecretName): Promise<string | null> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const s = await stored(prisma);
    const values: Partial<Record<SecretName, string>> = {};
    for (const n of SECRET_NAMES) {
      try { const v = s[n] ? unseal(config, s[n]!.value) : ''; if (v) values[n] = v; } catch { /* SESSION_SECRET changed since it was saved: treat as not set */ }
    }
    cache = { at: Date.now(), values };
  }
  return cache.values[name] ?? (process.env[name]?.trim() || null);
}

/** What the administration page may know: set or not, where from, when. Never the values. */
export async function secretStatus(prisma: Pick<PrismaClient, 'appSetting'>, config: AppConfig) {
  const s = await stored(prisma);
  return SECRET_NAMES.map((name) => {
    let saved = false;
    try { saved = !!(s[name] && unseal(config, s[name]!.value)); } catch { saved = false; }
    const env = !!process.env[name]?.trim();
    return { name, label: SECRETS[name].label, purpose: SECRETS[name].purpose, hint: SECRETS[name].hint,
      set: saved || env, source: saved ? 'app' as const : env ? 'environment' as const : null, updatedAt: saved ? s[name]!.updatedAt : null };
  });
}

/** Saves the given secrets (others unchanged); an empty string removes one. Returns the names changed. */
export async function saveSecrets(prisma: Pick<PrismaClient, 'appSetting'>, config: AppConfig, values: Partial<Record<SecretName, string>>, by: string): Promise<SecretName[]> {
  const s = await stored(prisma);
  const changed: SecretName[] = [];
  for (const [name, raw] of Object.entries(values) as Array<[SecretName, string]>) {
    const v = raw.trim();
    if (!v) { if (s[name]) { delete s[name]; changed.push(name); } continue; }
    s[name] = { value: seal(config, v), updatedAt: new Date().toISOString(), updatedBy: by };
    changed.push(name);
  }
  if (changed.length) await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: s as object, updatedBy: by }, update: { value: s as object, updatedBy: by } });
  cache = null;
  return changed;
}

export const forgetSecrets = () => { cache = null; };
