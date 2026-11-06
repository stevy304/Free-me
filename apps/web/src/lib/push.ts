'use client';

import { api } from './client-api';

/** Phone and computer notifications (Web Push) for this device. */
export type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
/** The worker is registered by the app shell in production; wait for it a short while. */
async function registration() {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return 'off';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function turnOnPush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const reg = await registration();
  if (!reg) throw new Error('Notifications need the Free Me app: reload the page and try again.');
  const { publicKey } = await api<{ publicKey: string }>('/push/key');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot receive: replace it.
  if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey.replace(/=+$/, '')) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api('/push/subscriptions', { body: { endpoint: json.endpoint, keys: json.keys } });
  return 'on';
}

export async function turnOffPush(): Promise<PushState> {
  const reg = supported() ? await navigator.serviceWorker.getRegistration('/') : null;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return 'off';
}

export const sendTestPush = () => api<{ devices: number }>('/push/test', { body: {} });
