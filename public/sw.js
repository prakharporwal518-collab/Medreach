// Medreach service worker – makes the app installable and usable offline.
// App shell + shared AI engines are cached, so an emergency can still be
// understood and hospitals suggested (from the last saved status) without
// internet. Only PUBLIC API data (hospital list, config) is ever cached –
// patient, case and staff responses never touch the cache.

const VERSION = 'medreach-v14';
const SHELL = [
  '/', '/index.html', '/report', '/report.html', '/login', '/login.html', '/citizen', '/citizen.html', '/hospital', '/hospital.html',
  '/css/app.css', '/css/ui.css', '/css/home.css', '/manifest.webmanifest', '/icons/icon.svg',
  '/img/hero.svg', '/img/citizens.svg', '/img/hospital.svg', '/img/alone.svg', '/img/ambulance.svg',
  '/img/home/hero.jpg', '/img/home/ambulance.jpg', '/img/home/beds.jpg', '/img/home/doctor.jpg', '/img/home/blood.jpg',
  '/img/home/equipment.jpg', '/img/home/hospital.jpg',
  '/js/app.js', '/js/api.js', '/js/i18n.js', '/js/voice.js', '/js/vision.js', '/js/ocr.js', '/js/map.js', '/js/livemap.js', '/js/hospital.js',
  '/js/icons.js', '/js/call-help.js', '/js/landing.js', '/js/login.js', '/js/citizen.js', '/js/citizen-store.js',
  '/shared/triage.js', '/shared/matching.js', '/shared/predict.js', '/shared/capabilities.js', '/shared/ocr-parse.js',
  '/shared/freshness.js', '/shared/roles.js', '/shared/handover.js', '/shared/geo.js', '/shared/aadhaar.js', '/shared/sms.js', '/shared/ems.js',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
];

const PUBLIC_API = ['/api/hospitals', '/api/ambulances', '/api/config'];

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

  const sameOrigin = url.origin === location.origin;
  if (sameOrigin && url.pathname.startsWith('/api/')) {
    if (!PUBLIC_API.includes(url.pathname)) return; // private data: network only, never cached
  }
  if (sameOrigin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
          return res;
        })
        .catch(() => caches.match(request, { ignoreSearch: request.mode === 'navigate' })
          .then((hit) => hit || (request.mode === 'navigate' ? caches.match('/report.html') : Response.error()))),
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
