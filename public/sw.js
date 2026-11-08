'use strict';
/**
 * sw.js - service worker: makes the page load instantly and lets it be installed like an app.
 *
 * It caches ONLY this app's own files (page, timetable data.json, icons). It deliberately does NOT touch:
 *   - api/...         live data (Node server mode) must always come from the network
 *   - map tiles       OpenStreetMap forbids offline/bulk tile storage; the browser's normal HTTP cache is enough
 * Note: browsers only run service workers on https:// or http://localhost.
 */
const CACHE_NAME = 'penang-bus-v7';
const APP_FILES = ['./', 'index.html', 'backend.js', 'data.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'lib/geo.js', 'lib/gtfsrt.js', 'lib/core.js', 'lib/geocoder.js', 'lib/feed.js', 'lib/usage.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Remove caches from older versions of the app.
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});

// "Stale-while-revalidate": answer instantly from the cache, and refresh the cache in the background
// so the NEXT open gets the newest page/timetable.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const refresh = fetch(event.request).then((response) => { if (response.ok) cache.put(event.request, response.clone()); return response; }).catch(() => cached);
      return cached || refresh;
    })
  );
});
