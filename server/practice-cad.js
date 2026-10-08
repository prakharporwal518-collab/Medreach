// Practice 108 control room – stands in for the state's 108 / 102 dispatch (CAD)
// system so the REAL integration can be shown end to end before an agreement
// with the 108 operator exists:
//
//   Medreach ──signed incident (HTTPS)──▶ POST /api/practice-cad/incidents
//   practice control room assigns the nearest suitable unit of its OWN fleet,
//   drives it to the patient and on to the hospital, and
//   ──signed status updates──▶ Medreach POST /api/ems/updates
//
// Both directions use exactly the contract a real control room would
// (server/ems.js). It is NOT the real 108 and says so everywhere.
// Enable with SEHAT_PRACTICE_CAD=on and SEHAT_EMS_URL=<site>/api/practice-cad/incidents.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { sign, verifySignature } from './ems.js';
import { AMBULANCES } from './data/hospitals.js';
import { pickUnit } from '../shared/ems.js';
import { roadKm, predictTravelMin } from '../shared/predict.js';
import { pointAlong, straightLine, downsample } from '../shared/geo.js';

const MAX_INCIDENTS = 200;
const KEEP_MS = 6 * 60 * 60 * 1000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const inIndia = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && p.lat > 5 && p.lat < 38 && p.lng > 67 && p.lng < 99;
const str = (v, n = 80) => String(v ?? '').slice(0, n);

/**
 * A dispatcher key as people actually paste it: with the setting's name in
 * front ("SEHAT_EMS_SECRET=…"), in quotes, or with spaces/line breaks.
 */
export function cleanKey(v) {
  let s = String(v ?? '').trim().replace(/^SEHAT_EMS_SECRET\s*[=:]\s*/i, '');
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  return s.replace(/\s+/g, '');
}

export function createPracticeCad({
  secret,
  callbackUrl = () => 'http://127.0.0.1:3000/api/ems/updates',
  fetchFn = globalThis.fetch,
  routeFn = null,
  demoSpeed = 15,
  autoAssignMs = 4000,
  manualFallbackMs = 120000,
  tickMs = 2000,
  dataMode = 'demo',
  otherKeys = {},
}) {
  if (!secret) throw new Error('practice control room needs SEHAT_EMS_SECRET');
  const fleet = structuredClone(AMBULANCES).map((a) => ({ ...a, available: true }));
  const incidents = new Map(); // incidentId -> record
  const timers = new Set();
  let seq = 0;
  // 'auto': the control room assigns the nearest unit after a few seconds.
  // 'manual': incidents wait for the dispatcher; if nobody assigns within
  // manualFallbackMs the nearest unit is sent anyway so no patient is left waiting.
  const settings = { mode: 'auto' };

  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref?.();
    timers.add(t);
    return t;
  };
  const note = (rec, text) => {
    rec.history.push({ at: new Date().toISOString(), text });
    if (rec.history.length > 30) rec.history.shift();
  };
  const newId = (service) => {
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `PRACTICE-${service}-${ymd}-${String(++seq).padStart(4, '0')}`;
  };

  // ---------------------------------------------------------------- talk back to Medreach
  async function send(rec, status) {
    rec.status = status;
    const body = JSON.stringify({
      incidentRef: rec.ref, incidentId: rec.id, status,
      unit: rec.unit, position: rec.position, etaMin: rec.etaMin,
      etaToPatientMin: rec.phase === 'to_patient' && rec.toPatientMin ? Math.max(0, Math.round(rec.toPatientMin * (1 - rec.progress))) : null,
    });
    const ts = Date.now();
    try {
      const res = await fetchFn(callbackUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Medreach-Timestamp': String(ts), 'X-Medreach-Signature': sign(secret, ts, body) },
        body,
        signal: AbortSignal.timeout(8000),
      });
      rec.delivery = res.ok ? 'delivered' : `Medreach answered HTTP ${res.status}`;
      const out = await res.json().catch(() => ({}));
      // The family pressed "We have arrived", or Medreach no longer knows the case.
      if (res.status === 404 || (out.status === 'arrived' && status !== 'arrived')) close(rec, out.status === 'arrived' ? 'Patient already arrived (reported by Medreach)' : 'Case closed on Medreach');
    } catch (err) {
      rec.delivery = `not delivered (${str(err?.message, 60)})`;
    }
  }

  function close(rec, why) {
    if (rec.closed) return;
    rec.closed = true;
    const unit = fleet.find((a) => a.id === rec.unit?.id);
    if (unit) { unit.available = true; Object.assign(unit, AMBULANCES.find((a) => a.id === unit.id)); }
    note(rec, why);
  }

  // ---------------------------------------------------------------- incidents
  function receive(inc) {
    if (!inc || typeof inc !== 'object') fail(400, 'incident JSON required');
    if (!/^MR-[\w-]{1,40}$/.test(String(inc.incidentRef))) fail(400, 'incidentRef missing');
    if (inc.type === 'destination_change') return redirect(inc);
    if (!inIndia(inc.pickup) || !inIndia(inc.destination)) fail(400, 'pickup and destination must be valid coordinates');
    const service = inc.service === '102' ? '102' : '108';
    const duplicate = [...incidents.values()].find((r) => r.ref === inc.incidentRef && !r.closed);
    if (duplicate) return { incidentId: duplicate.id, status: duplicate.status };
    const rec = {
      id: newId(service), ref: str(inc.incidentRef, 48), service,
      priority: ['P1', 'P2', 'P3'].includes(inc.priority) ? inc.priority : 'P2',
      ambulanceType: ['ALS', 'BLS', 'JANANI'].includes(inc.ambulanceType) ? inc.ambulanceType : 'BLS',
      complaint: { label: str(inc.complaint?.label, 60), severity: str(inc.complaint?.severity, 12), personAlone: Boolean(inc.complaint?.personAlone) },
      pickup: { lat: inc.pickup.lat, lng: inc.pickup.lng },
      destination: { name: str(inc.destination.name, 80), lat: inc.destination.lat, lng: inc.destination.lng, accepted: Boolean(inc.destination.accepted), bay: str(inc.destination.bay, 24) || null },
      callback: inc.callback ? `••••••${String(inc.callback).replace(/\D/g, '').slice(-4)}` : null,
      createdAt: new Date().toISOString(),
      status: 'received', unit: null, position: null, etaMin: null, phase: null, progress: 0,
      history: [], closed: false, delivery: null, assignedBy: null,
    };
    note(rec, `Incident received from Medreach (${rec.priority}, ${rec.complaint.label || 'emergency'})`);
    incidents.set(rec.id, rec);
    for (const [id, r] of incidents) if (incidents.size > MAX_INCIDENTS || Date.now() - Date.parse(r.createdAt) > KEEP_MS) { close(r, 'Archived'); incidents.delete(id); }
    if (settings.mode === 'manual') {
      rec.autoAssignAt = new Date(Date.now() + manualFallbackMs).toISOString();
      note(rec, `Waiting for the dispatcher (auto-assign in ${Math.round(manualFallbackMs / 1000)} s if nobody does)`);
      later(() => assign(rec.id, { by: 'auto-dispatch (no dispatcher action)' }), manualFallbackMs);
    } else {
      rec.autoAssignAt = new Date(Date.now() + autoAssignMs).toISOString();
      later(() => assign(rec.id), autoAssignMs);
    }
    return { incidentId: rec.id, status: 'received' };
  }

  // Re-route from Medreach: the accepting hospital changed while the unit is on its way.
  function redirect(inc) {
    if (!inIndia(inc.destination)) fail(400, 'destination must be valid coordinates');
    const rec = [...incidents.values()].find((r) => r.ref === inc.incidentRef && !r.closed);
    if (!rec) fail(404, 'no open incident with this reference');
    const from = rec.destination.name;
    rec.destination = { name: str(inc.destination.name, 80), lat: inc.destination.lat, lng: inc.destination.lng, accepted: Boolean(inc.destination.accepted), bay: null };
    rec.rerouted = (rec.rerouted || 0) + 1;
    if (rec.unit && rec.legs) {
      const hour = new Date().getHours();
      const going = rec.phase === 'to_hospital';
      const start = going ? { ...rec.position } : { ...rec.pickup };
      rec.toHospitalMin = Math.max(1, predictTravelMin(roadKm(start, rec.destination), { hour, mode: 'ambulance' }).minutes);
      rec.legs.toHospital = straightLine(start, rec.destination);
      if (going) { rec.progress = 0; rec.etaMin = rec.toHospitalMin; }
      road(start, rec.destination).then((coords) => { if (!rec.closed && rec.destination.name === str(inc.destination.name, 80)) rec.legs.toHospital = coords; });
    }
    note(rec, `RE-ROUTED by Medreach: ${from} can no longer receive${inc.reason ? ` (${str(inc.reason, 80)})` : ''} – new destination ${rec.destination.name} (accepted)`);
    return { ok: true, incidentId: rec.id, status: rec.status };
  }

  async function road(a, b) {
    if (routeFn) {
      try { const r = await routeFn(a, b); if (r?.coords?.length > 1) return r.coords; } catch { /* straight line */ }
    }
    return straightLine(a, b);
  }

  async function assign(id, { by = 'auto-dispatch' } = {}) {
    const rec = incidents.get(id);
    if (!rec || rec.closed || rec.unit) return rec;
    const pick = pickUnit(fleet, rec.ambulanceType, rec.pickup);
    if (!pick) {
      if (rec.status !== 'waiting_for_unit') note(rec, 'No unit free – waiting');
      rec.status = 'waiting_for_unit';
      later(() => assign(id, { by }), 15000);
      return rec;
    }
    const a = pick.a;
    a.available = false;
    const hour = new Date().getHours();
    rec.unit = { id: a.id, type: a.type, base: a.base };
    rec.position = { lat: a.lat, lng: a.lng };
    rec.toPatientMin = Math.max(1, predictTravelMin(pick.km, { hour, mode: 'ambulance' }).minutes);
    rec.toHospitalMin = Math.max(1, predictTravelMin(roadKm(rec.pickup, rec.destination), { hour, mode: 'ambulance' }).minutes);
    rec.etaMin = rec.toPatientMin + rec.toHospitalMin + 2;
    rec.assignedBy = by;
    rec.autoAssignAt = null;
    rec.legs = { toPatient: await road(rec.position, rec.pickup), toHospital: await road(rec.pickup, rec.destination) };
    rec.phase = 'to_patient';
    rec.progress = 0;
    note(rec, `${a.id} (${a.type}) from ${a.base} assigned by ${by} – ~${rec.toPatientMin} min to patient`);
    await send(rec, 'assigned');
    if (!rec.closed) later(() => tick(id), tickMs);
    return rec;
  }

  const along = (coords, f) => { const p = pointAlong(coords, f); return { lat: p[0], lng: p[1] }; };
  async function tick(id) {
    const rec = incidents.get(id);
    if (!rec || rec.closed) return;
    const step = (tickMs / 1000) * demoSpeed;
    if (rec.phase === 'to_patient') {
      rec.progress = Math.min(1, rec.progress + step / (rec.toPatientMin * 60));
      rec.position = along(rec.legs.toPatient, rec.progress);
      rec.etaMin = Math.round(rec.toPatientMin * (1 - rec.progress) + rec.toHospitalMin + 2);
      if (rec.progress >= 1) {
        rec.phase = 'at_patient';
        rec.atTicks = 0;
        rec.position = { ...rec.pickup };
        note(rec, 'Unit at patient');
        await send(rec, 'at_patient');
      } else await send(rec, 'enroute_to_patient');
    } else if (rec.phase === 'at_patient') {
      if (++rec.atTicks >= 3) {
        rec.phase = 'to_hospital';
        rec.progress = 0;
        note(rec, `Patient on board – to ${rec.destination.name}`);
        await send(rec, 'patient_on_board');
      }
    } else if (rec.phase === 'to_hospital') {
      rec.progress = Math.min(1, rec.progress + step / (rec.toHospitalMin * 60));
      rec.position = along(rec.legs.toHospital, rec.progress);
      rec.etaMin = Math.round(rec.toHospitalMin * (1 - rec.progress));
      if (rec.progress >= 1) {
        rec.position = { lat: rec.destination.lat, lng: rec.destination.lng };
        rec.etaMin = 0;
        await send(rec, 'arrived');
        close(rec, `Arrived at ${rec.destination.name} – unit back in service`);
        return;
      }
      await send(rec, 'to_hospital');
    }
    if (!rec.closed) later(() => tick(id), tickMs);
  }

  async function cancel(id) {
    const rec = incidents.get(id);
    if (!rec || rec.closed) return rec;
    await send(rec, 'cancelled');
    close(rec, 'Cancelled by the dispatcher');
    return rec;
  }

  // What the console shows: no names, callback masked, pick-up rounded to ~1 km.
  const view = (r) => ({
    id: r.id, ref: r.ref, service: r.service, priority: r.priority, ambulanceType: r.ambulanceType,
    complaint: r.complaint, callback: r.callback, createdAt: r.createdAt,
    pickup: { lat: Math.round(r.pickup.lat * 100) / 100, lng: Math.round(r.pickup.lng * 100) / 100 },
    destination: { name: r.destination.name, lat: r.destination.lat, lng: r.destination.lng, bay: r.destination.bay },
    status: r.status, phase: r.phase, closed: r.closed, unit: r.unit, position: r.closed ? null : r.position, etaMin: r.etaMin,
    path: !r.closed && r.legs ? downsample(r.phase === 'to_hospital' ? r.legs.toHospital : r.legs.toPatient, 40) : null,
    rerouted: r.rerouted || 0, assignedBy: r.assignedBy, autoAssignAt: r.unit || r.closed ? null : r.autoAssignAt || null, delivery: r.delivery, history: r.history,
  });

  // ---------------------------------------------------------------- HTTP
  const same = (given, want) => {
    const a = Buffer.from(given);
    const b = Buffer.from(String(want || ''));
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };
  const keyOk = (req) => same(cleanKey(req.get('x-dispatcher-key')), secret);
  const router = express.Router();
  // "Unlock actions" checks the key straight away and says what is wrong –
  // without ever revealing the real key.
  router.post('/key-check', express.json({ limit: '2kb' }), (req, res) => {
    const key = cleanKey(req.body?.key);
    if (same(key, secret)) return res.json({ ok: true });
    let reason = 'mismatch';
    if (!key) reason = 'empty';
    else {
      for (const [name, value] of Object.entries(otherKeys)) {
        if (same(key, cleanKey(value))) { reason = `other:${name}`; break; }
      }
    }
    res.status(401).json({ ok: false, reason, length: key.length, expectedLength: secret.length });
  });
  router.post('/incidents', express.json({ limit: '32kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }), (req, res) => {
    if (!verifySignature(secret, { timestamp: req.get('x-medreach-timestamp'), signature: req.get('x-medreach-signature'), rawBody: req.rawBody })) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    try { res.status(201).json(receive(req.body)); } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
  });
  router.get('/incidents', (req, res) => {
    if (dataMode === 'live' && !keyOk(req)) return res.status(401).json({ error: 'dispatcher key required' });
    res.json({
      practice: true,
      settings: { ...settings },
      fleet: fleet.map(({ id, type, base, area, lat, lng, available }) => ({ id, type, base, area, lat, lng, available })),
      incidents: [...incidents.values()].reverse().map(view),
    });
  });
  const act = (fn) => async (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ error: 'dispatcher key required' });
    const rec = incidents.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'no such incident' });
    await fn(rec.id);
    res.json(view(incidents.get(rec.id)));
  };
  router.post('/settings', express.json({ limit: '2kb' }), (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ error: 'dispatcher key required' });
    if (!['auto', 'manual'].includes(req.body?.mode)) return res.status(400).json({ error: 'mode must be auto or manual' });
    settings.mode = req.body.mode;
    res.json({ ...settings });
  });
  router.post('/incidents/:id/assign', act((id) => assign(id, { by: 'dispatcher' })));
  router.post('/incidents/:id/cancel', act(cancel));

  return {
    router, receive, assign, cancel, incidents, fleet, settings,
    stop() { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}
