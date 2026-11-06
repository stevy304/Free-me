/* Free Me service worker: lets the app be installed, shows a friendly page offline, keeps the app's own files
   (scripts, styles, fonts, icons) for faster starts, and shows push notifications. Videos are never cached here. */
const VERSION = 'fm-v1';
const OFFLINE = '/offline';
const STATIC = `${VERSION}-static`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll([OFFLINE, '/free-me.svg', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // API, media and other sites: straight to the network
  // Pages: always fresh from the network; the offline page when there is none.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  // Build files never change under the same name: cache first.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname === '/free-me.svg') {
    event.respondWith(caches.open(STATIC).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  }
});

/* Push notifications: { title, body, url, tag, icon } sent by the Free Me server. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Free Me';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '', tag: data.tag, renotify: !!data.tag, icon: data.icon || '/icons/icon-192.png', badge: '/icons/maskable-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if (w.url === target && 'focus' in w) return w.focus();
    const any = wins.find((w) => 'navigate' in w);
    if (any) return any.navigate(target).then((w) => w && w.focus());
    return self.clients.openWindow(target);
  }));
});
