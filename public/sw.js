// Medreach service worker – makes the app installable and usable offline.
// App shell + shared AI engines are cached, so an emergency can still be
// understood and hospitals suggested (from the last saved status) without
// internet. API calls are network-first with a cached fallback.

const VERSION = 'medreach-v5';
const SHELL = [
  '/', '/index.html', '/report', '/report.html', '/login', '/login.html', '/citizen', '/citizen.html', '/hospital', '/hospital.html',
  '/css/app.css', '/css/ui.css', '/manifest.webmanifest', '/icons/icon.svg',
  '/img/hero.svg', '/img/citizens.svg', '/img/hospital.svg', '/img/alone.svg', '/img/ambulance.svg',
  '/js/app.js', '/js/api.js', '/js/i18n.js', '/js/voice.js', '/js/vision.js', '/js/ocr.js', '/js/map.js', '/js/livemap.js', '/js/hospital.js',
  '/js/icons.js', '/js/landing.js', '/js/login.js', '/js/citizen.js', '/js/citizen-store.js',
  '/shared/triage.js', '/shared/matching.js', '/shared/predict.js', '/shared/capabilities.js', '/shared/ocr-parse.js',
  '/shared/freshness.js', '/shared/roles.js', '/shared/handover.js',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/stream')) return; // never cache live streams
  if (url.pathname.startsWith('/downloads/')) return; // big files: straight from the network
  if (url.hostname.endsWith('project-osrm.org')) return; // routing must be fresh

  const networkFirst = url.origin === location.origin;
  if (networkFirst) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/report.html'))),
    );
    return;
  }
  // CDN assets & map tiles: cache-first (tiles viewed once stay available offline).
  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
      return res;
    })),
  );
});
