// Medreach – HTTP hardening: security headers and per-IP rate limits.

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  // The service worker fetches map tiles and fonts on the page's behalf, and a
  // worker's fetches are checked against connect-src (not img-src/font-src).
  "connect-src 'self' https://router.project-osrm.org https://cdn.jsdelivr.net https://tessdata.projectnaptha.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://fonts.googleapis.com https://fonts.gstatic.com data: blob:",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'geolocation=(self), microphone=(self), camera=(self), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  // Nothing from the API may be stored by browsers, proxies or shared devices.
  if (req.path.startsWith('/api/')) res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  next();
}

/**
 * Fixed-window rate limiter keyed by client IP (+ rule name).
 * rules: [{ name, match(req) → bool, max, windowMs }]
 */
export function rateLimiter(rules, now = () => Date.now()) {
  const hits = new Map();
  setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, 60000).unref?.();
  return (req, res, next) => {
    for (const r of rules) {
      if (!r.match(req)) continue;
      const key = `${r.name}|${req.ip}`;
      const t = now();
      let e = hits.get(key);
      if (!e || e.reset <= t) { e = { count: 0, reset: t + r.windowMs }; hits.set(key, e); }
      if (++e.count > r.max) {
        res.set('Retry-After', String(Math.ceil((e.reset - t) / 1000)));
        return res.status(429).json({ error: 'Too many requests – please wait a moment and try again. In an emergency call 108.' });
      }
    }
    next();
  };
}

const post = (re) => (req) => req.method === 'POST' && re.test(req.path);
export const DEFAULT_LIMITS = [
  { name: 'otp', match: post(/^\/api\/auth\/otp$/), max: 8, windowMs: 10 * 60 * 1000 },
  { name: 'verify', match: post(/^\/api\/auth\/verify$/), max: 20, windowMs: 10 * 60 * 1000 },
  { name: 'cases', match: post(/^\/api\/cases$/), max: 30, windowMs: 10 * 60 * 1000 },
  { name: 'sms-demo', match: post(/^\/api\/sms\/demo$/), max: 10, windowMs: 10 * 60 * 1000 },
  { name: 'integrations', match: post(/^\/api\/(ems\/updates|sms\/inbound)$/), max: 600, windowMs: 60 * 1000 },
  { name: 'dispatcher-key', match: post(/^\/api\/practice-cad\/(key-check|incidents\/[^/]+\/(assign|cancel))$/), max: 30, windowMs: 10 * 60 * 1000 },
  { name: 'aadhaar-otp', match: post(/^\/api\/citizen\/otp$/), max: 10, windowMs: 10 * 60 * 1000 },
  { name: 'aadhaar-verify', match: post(/^\/api\/citizen\/verify$/), max: 30, windowMs: 10 * 60 * 1000 },
  { name: 'ai', match: post(/^\/api\/(triage|vision)$/), max: 60, windowMs: 10 * 60 * 1000 },
  { name: 'api', match: (req) => req.path.startsWith('/api/') && !req.path.startsWith('/api/stream/'), max: 600, windowMs: 60 * 1000 },
];
