// Sehat Setu – HTTP server (thin Express adapter over server/api.js).
//
//   Citizen app  (public/index.html)     ──┐
//   Family tracking (index.html?track=)  ──┼──► REST + Server-Sent Events ──► api.js ──► store.js (cases, audit)
//   Hospital console (public/hospital.html)┘                                    │         auth.js  (OTP, roles)
//                                                                              └──────► llm.js   (Claude)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createApi } from './api.js';
import { aiEnabled, aiTriage, aiVision, aiHandover } from './llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 'demo'  → simulated hospital data, OTP shown on screen (no SMS gateway)
// 'live'  → figures only from authorised hospital staff; OTP never returned
export const DATA_MODE = process.env.SEHAT_DATA_MODE === 'live' ? 'live' : 'demo';

export function createApp(store = createStore(), { dataMode = DATA_MODE } = {}) {
  const auth = createAuth({ demoMode: dataMode === 'demo', audit: store.audit });
  const api = createApi({
    store, auth, dataMode,
    ai: { enabled: aiEnabled, triage: aiTriage, vision: aiVision, handover: aiHandover },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' })); // photos for vision are sent as base64
  app.use((req, res, next) => {
    // Basic hardening; HTTPS/TLS is terminated by the hosting platform in deployment.
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });

  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  app.use('/shared', express.static(path.join(root, 'shared')));
  // Map library served from our own origin, so it works (and is cached) on flaky rural networks.
  app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));

  // Live streams (SSE). EventSource can't send headers, so tokens come as query params.
  app.get('/api/stream/*splat', (req, res) => {
    let sub;
    try {
      sub = api.stream(req.path, req.query, (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`));
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (sub.initial) res.write(`event: ${sub.initial[0]}\ndata: ${JSON.stringify(sub.initial[1])}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sub.unsubscribe(); });
  });

  app.all('/api/*splat', async (req, res) => {
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const { status, data } = await api.handle({
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query,
      token: bearer ? bearer[1] : null,
      caseToken: req.get('x-case-token') || null,
    });
    res.status(status).json(data);
  });

  return app;
}

// Start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = createStore();
  if (process.env.SEHAT_SIMULATE === '1') store.startStatusSimulation();
  const port = Number(process.env.PORT || 3000);
  createApp(store).listen(port, (err) => {
    if (err) {
      console.error(`Could not start on port ${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`\n🚑 Sehat Setu running at http://localhost:${port}`);
    console.log(`   Citizen app:      http://localhost:${port}/`);
    console.log(`   Hospital console: http://localhost:${port}/hospital`);
    console.log(`   Data mode:        ${DATA_MODE === 'demo' ? 'DEMO – simulated hospital data, OTP shown on screen' : 'LIVE – staff-verified data only'}`);
    console.log(`   Generative AI:    ${aiEnabled() ? 'Claude enabled' : 'off (set ANTHROPIC_API_KEY to enable) – using offline engines'}\n`);
  });
}
