// Medreach – emergency case lifecycle, real-time events, audit and privacy.
//
//   new ──► requested ──► accepted ──► enroute ──► arrived ──► (patient data purged after retention)
//               │
//               ├──► declined  (client escalates to the next hospital)
//               └──► timeout   (no answer in time → escalate)
//
// Three different things are kept deliberately separate:
//   1. REPORTED CAPACITY   – what hospital staff last entered on the dashboard (+ who, when)
//   2. REFERRAL ACCEPTED   – a named staff member accepted THIS patient
//   3. CONFIRMED DEST.     – accepted + receiving bay assigned; patient travels there
//
// Real-time updates use Server-Sent Events (SSE). Everything is in memory –
// enough for a prototype; production would use Postgres (encrypted at rest)
// + Redis pub/sub. Patient details, the raw description and the trusted
// contact are kept sealed by a `vault` (AES-256-GCM on the server) and only
// opened when an authorised view is built.

import { HOSPITALS, AMBULANCES, SEED_VERIFIED_MIN_AGO } from './data/hospitals.js';
import { roadKm, predictTravelMin } from '../shared/predict.js';
import { roleLabel } from '../shared/roles.js';
import { pointAlong, downsample, remainingPath, straightLine } from '../shared/geo.js';

const env = globalThis.process?.env ?? {};
const randomHex = (bytes) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)),
  (b) => b.toString(16).padStart(2, '0')).join('');
const maskId = (id) => (id ? `••••${String(id).replace(/\W/g, '').slice(-4)}` : undefined);
const maskPhone = (p) => (p ? `••••••${String(p).slice(-4)}` : undefined);

export function createStore({
  hospitals = structuredClone(HOSPITALS),
  ambulances = structuredClone(AMBULANCES),
  simulatedResponseMs = Number(env.SEHAT_SIM_RESPONSE_MS ?? 3500),
  responseTimeoutMs = Number(env.SEHAT_RESPONSE_TIMEOUT_MS ?? 60000),
  demoSpeed = Number(env.SEHAT_DEMO_SPEED ?? 15), // 1 real second = 15 simulated seconds
  retentionMs = Number(env.SEHAT_RETENTION_MS ?? 24 * 60 * 60 * 1000), // purge patient details 24 h after arrival
  seedVerified = true,
  // Road routes for moving vehicles: async (from, to) => { coords, km, min } | null.
  routeFn = null,
  // Demo: drive the citizen's own vehicle along the route until real GPS movement arrives.
  simulateOwnVehicle = env.SEHAT_SIMULATE_VEHICLE !== '0',
  // Field encryption for personal data; identity by default (browser demo).
  vault = { seal: (v) => v, open: (v) => v },
} = {}) {
  const cases = new Map();
  const channels = new Map(); // channel -> Set<res>
  const timers = new Set();
  const auditLog = [];
  for (const a of ambulances) { a.available = true; a.home = { lat: a.lat, lng: a.lng }; }

  // Seed: demo data, verified N minutes ago by the "demo seed" (not a real person).
  for (const h of hospitals) {
    const mins = SEED_VERIFIED_MIN_AGO[h.id];
    h.status.source = 'simulated';
    h.status.verifiedBy = { name: 'Demo seed', role: 'simulated', roleLabel: 'Simulated data' };
    h.status.verifiedAt = seedVerified && Number.isFinite(mins) ? new Date(Date.now() - mins * 60000).toISOString() : null;
  }

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

  // ---------------------------------------------------------------- audit trail
  function audit(entry) {
    const e = { at: now(), ...entry };
    auditLog.push(e);
    if (auditLog.length > 5000) auditLog.shift();
    if (e.hospitalId) publish(`hospital:${e.hospitalId}`, 'audit', e);
    return e;
  }
  const auditFor = (hospitalId) => auditLog.filter((e) => hospitalId === '*' || e.hospitalId === hospitalId).slice(-200).reverse();

  // ---------------------------------------------------------------- views (who sees what)
  // Citizen who created the case: everything except secrets & timers.
  function view(c) {
    const { responseTimer, accessToken, trackToken, ...rest } = c;
    if (rest.transport) rest.transport = wire(rest.transport);
    return rest;
  }
  // Receiving hospital: only what's needed for care; IDs masked; nothing without consent.
  function hospitalView(c) {
    const v = view(c);
    const p = c.consent?.patientDetails ? c.patient || {} : {};
    v.patient = { ...p, abhaId: maskId(p.abhaId), ayushmanId: maskId(p.ayushmanId), phone: undefined };
    v.contact = undefined;
    v.location = c.location ? { lat: Math.round(c.location.lat * 1000) / 1000, lng: Math.round(c.location.lng * 1000) / 1000 } : null;
    v.text = undefined; // raw description stays with the family; the doctor gets the summary
    return v;
  }
  // Trusted contact (family): status & destination only – no medical details.
  function trackView(c) {
    const h = c.hospitalId && getHospital(c.hospitalId);
    return {
      id: c.id,
      status: c.status,
      emergency: c.triage?.label,
      severity: c.triage?.severity,
      hospital: h && ['accepted', 'enroute', 'arrived'].includes(c.status) ? { name: h.name, area: h.area, lat: h.lat, lng: h.lng } : null,
      bay: c.bay,
      acceptedBy: c.acceptedBy ? { role: c.acceptedBy.roleLabel } : null,
      transport: c.transport ? (() => {
        const w = wire(c.transport);
        return { mode: w.mode, etaMin: w.etaMin, phase: w.phase, ambulance: w.ambulance?.id, simulated: w.simulated, gps: w.gps, position: w.position, path: w.path, nextPath: w.nextPath, onRoad: w.onRoad };
      })() : null,
      location: c.location,
      timeline: c.timeline.map((e) => ({ at: e.at, text: e.public ?? e.text })),
      alone: c.alone,
    };
  }

  function log(c, event, text, publicText) {
    c.timeline.push({ at: now(), event, text, ...(publicText ? { public: publicText } : {}) });
    publish(`case:${c.id}`, 'case', view(c));
    publish(`track:${c.id}`, 'case', trackView(c));
    if (c.hospitalId) publish(`hospital:${c.hospitalId}`, 'case', hospitalView(c));
  }

  // ---------------------------------------------------------------- cases
  // Personal fields live only in sealed form; reading them opens the vault.
  const SEALED = ['patient', 'contact', 'text'];
  function sealFields(c, values) {
    const box = {};
    for (const f of SEALED) {
      Object.defineProperty(c, f, {
        enumerable: true,
        get: () => vault.open(box[f]),
        set: (v) => { box[f] = vault.seal(v); },
      });
      c[f] = values[f];
    }
  }

  function createCase({ triage, location, patient = {}, contact = null, lang = 'en', vision = null, text = '', consent = {}, alone = false }) {
    const id = `SS-${randomHex(3).toUpperCase()}`;
    const c = {
      id, createdAt: now(), status: 'new', lang, triage, location,
      consent: { patientDetails: Boolean(consent.patientDetails), location: true, at: now() },
      alone: Boolean(alone),
      vision,
      accessToken: randomHex(16), // for the citizen's device
      trackToken: randomHex(12),  // read-only, limited view for the trusted contact
      hospitalId: null, bedType: null, etaMin: null, option: null, handover: null, bay: null,
      acceptedBy: null, acceptedAt: null, reportedCapacity: null,
      requests: [], transport: null, timeline: [],
    };
    sealFields(c, {
      text: String(text || ''),
      // Data minimisation: patient details are only stored if the family consented to share them.
      patient: consent.patientDetails ? patient : {},
      contact: contact?.phone ? { name: contact.name || 'Trusted contact', phone: contact.phone } : null,
    });
    cases.set(id, c);
    log(c, 'created', `Emergency reported: ${triage.label} (${triage.severity})${alone ? ' – person is ALONE' : ''}`);
    if (c.contact) {
      log(c, 'contact_notified',
        `Trusted contact ${c.contact.name} (${maskPhone(c.contact.phone)}) notified with live tracking link (SMS simulated in prototype)`);
    }
    return c;
  }

  const getCase = (id) => cases.get(id);
  const checkCaseToken = (c, token) => Boolean(c && token && token === c.accessToken);
  const checkTrackToken = (c, token) => Boolean(c && token && (token === c.trackToken || token === c.accessToken));

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
    // Snapshot of REPORTED capacity at the moment of referral (not a guarantee).
    const beds = h.status.beds[c.bedType] ?? { free: 0, total: 0 };
    c.reportedCapacity = {
      bedType: c.bedType, free: beds.free, total: beds.total,
      verifiedAt: h.status.verifiedAt, verifiedBy: h.status.verifiedBy, source: h.status.source,
    };
    const consoleOnline = listeners(`hospital:${hospitalId}`) > 0;
    c.requests.push({ hospitalId, at: now(), outcome: 'pending', simulated: !consoleOnline });
    publish(`hospital:${hospitalId}`, 'request', hospitalView(c));
    log(c, 'requested', `Referral request sent to ${h.name} – waiting for acceptance`);

    if (!consoleOnline) {
      // No staff logged in at this hospital → simulate the ER desk so the demo
      // works on one screen. Decision is based on reported bed status.
      later(() => {
        if (c.status !== 'requested' || c.hospitalId !== hospitalId) return;
        const bed = h.status.beds[c.bedType] ?? { free: 0 };
        const canTake = bed.free > 0 || (option?.bed?.probability ?? 0) >= 0.35;
        const actor = { name: 'Simulated ER desk', role: 'simulated', roleLabel: 'Simulated Emergency Desk' };
        respond(caseId, hospitalId, canTake
          ? { accept: true, note: 'simulated – no staff logged in', actor }
          : { accept: false, reason: `No ${c.bedType.toUpperCase()} bed free right now (simulated)`, actor });
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

  function respond(caseId, hospitalId, { accept, reason = '', bay = '', note = '', actor = null }) {
    const c = cases.get(caseId);
    const h = getHospital(hospitalId);
    if (!c || !h) throw Object.assign(new Error('case or hospital not found'), { status: 404 });
    if (c.hospitalId !== hospitalId || c.status !== 'requested') {
      throw Object.assign(new Error('no pending request for this hospital'), { status: 409 });
    }
    clearTimeout(c.responseTimer);
    const who = actor ? { staffId: actor.staffId, name: actor.name, role: actor.role, roleLabel: actor.roleLabel || roleLabel(actor.role) } : null;
    const req = c.requests.at(-1);
    req.outcome = accept ? 'accepted' : 'declined';
    req.reason = reason;
    req.respondedAt = now();
    req.respondedBy = who;
    req.simulated = actor?.role === 'simulated';
    if (actor && actor.role !== 'simulated') {
      audit({ ...actor, hospitalId, action: accept ? 'referral.accepted' : 'referral.declined', result: `${c.id}${reason ? ` – ${reason}` : ''}` });
    }
    if (accept) {
      c.status = 'accepted';
      c.acceptedBy = who;
      c.acceptedAt = req.respondedAt;
      const beds = h.status.beds[c.bedType];
      if (beds && beds.free > 0) beds.free -= 1; // reserve the bed
      c.bay = bay || `${c.bedType === 'icu' ? 'Resus' : c.bedType === 'labour' ? 'Labour room' : 'ER'}-${String(1 + Math.floor(Math.random() * 8)).padStart(2, '0')}`;
      const by = who ? ` by ${who.roleLabel}${who.role !== 'simulated' ? ` (${who.name})` : ''}` : '';
      log(c, 'accepted', `${h.name} ACCEPTED the referral${by} – receiving bay ${c.bay}${note ? ` · ${note}` : ''}`,
        `${h.name} accepted – receiving bay ${c.bay}`);
      publish('hospitals', 'status', statusView(h));
    } else {
      c.status = 'declined';
      log(c, 'declined', `${h.name} declined: ${reason || 'unable to admit'}`);
    }
    return c;
  }

  // ---------------------------------------------------------------- transport (SIMULATED)
  function pickAmbulance(type, from) {
    const order = type === 'ALS' ? ['ALS', 'BLS'] : type === 'JANANI' ? ['JANANI', 'BLS', 'ALS'] : ['BLS', 'ALS', 'JANANI'];
    for (const t of order) {
      const pool = ambulances.filter((a) => a.available && a.type === t)
        .map((a) => ({ a, km: roadKm(from, a) }))
        .sort((x, y) => x.km - y.km);
      if (pool.length && (t === order[0] || pool[0].km <= 25)) return pool[0];
    }
    return null;
  }

  // What goes on the wire for a moving vehicle: no full route geometry every
  // second, just the remaining part of the current leg (and the next leg).
  function wire(t) {
    if (!t) return t;
    const { legs, ...rest } = t;
    const leg = t.phase === 'to_patient' ? legs?.toPatient : legs?.toHospital;
    return {
      ...rest,
      onRoad: Boolean(leg?.road),
      path: leg ? downsample(remainingPath(leg.coords, t.progress ?? 0), 60) : undefined,
      nextPath: t.phase === 'to_patient' && legs?.toHospital ? downsample(legs.toHospital.coords, 60) : undefined,
    };
  }
  const leg = (from, to) => ({ coords: straightLine(from, to), road: false });
  async function loadRoad(t, key, from, to) {
    if (!routeFn) return;
    try {
      const r = await routeFn(from, to);
      if (r?.coords?.length > 1) t.legs[key] = { coords: r.coords, road: true, km: r.km, min: r.min };
    } catch { /* keep the straight line */ }
  }
  const at = (lg, f) => { const p = pointAlong(lg.coords, f); return { lat: p[0], lng: p[1] }; };

  function publishMove(c) {
    const t = c.transport;
    const w = wire(t);
    publish(`case:${c.id}`, t.mode === 'ambulance' ? 'ambulance' : 'vehicle', w);
    publish(`track:${c.id}`, 'case', trackView(c));
    if (t.mode === 'ambulance') publish(`hospital:${c.hospitalId}`, 'ambulance', { caseId: c.id, ...w });
    else publish(`hospital:${c.hospitalId}`, 'position', { caseId: c.id, lat: t.position.lat, lng: t.position.lng, etaMin: t.etaMin, path: w.path, simulated: t.simulated });
  }

  function startTransport(caseId, { mode }) {
    const c = cases.get(caseId);
    if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
    if (c.status !== 'accepted') throw Object.assign(new Error('hospital has not accepted yet'), { status: 409 });
    const h = getHospital(c.hospitalId);
    c.status = 'enroute';
    if (mode !== 'ambulance') return startOwnVehicle(c, h);
    const pick = pickAmbulance(c.triage.ambulanceType, c.location);
    if (!pick) {
      c.transport = { mode: 'own', startedAt: now(), etaMin: c.etaMin, note: 'No ambulance free nearby' };
      log(c, 'enroute', 'No ambulance unit free nearby (simulated) – please use own vehicle or call 108; hospital is waiting');
      return c;
    }
    const amb = pick.a;
    amb.available = false;
    const hour = new Date().getHours();
    const toPatient = predictTravelMin(roadKm(amb, c.location), { hour, mode: 'ambulance' }).minutes;
    const toHospital = predictTravelMin(roadKm(c.location, h), { hour, mode: 'ambulance' }).minutes;
    const from = { lat: amb.lat, lng: amb.lng };
    const t = {
      mode: 'ambulance',
      simulated: true,
      ambulance: { id: amb.id, type: amb.type, base: amb.base },
      phase: 'to_patient', progress: 0,
      position: { ...from },
      from,
      etaToPatientMin: toPatient, etaToHospitalMin: toHospital,
      etaMin: toPatient + toHospital + 2,
      demoSpeed,
      startedAt: now(),
    };
    Object.defineProperty(t, 'legs', { value: { toPatient: leg(from, c.location), toHospital: leg(c.location, h) }, enumerable: false, writable: true });
    c.transport = t;
    log(c, 'dispatched', `Ambulance request handed to control room (SIMULATED) – unit ${amb.id} (${amb.type}) from ${amb.base}, ~${toPatient} min away`);
    loadRoad(t, 'toPatient', from, c.location);
    loadRoad(t, 'toHospital', c.location, h);
    simulateAmbulance(c, amb, h);
    return c;
  }

  function simulateAmbulance(c, amb, h) {
    const t = c.transport;
    let atPatientTicks = 0;
    const tick = () => {
      if (c.status !== 'enroute' || t.mode !== 'ambulance') return;
      if (t.phase === 'to_patient') {
        t.progress = Math.min(1, t.progress + demoSpeed / (t.etaToPatientMin * 60));
        t.position = at(t.legs.toPatient, t.progress);
        t.etaMin = Math.round(t.etaToPatientMin * (1 - t.progress) + t.etaToHospitalMin + 2);
        if (t.progress >= 1) { t.phase = 'at_patient'; t.progress = 0; t.position = { ...c.location }; log(c, 'at_patient', `Ambulance ${amb.id} reached the patient – paramedics stabilising`); }
      } else if (t.phase === 'at_patient') {
        if (++atPatientTicks >= 3) { t.phase = 'to_hospital'; log(c, 'to_hospital', `Patient on board – heading to ${h.name}`); }
      } else if (t.phase === 'to_hospital') {
        t.progress = Math.min(1, t.progress + demoSpeed / (t.etaToHospitalMin * 60));
        t.position = at(t.legs.toHospital, t.progress);
        t.etaMin = Math.max(0, Math.round(t.etaToHospitalMin * (1 - t.progress)));
        if (t.progress >= 1) { arrive(c.id); return; }
      }
      publishMove(c);
      later(tick, 1000);
    };
    later(tick, 1000);
  }

  // Own vehicle: real GPS from the family's phone when it moves; until then (and in
  // demo mode) the car is driven along the road route so everyone sees it travel.
  function startOwnVehicle(c, h) {
    const eta = Math.max(1, c.etaMin ?? predictTravelMin(roadKm(c.location, h), { hour: new Date().getHours() }).minutes);
    const t = {
      mode: 'own', startedAt: now(), etaMin: eta, etaToHospitalMin: eta,
      phase: 'to_hospital', progress: 0, position: { ...c.location },
      simulated: simulateOwnVehicle, gps: false,
    };
    Object.defineProperty(t, 'legs', { value: { toHospital: leg(c.location, h) }, enumerable: false, writable: true });
    c.transport = t;
    log(c, 'enroute', `Travelling by own vehicle to ${h.name} – ETA ${eta} min`);
    loadRoad(t, 'toHospital', c.location, h);
    if (!simulateOwnVehicle) return c;
    const tick = () => {
      if (c.status !== 'enroute' || t.mode !== 'own' || !t.simulated) return;
      t.progress = Math.min(1, t.progress + demoSpeed / (t.etaToHospitalMin * 60));
      t.position = at(t.legs.toHospital, t.progress);
      t.etaMin = Math.max(0, Math.round(t.etaToHospitalMin * (1 - t.progress)));
      if (t.progress >= 1) { arrive(c.id); return; }
      publishMove(c);
      later(tick, 1000);
    };
    later(tick, 1000);
    return c;
  }

  function updatePosition(caseId, { lat, lng, etaMin }) {
    const c = cases.get(caseId);
    if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
    const t = c.transport;
    if (t?.mode === 'own' && Number.isFinite(lat) && Number.isFinite(lng)) {
      // Real movement (> ~200 m from the pick-up point) takes over from the simulation.
      if (!t.gps && roadKm(c.location, { lat, lng }) / 1.35 < 0.2) return c;
      t.gps = true;
      t.simulated = false;
      t.position = { lat, lng };
      if (Number.isFinite(etaMin)) t.etaMin = etaMin;
      publishMove(c);
    }
    return c;
  }

  function arrive(caseId) {
    const c = cases.get(caseId);
    if (!c) throw Object.assign(new Error('case not found'), { status: 404 });
    if (c.status === 'arrived') return c;
    c.status = 'arrived';
    c.arrivedAt = now();
    const h = getHospital(c.hospitalId);
    if (c.transport?.mode === 'ambulance') {
      const amb = ambulances.find((a) => a.id === c.transport.ambulance.id);
      if (amb) { amb.available = true; Object.assign(amb, amb.home); }
      c.transport.progress = 1;
      c.transport.etaMin = 0;
      c.transport.position = { lat: h.lat, lng: h.lng };
    } else if (c.transport?.mode === 'own') {
      c.transport.progress = 1;
      c.transport.etaMin = 0;
      c.transport.position = { lat: h.lat, lng: h.lng };
    }
    log(c, 'arrived', `Patient arrived at ${h?.name} – handed over to the emergency team`);
    later(() => purge(caseId), retentionMs);
    return c;
  }

  // Retention policy: after the handover window, drop personal & health details.
  function purge(caseId) {
    const c = cases.get(caseId);
    if (!c || c.purged) return;
    c.patient = {};
    c.text = '';
    c.contact = null;
    c.vision = null;
    c.handover = c.handover ? { ...c.handover, text: '[purged after retention period]' } : null;
    c.location = c.location ? { lat: Math.round(c.location.lat * 100) / 100, lng: Math.round(c.location.lng * 100) / 100 } : null;
    c.purged = true;
    log(c, 'purged', 'Personal and health details deleted as per retention policy');
  }

  // ---------------------------------------------------------------- hospitals
  function statusView(h) {
    return { id: h.id, status: h.status, updatedAt: now() };
  }

  const BED_TYPES = ['icu', 'emergency', 'labour'];
  /**
   * Update a hospital's live status. `actor` is the authenticated staff member.
   * Any update – even with no changes ("confirm figures are current") –
   * re-verifies the data and stamps who verified it and when.
   */
  function updateHospitalStatus(id, patch = {}, actor = null) {
    const h = getHospital(id);
    if (!h) throw Object.assign(new Error('hospital not found'), { status: 404 });
    const s = h.status;
    const changes = [];
    const set = (label, before, after) => { if (before !== after) changes.push(`${label}: ${before} → ${after}`); };
    if (patch.erStatus && ['open', 'busy', 'diverting'].includes(patch.erStatus)) { set('ER', s.erStatus, patch.erStatus); s.erStatus = patch.erStatus; }
    if (patch.beds) {
      for (const [type, v] of Object.entries(patch.beds)) {
        if (!BED_TYPES.includes(type) || !s.beds[type] || !Number.isFinite(v?.free)) continue;
        const next = Math.max(0, Math.min(s.beds[type].total, Math.round(v.free)));
        set(`${type.toUpperCase()} beds free`, s.beds[type].free, next);
        s.beds[type].free = next;
      }
    }
    if (Array.isArray(patch.onDuty)) {
      const next = patch.onDuty.filter((c) => h.capabilities.includes(c));
      set('on duty', s.onDuty.join('+') || 'none', next.join('+') || 'none');
      s.onDuty = next;
    }
    if (Array.isArray(patch.equipmentDown)) {
      const next = patch.equipmentDown.filter((c) => h.capabilities.includes(c));
      set('equipment down', s.equipmentDown.join('+') || 'none', next.join('+') || 'none');
      s.equipmentDown = next;
    }
    if (Number.isFinite(patch.erQueue)) { const n = Math.max(0, Math.round(patch.erQueue)); set('ER queue', s.erQueue, n); s.erQueue = n; }
    if (Number.isFinite(patch.ventilatorsFree)) { const n = Math.max(0, Math.round(patch.ventilatorsFree)); set('ventilators free', s.ventilatorsFree, n); s.ventilatorsFree = n; }
    s.verifiedAt = now();
    s.updatedAt = s.verifiedAt;
    s.source = 'dashboard';
    s.verifiedBy = actor
      ? { staffId: actor.staffId, name: actor.name, role: actor.role, roleLabel: actor.roleLabel || roleLabel(actor.role) }
      : { name: 'System', role: 'system', roleLabel: 'System' };
    audit({ ...(actor || {}), hospitalId: id, action: changes.length ? 'status.updated' : 'status.verified', result: changes.join('; ') || 'figures confirmed current' });
    publish('hospitals', 'status', statusView(h));
    publish(`hospital:${id}`, 'status', statusView(h));
    return h;
  }

  // Optional random walk (off by default): in the real system figures only
  // change when authorised staff update them, so the demo keeps it off.
  function startStatusSimulation(intervalMs = 20000) {
    const step = () => {
      for (const h of hospitals) {
        if (h.status.source === 'dashboard') continue;
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
    createCase, getCase, checkCaseToken, checkTrackToken, requestAdmission, respond, startTransport, updatePosition, arrive, purge,
    getHospital, updateHospitalStatus, startStatusSimulation, stop,
    view, hospitalView, trackView, audit, auditFor,
  };
}
