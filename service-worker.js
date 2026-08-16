'use strict';
/* GeoCam service worker — offline app-shell caching.
   Bump CACHE_NAME every time app.js/index.html/style.css/manifest.json
   change, in lockstep with APP_BUILD in app.js, so the diagnostics panel's
   build number and the cache actually in use can never silently disagree. */

const CACHE_NAME = 'geocam-cache-v4';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for same-origin app-shell requests (so a fresh deploy is
// picked up as soon as it's reachable), falling back to cache when offline.
// Cross-origin requests (map tiles, Nominatim, etc.) are passed straight
// through to the network — this app never caches those.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return; // let the browser handle it normally
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
