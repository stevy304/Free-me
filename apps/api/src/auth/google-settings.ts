import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/config';
import { seal, unseal } from '../billing/settings';

/** Google sign-in keys saved in the app (Administration → Sign-in). The secret is stored encrypted. */
export interface GoogleSettings { enabled: boolean; clientId: string; clientSecret: string }
const KEY = 'google';

/** undefined: nothing saved in the app (the environment applies); null: saved but unreadable. */
export async function loadGoogleSettings(prisma: PrismaClient, config: AppConfig): Promise<GoogleSettings | null | undefined> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  if (!row) return undefined;
  const v = row.value as { enabled?: boolean; clientId?: string; clientSecret?: string };
  try { return { enabled: !!v.enabled, clientId: v.clientId ?? '', clientSecret: unseal(config, v.clientSecret) }; } catch { return null; }
}

export async function saveGoogleSettings(prisma: PrismaClient, config: AppConfig, s: GoogleSettings, by: string) {
  const value = { enabled: s.enabled, clientId: s.clientId, clientSecret: s.clientSecret ? seal(config, s.clientSecret) : '' };
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedBy: by }, update: { value, updatedBy: by } });
}

/** A Google OAuth client id looks like 123-abc.apps.googleusercontent.com. */
export const GOOGLE_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
