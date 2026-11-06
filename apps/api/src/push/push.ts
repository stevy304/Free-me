import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import webpush, { WebPushError } from 'web-push';
import type { AppConfig } from '../config/config';
import { seal, unseal } from '../billing/settings';

/**
 * Notifications on phones and computers (Web Push): the browser gives a subscription, the server sends small
 * encrypted messages through the browser maker's push service. No keys to configure: this server's VAPID key pair
 * is made the first time it is needed and kept in the database (the private key encrypted).
 */
export interface PushMessage { title: string; body: string; url: string; tag?: string; icon?: string | null }

const log = new Logger('Push');
let sender: ((userIds: string[], msg: PushMessage) => Promise<void>) | null = null;

/** The API and the media worker each install a sender at start; elsewhere (tests without it) nothing is sent. */
export function setPushSender(s: typeof sender) { sender = s; }

/** Sends in the background: never slows down or breaks what caused the notification. */
export function pushTo(userIds: string[], msg: PushMessage) {
  const to = [...new Set(userIds)];
  if (!sender || !to.length) return;
  void sender(to, msg).catch((e) => log.warn(`push: ${(e as Error).message}`));
}

interface Keys { publicKey: string; privateKey: string; subject: string }
let cached: Keys | null = null;

/** The VAPID key pair (made once). */
export async function vapidKeys(prisma: PrismaClient, config: AppConfig): Promise<Keys> {
  if (cached) return cached;
  const subject = config.appUrl.startsWith('https://') ? config.appUrl : `mailto:${/<([^>]+)>/.exec(config.mail.from)?.[1] ?? 'no-reply@localhost'}`;
  const row = await prisma.appSetting.findUnique({ where: { key: 'push' } });
  if (row) {
    const v = row.value as { publicKey: string; privateKey: string };
    try { cached = { publicKey: v.publicKey, privateKey: unseal(config, v.privateKey), subject }; return cached; } catch { /* SESSION_SECRET changed: make new keys */ }
  }
  const k = webpush.generateVAPIDKeys();
  const value = { publicKey: k.publicKey, privateKey: seal(config, k.privateKey) };
  await prisma.appSetting.upsert({ where: { key: 'push' }, create: { key: 'push', value, updatedBy: null }, update: { value } });
  // Subscriptions made with the old key no longer work.
  if (row) await prisma.pushSubscription.deleteMany({});
  cached = { publicKey: k.publicKey, privateKey: k.privateKey, subject };
  return cached;
}

/** Sends to every device of these people, 20 at a time; devices the push service no longer knows are removed. */
export function createPushSender(prisma: PrismaClient, config: AppConfig) {
  return async (userIds: string[], msg: PushMessage) => {
    const keys = await vapidKeys(prisma, config);
    const body = JSON.stringify({ ...msg, icon: msg.icon ?? '/icons/icon-192.png' });
    for (let i = 0; i < userIds.length; i += 500) {
      const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: userIds.slice(i, i + 500) } } });
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(20, subs.length) }, async () => {
        while (next < subs.length) {
          const s = subs[next++];
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
              vapidDetails: keys, TTL: 6 * 3600, urgency: 'normal', ...(msg.tag ? { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
            });
            await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSentAt: new Date(), failures: 0 } }).catch(() => undefined);
          } catch (e) {
            const status = e instanceof WebPushError ? e.statusCode : 0;
            if (status === 404 || status === 410 || s.failures >= 9) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
            else await prisma.pushSubscription.update({ where: { id: s.id }, data: { failures: { increment: 1 } } }).catch(() => undefined);
          }
        }
      }));
    }
  };
}
