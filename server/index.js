// Sehat Setu – API server.
//
//   Citizen app  (public/index.html)    ──┐
//                                         ├──► REST + Server-Sent Events ──► store (cases, hospitals, ambulances)
//   Hospital console (public/hospital.html)┘                               └─► llm.js (Claude) / shared/*.js (offline engines)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { aiEnabled, aiTriage, aiVision, aiHandover, templateHandover } from './llm.js';
import { triage as ruleTriage } from '../shared/triage.js';
import { rankHospitals, explain, publicHospital } from '../shared/matching.js';
import { forecastArrivals } from '../shared/predict.js';
import { DEMO_LOCATION } from './data/hospitals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export function createApp(store = createStore()) {
  const app = express();
  app.use(express.json({ limit: '8mb' })); // photos for vision are sent as base64

  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  app.use('/shared', express.static(path.join(root, 'shared')));
  // Map library served from our own origin, so it works (and is cached) on flaky rural networks.
  app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  // ------------------------------------------------------------ config
  app.get('/api/config', (req, res) => {
    res.json({
      ai: aiEnabled(),
      demoLocation: DEMO_LOCATION,
      emergencyNumber: '108',
      simulatedHospitalResponse: true,
    });
  });

  // ------------------------------------------------------------ 🧠 AI understands
  app.post('/api/triage', wrap(async (req, res) => {
    const { text = '', lang = 'en', answers = {}, hintType = null, visionFindings = '' } = req.body || {};
    if (!text.trim() && !hintType) return res.status(400).json({ error: 'describe the emergency or pick a type' });
    const combined = visionFindings ? `${text}\n${visionFindings}` : text;
    const rule = ruleTriage(combined, { lang, answers, hintType });
    const result = await aiTriage({ text, lang, answers, visionFindings, ruleResult: rule });
    res.json(result);
  }));

  // 📷 Computer vision on an injury photo (Claude vision). The browser also
  // runs an on-device quick check, used when this returns ai:false.
  app.post('/api/vision', wrap(async (req, res) => {
    const { image, lang = 'en' } = req.body || {};
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(image || '');
    if (!m) return res.status(400).json({ error: 'send image as a base64 data URL' });
    if (!aiEnabled()) return res.json({ ai: false });
    const out = await aiVision({ imageBase64: m[2], mediaType: m[1], lang });
    res.json({ ai: out?.engine === 'claude-vision', ...out });
  }));

  // ------------------------------------------------------------ 🏥 find suitable hospitals
  app.get('/api/hospitals', (req, res) => {
    res.json(store.hospitals.map(publicHospital));
  });

  app.post('/api/match', wrap(async (req, res) => {
    const { triage, location, mode = 'ambulance', lang = 'en', excludeIds = [] } = req.body || {};
    if (!triage?.required || !Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
      return res.status(400).json({ error: 'triage and location {lat,lng} are required' });
    }
    const pool = store.hospitals.filter((h) => !excludeIds.includes(h.id));
    const result = rankHospitals(triage, location, pool, { mode });
    for (const o of [...result.options, ...(result.stabilise ? [result.stabilise] : [])]) o.reasons = explain(o, lang);
    res.json(result);
  }));

  // ------------------------------------------------------------ cases
  app.post('/api/cases', wrap(async (req, res) => {
    const { triage, location, patient, contact, lang, vision, text } = req.body || {};
    if (!triage || !location) return res.status(400).json({ error: 'triage and location are required' });
    const c = store.createCase({ triage, location, patient, contact, lang, vision, text });
    res.status(201).json(store.view(c));
  }));

  app.get('/api/cases/:id', wrap(async (req, res) => {
    const c = store.getCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'case not found' });
    res.json(store.view(c));
  }));

  // 🏥 ask the hospital to confirm acceptance (with an AI pre-arrival note)
  app.post('/api/cases/:id/request', wrap(async (req, res) => {
    const c = store.getCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'case not found' });
    const { hospitalId, option } = req.body || {};
    const draft = { ...c, bedType: option?.bedType, etaMin: option?.etaMin };
    // Send immediately with the template note; upgrade it with AI in the background.
    store.requestAdmission(c.id, { hospitalId, option, handover: { text: templateHandover(draft), engine: 'template' } });
    res.json(store.view(c));
    if (aiEnabled()) {
      const handover = await aiHandover(draft);
      if (c.hospitalId === hospitalId) {
        c.handover = handover;
        store.publish(`hospital:${hospitalId}`, 'case', store.view(c));
      }
    }
  }));

  app.post('/api/cases/:id/transport', wrap(async (req, res) => {
    res.json(store.view(store.startTransport(req.params.id, { mode: req.body?.mode })));
  }));

  app.post('/api/cases/:id/position', wrap(async (req, res) => {
    const { lat, lng, etaMin } = req.body || {};
    res.json({ ok: true, status: store.updatePosition(req.params.id, { lat, lng, etaMin }).status });
  }));

  app.post('/api/cases/:id/arrived', wrap(async (req, res) => {
    res.json(store.view(store.arrive(req.params.id)));
  }));

  // ------------------------------------------------------------ hospital console
  app.post('/api/hospitals/:id/cases/:caseId/respond', wrap(async (req, res) => {
    const { accept, reason, bay } = req.body || {};
    res.json(store.view(store.respond(req.params.caseId, req.params.id, { accept: Boolean(accept), reason, bay })));
  }));

  app.patch('/api/hospitals/:id/status', wrap(async (req, res) => {
    res.json(publicHospital(store.updateHospitalStatus(req.params.id, req.body || {})));
  }));

  app.get('/api/hospitals/:id/dashboard', wrap(async (req, res) => {
    const h = store.getHospital(req.params.id);
    if (!h) return res.status(404).json({ error: 'hospital not found' });
    const cases = [...store.cases.values()].filter((c) => c.hospitalId === h.id).map(store.view);
    res.json({ hospital: publicHospital(h), cases, forecast: forecastArrivals(h, 8) });
  }));

  // ------------------------------------------------------------ live streams (SSE)
  function stream(channel, initial) {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const ch = channel(req);
      const init = initial?.(req);
      if (init) res.write(`event: ${init.event}\ndata: ${JSON.stringify(init.data)}\n\n`);
      const unsubscribe = store.subscribe(ch, res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); unsubscribe(); });
    };
  }
  app.get('/api/stream/case/:id', stream((req) => `case:${req.params.id}`, (req) => {
    const c = store.getCase(req.params.id);
    return c ? { event: 'case', data: store.view(c) } : null;
  }));
  app.get('/api/stream/hospital/:id', stream((req) => `hospital:${req.params.id}`));
  app.get('/api/stream/hospitals', stream(() => 'hospitals'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

// Start the server when run directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = createStore();
  if (process.env.SEHAT_SIMULATE !== '0') store.startStatusSimulation();
  const port = Number(process.env.PORT || 3000);
  createApp(store).listen(port, (err) => {
    if (err) {
      console.error(`Could not start on port ${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`\n🚑 Sehat Setu running at http://localhost:${port}`);
    console.log(`   Citizen app:      http://localhost:${port}/`);
    console.log(`   Hospital console: http://localhost:${port}/hospital`);
    console.log(`   Generative AI:    ${aiEnabled() ? 'Claude enabled' : 'off (set ANTHROPIC_API_KEY to enable) – using offline engines'}\n`);
  });
}
