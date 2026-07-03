/* Maverick service worker — caches static assets only.
   IMPORTANT: never handle navigation requests or redirect-able responses here, or Safari throws
   "Response served by service worker has redirections" (our '/' 302→/login auth redirect). */
const CACHE = 'maverick-v5';
const ASSETS = ['/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Let the browser handle: navigations (so auth redirects work), non-GET, cross-origin, and API/auth.
  if (req.mode === 'navigate') return;
  if (req.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/connect/')) return;

  // Network-first for our own static assets (so updates land immediately); fall back to cache offline.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === 'basic' && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
