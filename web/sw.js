const VERSION = 'development';
// Scope isolates this app from other GitHub Pages projects on the same origin.
const PREFIX = `donut-camera:${self.registration.scope}:`;
const CACHE = PREFIX + VERSION;
const ASSETS = [
  './', './index.html', './styles.css', './app.mjs', './camera.mjs', './geometry.mjs', './photo.mjs',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
].map((path) => new URL(path, self.registration.scope).href);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  // Do not skipWaiting: an update must not replace a session holding a photo.
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.href.startsWith(self.registration.scope) || url.origin !== self.location.origin) return;
  const cacheKey = request.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : url.href;
  // Cache only the known app shell. Photos are never persisted or sent anywhere.
  if (!ASSETS.includes(cacheKey)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (VERSION === 'development') {
      try { return await fetch(request); } catch { return await cache.match(cacheKey); }
    }
    return await cache.match(cacheKey) || fetch(request);
  })());
});
