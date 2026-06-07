// WordVault service worker
// Responsibilities: PWA offline shell + receive Web Push + route taps back into the review flow.

const CACHE_NAME = 'wordvault-v1';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon-192.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for navigations so the app updates itself; cache as a fallback when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push ──
// Payload sent by the Supabase Edge Function is JSON:
//   single word due:  { title, body, data: { type:'review_word', wordId } }
//   many words due:   { title, body, data: { type:'review_due' } }
self.addEventListener('push', (event) => {
  let payload = { title: 'WordVault', body: '有單字到複習時間了！' };
  if (event.data) {
    try { payload = event.data.json(); }
    catch (e) { payload.body = event.data.text() || payload.body; }
  }

  const data = payload.data || {};
  const options = {
    body: payload.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.wordId ? `review-${data.wordId}` : 'review-due',
    renotify: true,
    data,
  };

  event.waitUntil(self.registration.showNotification(payload.title || 'WordVault', options));
});

// ── Notification tap ──
// Try to focus & message an already-open tab first; otherwise open a fresh one with a query
// param the page already knows how to read (see `?review=` handling in index.html).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const message = data.wordId
    ? { type: 'REVIEW_WORD', wordId: data.wordId }
    : { type: 'REVIEW_DUE' };
  const fallbackUrl = data.wordId ? `./?review=${encodeURIComponent(data.wordId)}` : './?review=due';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if (new URL(client.url).origin === self.location.origin) {
        client.postMessage(message);
        return client.focus();
      }
    }
    return self.clients.openWindow(fallbackUrl);
  })());
});
