// Sehat Setu – emergency case lifecycle, real-time events and simulations.
//
//   new ──► requested ──► accepted ──► enroute ──► arrived
//               │
//               ├──► declined  (client escalates to the next hospital)
//               └──► timeout   (no answer in time → escalate)
//
// Real-time updates use Server-Sent Events (SSE): one channel per case (the
// family's phone) and one per hospital (the ER console).
// Everything is in memory – enough for a prototype; production would use
// Postgres + Redis pub/sub.

import crypto from 'node:crypto';
import { HOSPITALS, AMBULANCES } from './data/hospitals.js';
import { roadKm, predictTravelMin } from '../shared/predict.js';

export function createStore({
  hospitals = structuredClone(HOSPITALS),
  ambulances = structuredClone(AMBULANCES),
  simulatedResponseMs = Number(process.env.SEHAT_SIM_RESPONSE_MS ?? 3500),
  responseTimeoutMs = Number(process.env.SEHAT_RESPONSE_TIMEOUT_MS ?? 60000),
  demoSpeed = Number(process.env.SEHAT_DEMO_SPEED ?? 15), // 1 real second = 15 simulated seconds
} = {}) {
  const cases = new Map();
  const channels = new Map(); // channel -> Set<res>
  const timers = new Set();
  for (const a of ambulances) { a.available = true; a.home = { lat: a.lat, lng: a.lng }; }

  // ---------------------------------------------------------------- SSE hub
  function subscribe(channel, res) {
    if (!channels.has(channel)) channels.set(channel, new Set());
    channels.get(channel).add(res);
    return () => channels.get(channel)?.delete(res);
  }
  function listeners(channel) { return channels.get(channel)?.size ?? 0; }
  function publish(channel, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of channels.get(channel) ?? []) res.write(payload);
  }
  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  }

  const getHospital = (id) => hospitals.find((h) => h.id === id);
  const now = () => new Date().toISOString();

  function log(c, event, text) {
    c.timeline.push({ at: now(), event, text });
    publish(`case:${c.id}`, 'case', view(c));
    if (c.hospitalId) publish(`hospital:${c.hospitalId}`, 'case', view(c));
  }

  // A trimmed view of the case that is safe to send to clients.
  function view(c) {
    const { responseTimer, ...rest } = c;
    return rest;
  }

  // ---------------------------------------------------------------- cases
  function createCase({ triage, location, patient = {}, contact = {}, lang = 'en', vision = null, text = '' }) {
    const id = `SS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const c = {
      id, createdAt: now(), status: 'new', lang, text, triage, location, patient, contact, vision,
      hospitalId: null, bedType: null, etaMin: null, option: null, handover: null, bay: null,
      requests: [], transport: null, timeline: [],
    };
    cases.set(id, c);
    log(c, 'created', `Emergency reported: ${triage.label} (${triage.severity})`);
    return c;
  }

  const getCase = (id) => cases.get(id);

  function requestAdmission(caseId, { hospitalId, option, handover }) {
    const c = cases.get(caseId);
    const h = getHospital(hospitalId);
    if (!c || !h) throw Object.assign(new Error('case or hospital not found'), { status: 404 });
    if (['accepted', 'enroute', 'arrived'].includes(c.status)) {
      throw Object.assign(new Error(`case already ${c.status}`), { status: 409 });
    }
    clearTimeout(c.responseTimer);
    c.status = 'requested';
    c.hospitalId = hospitalId;
    c.option = option ?? null;
    c.bedType = option?.bedType ?? 'emergency';
    c.etaMin = option?.etaMin ?? null;
    c.handover = handover ?? c.handover;
    const consoleOnline = listeners(`hospital:${hospitalId}`) > 0;
    c.requests.push({ hospitalId, at: now(), outcome: 'pending', simulated: !consoleOnline });
    publish(`hospital:${hospitalId}`, 'request', view(c));
    log(c, 'requested', `Admission request sent to ${h.name}`);

    if (!consoleOnline) {
      // No human at this hospital's console → simulate the ER desk so the demo
      // works end-to-end on one screen. Decision is based on live bed status.
      later(() => {
        if (c.status !== 'requested' || c.hospitalId !== hospitalId) return;
        const bed = h.status.beds[c.bedType] ?? { free: 0 };
        const canTake = bed.free > 0 || (option?.bed?.probability ?? 0) >= 0.35;
        respond(caseId, hospitalId, canTake
          ? { accept: true, note: 'Auto-confirmed by ER desk (simulated)', simulated: true }
          : { accept: false, reason: `No ${c.bedType.toUpperCase()} bed free right now (simulated)`, simulated: true });
      }, simulatedResponseMs);
    } else {
      c.responseTimer = later(() => {
        if (c.status !== 'requested' || c.hospitalId !== hospitalId) return;
        c.status = 'timeout';
        c.requests.at(-1).outcome = 'timeout';
        log(c, 'timeout', `${h.name} did not respond in ${Math.round(responseTimeoutMs / 1000)}s – escalating`);
      }, responseTimeoutMs);
    }
    return c;
  }

  function respond(caseId, hospitalId, { accept, reason = '', bay = '', note = '', simulated = false }) {
    const c = cases.get(caseId);
    const h = getHospital(hospitalId);
    if (!c || !h) throw Object.assign(new Error('case or hospital not found'), { status: 404 });
    if (c.hospitalId !== hospitalId || c.status !== 'requested') {
      throw Object.assign(new Error('no pending request for this hospital'), { status: 409 });
    }
    clearTimeout(c.responseTimer);
    const req = c.requests.at(-1);
    req.outcome = accept ? 'accepted' : 'declined';
    req.reason = reason;
    req.respondedAt = now();
    req.simulated = simulated;
    if (accept) {
      c.status = 'accepted';
      const beds = h.status.beds[c.bedType];
      if (beds && beds.free > 0) beds.free -= 1; // reserve the bed
      c.bay = bay || `${c.bedType === 'icu' ? 'Resus' : c.bedType === 'labour' ? 'Labour room' : 'ER'} bay ${1 + Math.floor(Math.random() * 8)}`;
      log(c, 'accepted', `${h.name} ACCEPTED – ${c.bay} is being prepared${note ? ` · ${note}` : ''}`);
      publish('hospitals', 'status', statusView(h));
    } else {
      c.status = 'declined';
      log(c, 'declined', `${h.name} declined: ${reason || 'unable to admit'}`);
    }
    return c;
  }

  // ---------------------------------------------------------------- transport
  function pickAmbulance(type, from) {
    const order = type === 'ALS' ? ['ALS', 'BLS'] : type === 'JANANI' ? ['JANANI', 'BLS', 'ALS'] : ['BLS', 'ALS', 'JANANI'];
    for (const t of order) {
      const pool = ambulances.filter((a) => a.available && a.type === t)
        .map((a) => ({ a, km: roadKm(from, a) }))
        .sort((x, y) => x.km - y.km);
      // Accept a less-equipped vehicle only if it is much closer (<= 25 km) and nothing better is near.
      if (pool.length && (t === order[0] || pool[0].km <= 25)) return pool[0];
    }
    return null;
  }

  function startTransport(caseId, { mode }) {
    const c = cases.get(caseId);
    if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
    if (c.status !== 'accepted') throw Object.assign(new Error('hospital has not accepted yet'), { status: 409 });
    const h = getHospital(c.hospitalId);
    c.status = 'enroute';
    if (mode !== 'ambulance') {
      c.transport = { mode: 'own', startedAt: now(), etaMin: c.etaMin };
      log(c, 'enroute', `Travelling by own vehicle to ${h.name} – ETA ${c.etaMin ?? '?'} min`);
      return c;
    }
    const pick = pickAmbulance(c.triage.ambulanceType, c.location);
    if (!pick) {
      c.transport = { mode: 'own', startedAt: now(), etaMin: c.etaMin, note: 'No ambulance free nearby' };
      log(c, 'enroute', 'No ambulance free nearby – please use own vehicle; hospital is waiting');
      return c;
    }
    const amb = pick.a;
    amb.available = false;
    const hour = new Date().getHours();
    const toPatient = predictTravelMin(roadKm(amb, c.location), { hour, mode: 'ambulance' }).minutes;
    const toHospital = predictTravelMin(roadKm(c.location, h), { hour, mode: 'ambulance' }).minutes;
    c.transport = {
      mode: 'ambulance',
      ambulance: { id: amb.id, type: amb.type, base: amb.base },
      phase: 'to_patient', progress: 0,
      position: { lat: amb.lat, lng: amb.lng },
      from: { lat: amb.lat, lng: amb.lng },
      etaToPatientMin: toPatient, etaToHospitalMin: toHospital,
      etaMin: toPatient + toHospital + 2,
      demoSpeed,
      startedAt: now(),
    };
    log(c, 'dispatched', `Ambulance ${amb.id} (${amb.type}) dispatched from ${amb.base} – reaching you in ~${toPatient} min`);
    simulateAmbulance(c, amb, h);
    return c;
  }

  function simulateAmbulance(c, amb, h) {
    const t = c.transport;
    const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
    let atPatientTicks = 0;
    const tick = () => {
      if (c.status !== 'enroute' || t.mode !== 'ambulance') return;
      if (t.phase === 'to_patient') {
        t.progress = Math.min(1, t.progress + demoSpeed / (t.etaToPatientMin * 60));
        t.position = lerp(t.from, c.location, t.progress);
        t.etaMin = Math.round(t.etaToPatientMin * (1 - t.progress) + t.etaToHospitalMin + 2);
        if (t.progress >= 1) { t.phase = 'at_patient'; t.progress = 0; log(c, 'at_patient', `Ambulance ${amb.id} reached the patient – paramedics stabilising`); }
      } else if (t.phase === 'at_patient') {
        if (++atPatientTicks >= 3) { t.phase = 'to_hospital'; log(c, 'to_hospital', `Patient on board – heading to ${h.name}`); }
      } else if (t.phase === 'to_hospital') {
        t.progress = Math.min(1, t.progress + demoSpeed / (t.etaToHospitalMin * 60));
        t.position = lerp(c.location, h, t.progress);
        t.etaMin = Math.max(0, Math.round(t.etaToHospitalMin * (1 - t.progress)));
        if (t.progress >= 1) { arrive(c.id); return; }
      }
      publish(`case:${c.id}`, 'ambulance', t);
      publish(`hospital:${c.hospitalId}`, 'ambulance', { caseId: c.id, ...t });
      later(tick, 1000);
    };
    later(tick, 1000);
  }

  function updatePosition(caseId, { lat, lng, etaMin }) {
    const c = cases.get(caseId);
    if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
    if (c.transport?.mode === 'own') {
      c.transport.position = { lat, lng };
      if (Number.isFinite(etaMin)) c.transport.etaMin = etaMin;
      publish(`hospital:${c.hospitalId}`, 'position', { caseId, lat, lng, etaMin: c.transport.etaMin });
    }
    return c;
  }

  function arrive(caseId) {
    const c = cases.get(caseId);
    if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
    if (c.status === 'arrived') return c;
    c.status = 'arrived';
    const h = getHospital(c.hospitalId);
    if (c.transport?.mode === 'ambulance') {
      const amb = ambulances.find((a) => a.id === c.transport.ambulance.id);
      if (amb) { amb.available = true; Object.assign(amb, amb.home); }
      c.transport.progress = 1;
      c.transport.etaMin = 0;
      c.transport.position = { lat: h.lat, lng: h.lng };
    }
    log(c, 'arrived', `Patient arrived at ${h?.name} – handed over to the emergency team`);
    return c;
  }

  // ---------------------------------------------------------------- hospitals
  function statusView(h) {
    return { id: h.id, status: h.status, updatedAt: now() };
  }

  function updateHospitalStatus(id, patch = {}) {
    const h = getHospital(id);
    if (!h) throw Object.assign(new Error('hospital not found'), { status: 404 });
    const s = h.status;
    if (patch.erStatus && ['open', 'busy', 'diverting'].includes(patch.erStatus)) s.erStatus = patch.erStatus;
    if (patch.beds) {
      for (const [type, v] of Object.entries(patch.beds)) {
        if (!s.beds[type]) continue;
        if (Number.isFinite(v.free)) s.beds[type].free = Math.max(0, Math.min(s.beds[type].total, Math.round(v.free)));
      }
    }
    if (Array.isArray(patch.onDuty)) s.onDuty = patch.onDuty.filter((c) => h.capabilities.includes(c));
    if (Array.isArray(patch.equipmentDown)) s.equipmentDown = patch.equipmentDown.filter((c) => h.capabilities.includes(c));
    if (Number.isFinite(patch.erQueue)) s.erQueue = Math.max(0, Math.round(patch.erQueue));
    if (Number.isFinite(patch.ventilatorsFree)) s.ventilatorsFree = Math.max(0, Math.round(patch.ventilatorsFree));
    s.updatedAt = now();
    s.updatedBy = patch.updatedBy || 'hospital-console';
    publish('hospitals', 'status', statusView(h));
    publish(`hospital:${id}`, 'status', statusView(h));
    return h;
  }

  // Background random walk so bed counts and ER queues feel alive in a demo.
  function startStatusSimulation(intervalMs = 20000) {
    const step = () => {
      for (const h of hospitals) {
        if (h.status.updatedBy === 'hospital-console') continue; // respect human edits
        const s = h.status;
        const jiggle = (v, max) => Math.max(0, Math.min(max, v + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.35 ? 1 : 0)));
        for (const b of Object.values(s.beds)) b.free = jiggle(b.free, b.total);
        s.erQueue = jiggle(s.erQueue, 25);
        publish('hospitals', 'status', statusView(h));
      }
      later(step, intervalMs);
    };
    later(step, intervalMs);
  }

  function stop() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return {
    hospitals, ambulances, cases,
    subscribe, publish, listeners,
    createCase, getCase, requestAdmission, respond, startTransport, updatePosition, arrive,
    getHospital, updateHospitalStatus, startStatusSimulation, stop, view,
  };
}
