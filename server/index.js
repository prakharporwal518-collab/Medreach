// Medreach – HTTP server (thin Express adapter over server/api.js).
//
//   Citizen app  (public/index.html)     ──┐
//   Family tracking (index.html?track=)  ──┼──► REST + Server-Sent Events ──► api.js ──► store.js (cases, audit)
//   Hospital console (public/hospital.html)┘                                    │         auth.js  (OTP, roles)
//                                                                              └──────► llm.js   (Claude or Gemini)

import { cleanEnv, isOn } from './env.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createApi } from './api.js';
import { createCitizenAuth } from './citizen-auth.js';
import { createHash } from 'node:crypto';
import { createEmsClient, emsEnabled, verifySignature } from './ems.js';
import { createSmsSender, verifySmsRequest } from './sms.js';
import { createPracticeCad } from './practice-cad.js';
import { aiEnabled, aiProvider, aiTriage, aiVision, aiHandover } from './llm.js';
import { createVault } from './vault.js';
import { roadRoute, routingEnabled } from './routing.js';
import { securityHeaders, rateLimiter, DEFAULT_LIMITS } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 'demo'  → simulated hospital data, OTP shown on screen (no SMS gateway)
// 'live'  → figures only from authorised hospital staff; OTP never returned
export const DATA_MODE = process.env.SEHAT_DATA_MODE === 'live' ? 'live' : 'demo';

export function productionStore() {
  return createStore({
    vault: createVault(),
    routeFn: routingEnabled() ? roadRoute : null,
    ems: createEmsClient({ url: process.env.SEHAT_EMS_URL, secret: process.env.SEHAT_EMS_SECRET }),
  });
}

// Citizen tokens and Aadhaar references are keyed from SEHAT_DATA_KEY, so they
// stay valid across restarts; without it a random key is used per start.
export function citizenSecret(dataKey = process.env.SEHAT_DATA_KEY) {
  return dataKey ? createHash('sha256').update(`medreach-citizen-v1|${dataKey}`).digest() : null;
}

export function createApp(store = productionStore(), {
  dataMode = DATA_MODE, limits = DEFAULT_LIMITS,
  citizenAuth = createCitizenAuth({ demoMode: dataMode === 'demo', secret: citizenSecret() }),
  env = process.env,
  smsSender = createSmsSender({ url: env.SEHAT_SMS_SEND_URL, token: env.SEHAT_SMS_SEND_TOKEN }),
} = {}) {
  const auth = createAuth({ demoMode: dataMode === 'demo', audit: store.audit });
  cleanEnv(env);
  const practiceOn = isOn(env.SEHAT_PRACTICE_CAD) && Boolean(env.SEHAT_EMS_SECRET);
  const api = createApi({
    store, auth, dataMode, citizenAuth, smsSender,
    integrations: {
      emsLive: emsEnabled(env),
      emsPractice: practiceOn && String(env.SEHAT_EMS_URL || '').includes('/api/practice-cad/'),
      smsNumber: env.SEHAT_SMS_NUMBER || null,
      publicUrl: env.SEHAT_PUBLIC_URL || env.RENDER_EXTERNAL_URL || '',
    },
    ai: { enabled: aiEnabled, triage: aiTriage, vision: aiVision, handover: aiHandover },
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // real client IP behind Render's proxy, for rate limits
  app.use(securityHeaders);
  app.use(rateLimiter(limits));
  // Which practice-control-room setting is missing (yes/no only – never the values).
  app.get('/api/practice-cad/status', (_req, res) => {
    const url = String(env.SEHAT_EMS_URL || '');
    res.json({
      on: practiceOn,
      checks: {
        SEHAT_PRACTICE_CAD: isOn(env.SEHAT_PRACTICE_CAD),
        SEHAT_EMS_SECRET: Boolean(env.SEHAT_EMS_SECRET),
        SEHAT_EMS_URL: url.includes('/api/practice-cad/incidents'),
      },
    });
  });

  // Practice 108 control room (stands in for the real one; same signed contract both ways).
  if (practiceOn) {
    const practice = createPracticeCad({
      secret: env.SEHAT_EMS_SECRET,
      callbackUrl: () => env.SEHAT_EMS_CALLBACK_URL || `http://127.0.0.1:${env.PORT || 3000}/api/ems/updates`,
      routeFn: routingEnabled(env) ? roadRoute : null,
      demoSpeed: Number(env.SEHAT_DEMO_SPEED ?? 15),
      autoAssignMs: Number(env.SEHAT_PRACTICE_CAD_ASSIGN_MS ?? 4000),
      manualFallbackMs: Number(env.SEHAT_PRACTICE_CAD_MANUAL_MS ?? 120000),
      tickMs: Number(env.SEHAT_PRACTICE_CAD_TICK_MS ?? 2000),
      dataMode,
      otherKeys: { SEHAT_DATA_KEY: env.SEHAT_DATA_KEY, SEHAT_SMS_SECRET: env.SEHAT_SMS_SECRET },
    });
    app.locals.practiceCad = practice;
    app.use('/api/practice-cad', practice.router);
  }

  // Integrations post signed JSON (108 control room, SMS gateway): keep the raw bytes to check the signature.
  const signedJson = express.json({ limit: '32kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } });
  const sig = (req) => ({ timestamp: req.get('x-medreach-timestamp'), signature: req.get('x-medreach-signature'), rawBody: req.rawBody });

  // 108/102 control room → status of an incident (unit assigned, position, at patient, arrived …).
  app.post('/api/ems/updates', signedJson, (req, res) => {
    if (!env.SEHAT_EMS_SECRET) return res.status(404).json({ error: 'not found' });
    if (!verifySignature(env.SEHAT_EMS_SECRET, sig(req))) return res.status(401).json({ error: 'invalid signature' });
    const c = store.emsUpdate(req.body || {});
    if (!c) return res.status(404).json({ error: 'unknown incident' });
    res.json({ ok: true, caseId: c.id, status: c.status });
  });

  // SMS gateway → an emergency SMS from a phone without mobile data.
  app.post('/api/sms/inbound', signedJson, async (req, res) => {
    if (!env.SEHAT_SMS_SECRET) return res.status(404).json({ error: 'not found' });
    if (!verifySmsRequest(env.SEHAT_SMS_SECRET, { key: req.get('x-medreach-key'), ...sig(req) })) return res.status(401).json({ error: 'invalid signature' });
    const { from, text } = req.body || {};
    try {
      const out = await api.smsEmergency({ from: from ? String(from).slice(0, 20) : null, text: String(text || '') });
      let replySent = false;
      if (smsSender.live && from) { try { replySent = (await smsSender.send(from, out.reply)).sent; } catch { /* gateway may still use the response body */ } }
      res.json({ ok: out.ok, caseId: out.caseId || null, reply: out.reply, replySent });
    } catch {
      res.status(500).json({ ok: false, reply: 'MEDREACH: Something went wrong. CALL 108 NOW.' });
    }
  });

  app.use('/api/vision', express.json({ limit: '8mb' })); // only photos may be large
  app.use(express.json({ limit: '100kb' }));

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
  const store = productionStore();
  if (process.env.SEHAT_SIMULATE === '1') store.startStatusSimulation();
  const port = Number(process.env.PORT || 3000);
  createApp(store).listen(port, (err) => {
    if (err) {
      console.error(`Could not start on port ${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`\n🚑 Medreach running at http://localhost:${port}`);
    console.log(`   Citizen app:      http://localhost:${port}/`);
    console.log(`   Hospital console: http://localhost:${port}/hospital`);
    console.log(`   Data mode:        ${DATA_MODE === 'demo' ? 'DEMO – simulated hospital data, OTP shown on screen' : 'LIVE – staff-verified data only'}`);
    const practice = isOn(process.env.SEHAT_PRACTICE_CAD) && String(process.env.SEHAT_EMS_URL || '').includes('/api/practice-cad/');
    let emsHost = 'invalid SEHAT_EMS_URL';
    try { emsHost = new URL(process.env.SEHAT_EMS_URL).host; } catch { /* reported below */ }
    console.log(`   Ambulance (108):  ${emsEnabled() ? `${practice ? 'PRACTICE control room (signed integration, not the real 108) at' : 'control room at'} ${emsHost}` : 'SIMULATED control room (set SEHAT_EMS_URL + SEHAT_EMS_SECRET)'}`);
    if (isOn(process.env.SEHAT_PRACTICE_CAD) && !process.env.SEHAT_EMS_SECRET) console.log('   ⚠ SEHAT_PRACTICE_CAD is on but SEHAT_EMS_SECRET is empty – practice control room stays off');
    console.log(`   SMS channel:      ${process.env.SEHAT_SMS_SECRET ? `inbound on, outbound ${process.env.SEHAT_SMS_SEND_URL ? 'on' : 'simulated'}${process.env.SEHAT_SMS_NUMBER ? `, number ${process.env.SEHAT_SMS_NUMBER}` : ''}` : 'off (demo simulator only)'}`);
    console.log(`   Citizen sign-in:  ${DATA_MODE === 'demo' ? 'Aadhaar + OTP (simulated UIDAI, OTP shown on screen)' : 'Aadhaar + OTP needs a licensed AUA/KUA provider – not connected'}`);
    console.log(`   Generative AI:    ${aiEnabled() ? `${aiProvider()} enabled` : 'off (set GEMINI_API_KEY or ANTHROPIC_API_KEY) – using offline engines'}`);
    console.log(`   Road routing:     ${routingEnabled() ? 'OSRM (OpenStreetMap roads)' : 'off – straight lines'}`);
    console.log(`   Data encryption:  AES-256-GCM, ${process.env.SEHAT_DATA_KEY ? 'key from SEHAT_DATA_KEY' : 'random key per start (set SEHAT_DATA_KEY to keep one)'}\n`);
  });
}
