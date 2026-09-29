// In-browser version of the Sehat Setu backend, used only by the single-file
// demo (demo/sehat-setu-prototype.html). It reuses the real store (cases,
// hospital acceptance, ambulance simulation) and the shared engines, and
// answers the same /api routes as server/index.js – so the real citizen app
// and hospital console run unchanged, without Node.js.

import { createStore } from '../server/store.js';
import { DEMO_LOCATION } from '../server/data/hospitals.js';
import { triage as ruleTriage } from '../shared/triage.js';
import { rankHospitals, explain, publicHospital } from '../shared/matching.js';
import { forecastArrivals } from '../shared/predict.js';
import { templateHandover } from '../shared/handover.js';

const store = createStore({ simulatedResponseMs: 2500, responseTimeoutMs: 45000, demoSpeed: 20 });
store.startStatusSimulation(20000);

// The demo page can hook into requests (e.g. to bring the hospital console forward).
const hooks = { beforeRequest: async () => {}, afterRequest: () => {} };

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(method, path, body) {
  let m;
  if (method === 'GET' && path === '/api/config') {
    return { ai: false, demo: true, demoLocation: DEMO_LOCATION, emergencyNumber: '108', simulatedHospitalResponse: true };
  }
  if (method === 'POST' && path === '/api/triage') {
    const { text = '', lang = 'en', answers = {}, hintType = null, visionFindings = '' } = body;
    if (!text.trim() && !hintType) fail(400, 'describe the emergency or pick a type');
    return ruleTriage(visionFindings ? `${text}\n${visionFindings}` : text, { lang, answers, hintType });
  }
  if (method === 'POST' && path === '/api/vision') return { ai: false };
  if (method === 'GET' && path === '/api/hospitals') return store.hospitals.map(publicHospital);
  if (method === 'POST' && path === '/api/match') {
    const { triage, location, mode = 'ambulance', lang = 'en', excludeIds = [] } = body;
    if (!triage?.required || !Number.isFinite(location?.lat)) fail(400, 'triage and location are required');
    const result = rankHospitals(triage, location, store.hospitals.filter((h) => !excludeIds.includes(h.id)), { mode });
    for (const o of [...result.options, ...(result.stabilise ? [result.stabilise] : [])]) o.reasons = explain(o, lang);
    return result;
  }
  if (method === 'POST' && path === '/api/cases') return store.view(store.createCase(body));
  if (method === 'GET' && (m = path.match(/^\/api\/cases\/([^/]+)$/))) {
    const c = store.getCase(m[1]);
    return c ? store.view(c) : fail(404, 'case not found');
  }
  if (method === 'POST' && (m = path.match(/^\/api\/cases\/([^/]+)\/request$/))) {
    const c = store.getCase(m[1]) || fail(404, 'case not found');
    const { hospitalId, option } = body;
    await hooks.beforeRequest(hospitalId);
    const draft = { ...c, bedType: option?.bedType, etaMin: option?.etaMin };
    store.requestAdmission(c.id, { hospitalId, option, handover: { text: templateHandover(draft), engine: 'template' } });
    hooks.afterRequest(hospitalId, store.listeners(`hospital:${hospitalId}`) > 0);
    return store.view(c);
  }
  if (method === 'POST' && (m = path.match(/^\/api\/cases\/([^/]+)\/transport$/))) return store.view(store.startTransport(m[1], { mode: body.mode }));
  if (method === 'POST' && (m = path.match(/^\/api\/cases\/([^/]+)\/position$/))) return { ok: true, status: store.updatePosition(m[1], body).status };
  if (method === 'POST' && (m = path.match(/^\/api\/cases\/([^/]+)\/arrived$/))) return store.view(store.arrive(m[1]));
  if (method === 'POST' && (m = path.match(/^\/api\/hospitals\/([^/]+)\/cases\/([^/]+)\/respond$/))) {
    return store.view(store.respond(m[2], m[1], { accept: Boolean(body.accept), reason: body.reason, bay: body.bay }));
  }
  if (method === 'PATCH' && (m = path.match(/^\/api\/hospitals\/([^/]+)\/status$/))) return publicHospital(store.updateHospitalStatus(m[1], body));
  if (method === 'GET' && (m = path.match(/^\/api\/hospitals\/([^/]+)\/dashboard$/))) {
    const h = store.getHospital(m[1]) || fail(404, 'hospital not found');
    const cases = [...store.cases.values()].filter((c) => c.hospitalId === h.id).map(store.view);
    return { hospital: publicHospital(h), cases, forecast: forecastArrivals(h, 8) };
  }
  return fail(404, 'not found');
}

async function apiFetch(url, opts = {}) {
  const { pathname } = new URL(url, 'http://sehat.demo');
  const method = (opts.method || 'GET').toUpperCase();
  const body = typeof opts.body === 'string' && opts.body ? JSON.parse(opts.body) : {};
  await sleep(pathname === '/api/triage' ? 700 : 120); // feel like a real network
  const headers = { 'Content-Type': 'application/json' };
  try {
    const data = await handle(method, pathname, body);
    return new Response(JSON.stringify(data), { status: pathname === '/api/cases' && method === 'POST' ? 201 : 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: err.status || 500, headers });
  }
}

// Stand-in for Server-Sent Events: the store "writes" SSE text, we parse it
// and hand (event, data) to the subscriber.
function stream(url, onEvent) {
  const { pathname } = new URL(url, 'http://sehat.demo');
  let channel = null;
  let m;
  if ((m = pathname.match(/^\/api\/stream\/case\/([^/]+)$/))) channel = `case:${m[1]}`;
  else if ((m = pathname.match(/^\/api\/stream\/hospital\/([^/]+)$/))) channel = `hospital:${m[1]}`;
  else if (pathname === '/api/stream/hospitals') channel = 'hospitals';
  if (!channel) return () => {};
  const res = {
    write(payload) {
      const e = /^event: (.*)\ndata: (.*)\n\n$/s.exec(payload);
      if (e) onEvent(e[1], e[2]);
    },
  };
  if (channel.startsWith('case:')) {
    const c = store.getCase(channel.slice(5));
    if (c) setTimeout(() => onEvent('case', JSON.stringify(store.view(c))), 0);
  }
  return store.subscribe(channel, res);
}

window.sehatServer = { fetch: apiFetch, stream, store, hooks };
