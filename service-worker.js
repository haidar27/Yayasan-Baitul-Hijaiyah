const CACHE_NAME = 'yayasan-baitul-hijaiyah-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(response => {
      const copy = response.clone();
      if (new URL(req.url).origin === location.origin) {
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match('./index.html')))
  );
});