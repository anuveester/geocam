// IMPORTANT: bump this version string every time you re-upload changed files.
// The old version of this file used a cache-FIRST strategy, which meant once
// your phone had cached index.html/app.js/style.css once, it would keep
// serving that same copy forever — clearing Chrome's "browsing data" doesn't
// touch an installed home-screen PWA's storage, so updates never appeared to
// land. This version fetches from the network FIRST (so you always get the
// latest files the moment you reopen the app while online) and only falls
// back to the cached copy if you're offline.
const CACHE_NAME = 'geocam-cache-v5';
const CORE_ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for our own app shell files, so edits show up immediately;
// falls back to the last cached copy only when there's no network at all.
// Map tiles / geocoding requests are left alone (always go straight to network).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isOwnAsset = url.origin === self.location.origin;
  if (!isOwnAsset) return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
