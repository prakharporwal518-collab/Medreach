// Medreach – emergency case lifecycle, real-time events, audit and privacy.
//
//   new ──► requested ──► accepted ──► enroute ──► arrived ──► (patient data purged after retention)
//               │              │            │
//               │              └────┬───────┘
//               │                   ▼
//               │              rerouting  (hospital can no longer receive the patient → bed released,
//               │                   │      the server asks the next capable hospital; the ambulance keeps
//               │                   │      coming and is redirected as soon as one accepts)
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

import { sha256 } from '../shared/sha256.js';
import { HOSPITALS, AMBULANCES, SEED_VERIFIED_MIN_AGO } from './data/hospitals.js';
import { roadKm, predictTravelMin } from '../shared/predict.js';
import { roleLabel } from '../shared/roles.js';
import { pointAlong, downsample, remainingPath, straightLine } from '../shared/geo.js';
import { serviceFor, priorityFor, EMS_PHASES, pickUnit } from '../shared/ems.js';
import { updateCycle } from '../shared/freshness.js';

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
// Typical share of each group in India (negatives are rare – and run out first).
const BLOOD_SHARE = { 'A+': 0.22, 'A-': 0.02, 'B+': 0.32, 'B-': 0.02, 'O+': 0.35, 'O-': 0.02, 'AB+': 0.07, 'AB-': 0.01 };

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
  // Real 108/102 control room (server/ems.js createEmsClient); null → simulated control room.
  ems = null,
  // How often the 108-minute update cycle is checked (0 = never, e.g. in tests that drive it).
  reminderIntervalMs = 30000,
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
    // Demo blood-bank stock (units per group), sized by the hospital.
    if (h.capabilities.includes('blood_bank') && !h.status.blood) {
      const total = 20 + Object.values(h.status.beds).reduce((n, b) => n + b.total, 0) / 2;
      h.status.blood = Object.fromEntries(BLOOD_GROUPS.map((g, i) => [g, Math.round(total * BLOOD_SHARE[g]) + ((h.id.length + i) % 3)]));
    }
    h.status.erDoctors ??= 2;
  }
  const officers = new Map(); // hospitalId -> appointed Data Update Officer

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
  let incidentSeq = 0;
  const simulatedIncidentId = (service) => {
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${service}-MP-${ymd}-${String(++incidentSeq).padStart(5, '0')}`;
  };

  // ---------------------------------------------------------------- audit trail
  // Tamper-evident: every entry stores the hash of the previous one, so editing,
  // deleting or reordering any past entry breaks the chain (see verifyAudit).
  let auditSeq = 0;
  let auditAnchor = '0'.repeat(64); // hash before the oldest entry still kept
  const entryHash = ({ hash, ...rest }) => sha256(JSON.stringify(rest));
  function audit(entry) {
    const prev = auditLog.length ? auditLog[auditLog.length - 1].hash : auditAnchor;
    const e = { seq: ++auditSeq, at: now(), ...entry, prev };
    e.hash = entryHash(e);
    Object.freeze(e);
    auditLog.push(e);
    if (auditLog.length > 5000) auditAnchor = auditLog.shift().hash;
    if (e.hospitalId) publish(`hospital:${e.hospitalId}`, 'audit', e);
    return e;
  }
  const auditFor = (hospitalId) => auditLog.filter((e) => hospitalId === '*' || e.hospitalId === hospitalId).slice(-200).reverse();
  /** Re-check the whole chain. { ok, entries, brokenAt (seq) | null, head } */
  function verifyAudit(log = auditLog, anchor = auditAnchor) {
    let prev = anchor;
    for (const e of log) {
      if (e.prev !== prev || entryHash(e) !== e.hash) return { ok: false, entries: log.length, brokenAt: e.seq ?? null, head: null };
      prev = e.hash;
    }
    return { ok: true, entries: log.length, brokenAt: null, head: prev };
  }

  // ---------------------------------------------------------------- views (who sees what)
  // Citizen who created the case: everything except secrets & timers.
  function view(c) {
    const { responseTimer, accessToken, trackToken, ...rest } = c;
    if (rest.transport) rest.transport = wire(rest.transport);
    // Who released a bed stays in that hospital's audit log, not on the family's / other hospitals' screens.
    rest.reroutes = c.reroutes.map(({ by, ...x }) => x);
    rest.requests = c.requests.map(({ releasedBy, ...x }) => x);
    const h = c.hospitalId && getHospital(c.hospitalId);
    rest.destination = h ? { id: h.id, name: h.name, nameHi: h.nameHi, area: h.area, lat: h.lat, lng: h.lng } : null;
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
      rerouting: Boolean(c.reroute?.active),
      reroutes: c.reroutes.map((x) => ({ from: x.fromName, to: x.toName || null, at: x.at })),
      bay: c.bay,
      acceptedBy: c.acceptedBy ? { role: c.acceptedBy.roleLabel } : null,
      transport: c.transport ? (() => {
        const w = wire(c.transport);
        return { mode: w.mode, etaMin: w.etaMin, phase: w.phase, ambulance: w.ambulance?.id, simulated: w.simulated, gps: w.gps, position: w.position, path: w.path, nextPath: w.nextPath, onRoad: w.onRoad,
          incident: w.incident ? { id: w.incident.id, service: w.incident.service, status: w.incident.status } : null };
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

  function createCase({ triage, location, patient = {}, contact = null, lang = 'en', vision = null, text = '', consent = {}, alone = false, channel = 'app' }) {
    const id = `SS-${randomHex(3).toUpperCase()}`;
    const c = {
      id, createdAt: now(), status: 'new', lang, triage, location,
      consent: { patientDetails: Boolean(consent.patientDetails), location: true, at: now() },
      alone: Boolean(alone),
      channel: channel === 'sms' ? 'sms' : 'app',
      vision,
      accessToken: randomHex(16), // for the citizen's device
      trackToken: randomHex(12),  // read-only, limited view for the trusted contact
      hospitalId: null, bedType: null, etaMin: null, option: null, handover: null, bay: null,
      acceptedBy: null, acceptedAt: null, reportedCapacity: null,
      requests: [], transport: null, timeline: [],
      bedReserved: false, reroute: null, reroutes: [],
    };
    sealFields(c, {
      text: String(text || ''),
      // Data minimisation: patient details are only stored if the family consented to share them.
      patient: consent.patientDetails ? patient : {},
      contact: contact?.phone ? { name: contact.name || 'Trusted contact', phone: contact.phone } : null,
    });
    cases.set(id, c);
    log(c, 'created', `Emergency reported: ${triage.label} (${triage.severity})${alone ? ' – person is ALONE' : ''}`);
    if (c.contact && c.channel !== 'sms') {
      log(c, 'contact_notified',
        `Trusted contact ${c.contact.name} (${maskPhone(c.contact.phone)}) notified with live tracking link (SMS simulated in prototype)`);
    }
    return c;
  }

  /** Add a line to a case's timeline (e.g. an SMS that was sent). */
  function note(caseId, event, text, publicText) {
    const c = cases.get(caseId);
    if (c) log(c, event, text, publicText);
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
    if (c.reroute?.active && c.reroute.tried.includes(hospitalId)) {
      throw Object.assign(new Error('this hospital already released the patient'), { status: 409 });
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
    const reroute = Boolean(c.reroute?.active);
    if (reroute) c.reroute.tried.push(hospitalId);
    c.requests.push({ hospitalId, at: now(), outcome: 'pending', simulated: !consoleOnline, ...(reroute ? { reroute: true } : {}) });
    publish(`hospital:${hospitalId}`, 'request', hospitalView(c));
    log(c, 'requested', reroute
      ? `RE-ROUTE: referral sent to ${h.name} – waiting for acceptance${c.transport ? ' (the ambulance keeps coming)' : ''}`
      : `Referral request sent to ${h.name} – waiting for acceptance`,
    reroute ? `Finding the next hospital: asked ${h.name} to accept` : undefined);

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
      c.bedReserved = Boolean(beds && beds.free > 0);
      if (c.bedReserved) beds.free -= 1; // reserve the bed
      c.bay = bay || `${c.bedType === 'icu' ? 'Resus' : c.bedType === 'labour' ? 'Labour room' : 'ER'}-${String(1 + Math.floor(Math.random() * 8)).padStart(2, '0')}`;
      const by = who ? ` by ${who.roleLabel}${who.role !== 'simulated' ? ` (${who.name})` : ''}` : '';
      const rerouted = c.reroute?.active;
      if (rerouted && c.transport) c.status = 'enroute'; // the ambulance / car is already on its way
      log(c, 'accepted', `${h.name} ACCEPTED the ${rerouted ? 're-routed ' : ''}referral${by} – receiving bay ${c.bay}${note ? ` · ${note}` : ''}`,
        `${h.name} accepted – receiving bay ${c.bay}`);
      publish('hospitals', 'status', statusView(h));
      if (rerouted) finishReroute(c, h);
    } else {
      c.status = 'declined';
      log(c, 'declined', `${h.name} declined: ${reason || 'unable to admit'}`);
    }
    return c;
  }

  // ---------------------------------------------------------------- re-route (hospital can no longer receive)
  /**
   * The accepting hospital can no longer receive the patient (e.g. the reserved ICU
   * bed went to a critical walk-in). Releases the bed and marks the case for
   * re-routing; the API then asks the next capable hospital (server-side, so it
   * works even if the family's phone is offline). The ambulance keeps coming.
   */
  function releaseCase(caseId, hospitalId, { reason = '', actor = null } = {}) {
    const c = cases.get(caseId);
    const h = getHospital(hospitalId);
    if (!c || !h) throw Object.assign(new Error('case or hospital not found'), { status: 404 });
    if (c.hospitalId !== hospitalId || !['accepted', 'enroute'].includes(c.status) || c.reroute?.active) {
      throw Object.assign(new Error('only an accepted patient who has not arrived can be re-routed'), { status: 409 });
    }
    const why = String(reason || 'Bed no longer available').slice(0, 120);
    const who = actor ? { staffId: actor.staffId, name: actor.name, role: actor.role, roleLabel: actor.roleLabel || roleLabel(actor.role) } : null;
    if (c.bedReserved) {
      const beds = h.status.beds[c.bedType];
      if (beds) beds.free = Math.min(beds.total, beds.free + 1);
      c.bedReserved = false;
      publish('hospitals', 'status', statusView(h));
    }
    const req = [...c.requests].reverse().find((r) => r.hospitalId === hospitalId && r.outcome === 'accepted');
    if (req) Object.assign(req, { outcome: 'released', releasedAt: now(), releasedBy: who, releaseReason: why });
    if (actor && actor.role !== 'simulated') audit({ ...actor, hospitalId, action: 'referral.released', result: `${c.id} – ${why}` });
    const tried = [...new Set(c.requests.map((r) => r.hospitalId))];
    c.reroute = { active: true, fromHospitalId: hospitalId, fromName: h.name, reason: why, prevStatus: c.status, startedAt: now(), tried };
    c.reroutes.push({ fromHospitalId: hospitalId, fromName: h.name, reason: why, at: now(), by: who });
    c.status = 'rerouting';
    c.acceptedBy = null;
    c.bay = null;
    log(c, 'released', `${h.name} can no longer receive the patient (${why})${who ? ` – ${who.roleLabel}` : ''}. Bed released; Medreach is re-routing to the next capable hospital${c.transport ? ' – the ambulance keeps coming' : ''}`,
      `${h.name} can no longer receive the patient (${why}). Medreach is finding the next hospital${c.transport ? ' – the ambulance keeps coming' : ''}`);
    return c;
  }

  // A new hospital accepted the re-routed patient: point the vehicle there.
  function finishReroute(c, h) {
    const r = c.reroute;
    r.active = false;
    r.toHospitalId = h.id;
    const entry = c.reroutes.at(-1);
    if (entry) Object.assign(entry, { toHospitalId: h.id, toName: h.name, doneAt: now() });
    if (!c.transport) {
      c.status = 'accepted';
      log(c, 'rerouted', `Re-routed from ${r.fromName} to ${h.name} – choose how to travel`, `Re-routed to ${h.name}, which has accepted`);
      return;
    }
    c.status = 'enroute';
    redirectTransport(c, h);
  }

  /** No capable hospital accepted: go to the nearest open emergency department for stabilisation. */
  function stabiliseAt(caseId, hospitalId) {
    const c = cases.get(caseId);
    const h = getHospital(hospitalId);
    if (!c || !h || !c.reroute?.active) return c || null;
    c.hospitalId = h.id;
    c.requests.push({ hospitalId: h.id, at: now(), outcome: 'stabilisation' });
    c.stabilisation = true;
    c.bay = 'Emergency (stabilisation)';
    c.reroute.active = false;
    c.reroute.toHospitalId = h.id;
    const entry = c.reroutes.at(-1);
    if (entry) Object.assign(entry, { toHospitalId: h.id, toName: h.name, doneAt: now(), stabilisation: true });
    if (c.transport) { c.status = 'enroute'; redirectTransport(c, h, true); } else c.status = 'accepted';
    log(c, 'stabilisation', `No capable hospital could accept in time – going to the nearest open emergency department, ${h.name}, for stabilisation (emergency care cannot be refused). Call 108 if the condition worsens.`,
      `Going to ${h.name} emergency department for stabilisation – call 108 if the condition worsens`);
    publish(`hospital:${h.id}`, 'request', hospitalView(c));
    return c;
  }

  /** Nothing at all could be found: tell the family to call 108 (the vehicle keeps its course). */
  function rerouteFailed(caseId) {
    const c = cases.get(caseId);
    if (!c?.reroute?.active) return c || null;
    c.reroute.failed = true;
    log(c, 'reroute_failed', 'No other hospital could be reached – CALL 108 now; the ambulance crew will take the patient to the nearest emergency department',
      'No other hospital could be reached – please call 108 now');
    return c;
  }

  function redirectTransport(c, h, stabilisation = false) {
    const t = c.transport;
    const hour = new Date().getHours();
    const svc = t.incident?.service || '108';
    if (t.mode === 'ambulance' && !t.simulated) {
      // Real / practice control room: tell it the new destination over the signed contract.
      const say = (ok, extra = '') => log(c, ok ? 'dispatch_redirected' : 'dispatch_redirect_failed', ok
        ? `${svc} control room informed: new destination ${h.name}${extra}`
        : `Could not update the ${svc} control room${extra} – tell the crew by phone: take the patient to ${h.name}`,
      ok ? `Ambulance redirected to ${h.name}` : `Ambulance crew is being told to go to ${h.name}`);
      if (!ems?.redirect) { say(false, ' (no redirect channel)'); return; }
      Promise.resolve()
        .then(() => ems.redirect({ c, h, ref: t.incident.ref, incidentId: t.incident.id, reason: c.reroutes.at(-1)?.reason }))
        .then(() => say(true), (err) => say(false, ` (${String(err?.message || err).slice(0, 60)})`));
      return;
    }
    const going = t.phase === 'to_hospital' || t.mode === 'own';
    const from = going ? { ...(t.position || c.location) } : { ...c.location };
    t.legs.toHospital = leg(from, h);
    t.etaToHospitalMin = Math.max(1, predictTravelMin(roadKm(from, h), { hour, mode: t.mode === 'ambulance' ? 'ambulance' : 'private' }).minutes);
    if (going) t.progress = 0;
    const toPatientLeft = t.phase === 'to_patient' ? Math.round(t.etaToPatientMin * (1 - t.progress)) : 0;
    t.etaMin = going ? t.etaToHospitalMin : toPatientLeft + t.etaToHospitalMin + 2;
    loadRoad(t, 'toHospital', from, h);
    const what = t.mode === 'ambulance' ? `Ambulance ${t.ambulance?.id || ''}`.trim() : 'Your vehicle';
    log(c, 'rerouted', `${what} redirected to ${h.name}${stabilisation ? ' (stabilisation)' : ''} – about ${t.etaMin} min`,
      `${what} redirected to ${h.name} – about ${t.etaMin} min`);
    publishMove(c);
  }

  // ---------------------------------------------------------------- transport (SIMULATED)
  const pickAmbulance = (type, from) => pickUnit(ambulances, type, from);

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
    const service = serviceFor(c.triage);
    const incident = { ref: `MR-${c.id}`, id: null, service, priority: priorityFor(c.triage?.severity), channel: ems ? 'control-room' : 'simulated', status: 'requested' };
    if (ems) return dispatchToControlRoom(c, h, incident);
    const pick = pickAmbulance(c.triage.ambulanceType, c.location);
    if (!pick) {
      incident.status = 'no_unit';
      c.transport = { mode: 'own', startedAt: now(), etaMin: c.etaMin, note: 'No ambulance free nearby', incident };
      log(c, 'enroute', `No ambulance unit free nearby (simulated) – please use own vehicle or call ${service}; hospital is waiting`);
      return c;
    }
    const amb = pick.a;
    amb.available = false;
    const hour = new Date().getHours();
    const toPatient = predictTravelMin(roadKm(amb, c.location), { hour, mode: 'ambulance' }).minutes;
    const toHospital = predictTravelMin(roadKm(c.location, h), { hour, mode: 'ambulance' }).minutes;
    const from = { lat: amb.lat, lng: amb.lng };
    Object.assign(incident, { id: simulatedIncidentId(service), status: 'assigned' });
    const t = {
      mode: 'ambulance',
      simulated: true,
      incident,
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
    log(c, 'dispatched', `${service} control room (SIMULATED) created incident ${incident.id} – unit ${amb.id} (${amb.type}) from ${amb.base}, ~${toPatient} min away`,
      `${service} ambulance ${amb.id} assigned (incident ${incident.id}) – ~${toPatient} min away`);
    loadRoad(t, 'toPatient', from, c.location);
    loadRoad(t, 'toHospital', c.location, h);
    simulateAmbulance(c, amb);
    return c;
  }

  // Real control room: the incident goes to the state 108/102 CAD system; the
  // ambulance's position and status then arrive through emsUpdate().
  function dispatchToControlRoom(c, h, incident) {
    const t = { mode: 'ambulance', simulated: false, incident, ambulance: null, phase: 'requested', progress: 0, position: null, etaMin: null, startedAt: now() };
    c.transport = t;
    log(c, 'dispatch_requested', `Incident ${incident.ref} sent to the ${incident.service} control room – waiting for an ambulance to be assigned`);
    Promise.resolve()
      .then(() => ems.dispatch({ c, h, ref: incident.ref, service: incident.service, priority: incident.priority }))
      .then((res) => {
        if (c.transport !== t) return;
        incident.id = String(res.incidentId).slice(0, 64);
        incident.status = 'received';
        log(c, 'dispatched', `${incident.service} control room received the incident – number ${incident.id}`,
          `${incident.service} control room received the request (incident ${incident.id})`);
        if (res.unit || Number.isFinite(res.etaMin)) emsUpdate({ incidentRef: incident.ref, status: 'assigned', unit: res.unit, position: res.unit, etaMin: res.etaMin });
      })
      .catch((err) => {
        if (c.transport !== t) return;
        incident.status = 'failed';
        t.phase = 'failed';
        log(c, 'dispatch_failed', `${incident.service} control room could not be reached (${String(err?.message || err).slice(0, 80)}) – CALL ${incident.service} NOW and quote reference ${incident.ref}`,
          `Could not reach the ${incident.service} control room – please call ${incident.service} now`);
      });
    return c;
  }

  const inIndia = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && p.lat > 5 && p.lat < 38 && p.lng > 67 && p.lng < 99;
  /** Status from the control room (signed webhook). Returns the case, or null if unknown. */
  function emsUpdate({ incidentRef, incidentId, status, unit, position, etaMin, etaToPatientMin } = {}) {
    const c = [...cases.values()].find((x) => x.transport?.incident && (x.transport.incident.ref === incidentRef || (incidentId && x.transport.incident.id === String(incidentId))));
    if (!c || c.status === 'arrived') return c || null;
    const t = c.transport;
    const svc = t.incident.service;
    if (unit?.id) {
      const fresh = t.ambulance?.id !== String(unit.id);
      t.ambulance = { id: String(unit.id).slice(0, 32), type: String(unit.type || '').slice(0, 12), base: String(unit.base || '').slice(0, 60) };
      if (fresh) log(c, 'unit_assigned', `${svc} control room assigned ambulance ${t.ambulance.id}${t.ambulance.base ? ` from ${t.ambulance.base}` : ''}`, `${svc} ambulance ${t.ambulance.id} assigned`);
    }
    if (inIndia(position)) {
      t.position = { lat: position.lat, lng: position.lng };
      t.from ||= { ...t.position };
    }
    if (Number.isFinite(etaMin)) t.etaMin = Math.max(0, Math.round(etaMin));
    t.etaToPatientMin = Number.isFinite(etaToPatientMin) ? Math.max(0, Math.round(etaToPatientMin)) : null;
    if (status === 'arrived' || status === 'handed_over') { t.incident.status = 'completed'; arrive(c.id); return c; }
    if (status === 'cancelled') {
      t.incident.status = 'cancelled';
      t.phase = 'failed';
      log(c, 'dispatch_cancelled', `${svc} control room cancelled incident ${t.incident.id || t.incident.ref} – call ${svc} now`, `Ambulance request cancelled by the ${svc} control room – please call ${svc}`);
      return c;
    }
    const phase = EMS_PHASES[status];
    if (phase && phase !== t.phase) {
      t.phase = phase;
      t.incident.status = status;
      if (phase === 'at_patient') log(c, 'at_patient', `Ambulance ${t.ambulance?.id || ''} reached the patient`.trim());
      if (phase === 'to_hospital') log(c, 'to_hospital', `Patient on board – heading to ${getHospital(c.hospitalId)?.name}`);
    }
    if (t.position) publishMove(c);
    return c;
  }

  // Keeps moving while en route, and also while a re-route is being arranged.
  const moving = (c) => c.status === 'enroute' || Boolean(c.reroute?.active);

  function simulateAmbulance(c, amb) {
    const t = c.transport;
    let atPatientTicks = 0;
    const tick = () => {
      if (!moving(c) || c.transport !== t || t.mode !== 'ambulance') return;
      if (t.phase === 'to_patient') {
        t.progress = Math.min(1, t.progress + demoSpeed / (t.etaToPatientMin * 60));
        t.position = at(t.legs.toPatient, t.progress);
        t.etaMin = Math.round(t.etaToPatientMin * (1 - t.progress) + t.etaToHospitalMin + 2);
        if (t.progress >= 1) { t.phase = 'at_patient'; t.progress = 0; t.position = { ...c.location }; log(c, 'at_patient', `Ambulance ${amb.id} reached the patient – paramedics stabilising`); }
      } else if (t.phase === 'at_patient') {
        if (++atPatientTicks >= 3 && !c.reroute?.active) { t.phase = 'to_hospital'; log(c, 'to_hospital', `Patient on board – heading to ${getHospital(c.hospitalId)?.name}`); }
      } else if (t.phase === 'to_hospital' && c.reroute?.active) {
        // Hold course until the next hospital accepts (seconds in practice).
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
      if (!moving(c) || c.transport !== t || t.mode !== 'own' || !t.simulated) return;
      if (c.reroute?.active) { later(tick, 1000); return; } // hold until the next hospital accepts
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
      const amb = ambulances.find((a) => a.id === c.transport.ambulance?.id);
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
      const next = [...new Set(patch.onDuty)].filter((c) => h.capabilities.includes(c));
      set('on duty', s.onDuty.join('+') || 'none', next.join('+') || 'none');
      s.onDuty = next;
    }
    if (Array.isArray(patch.equipmentDown)) {
      const next = [...new Set(patch.equipmentDown)].filter((c) => h.capabilities.includes(c));
      set('equipment down', s.equipmentDown.join('+') || 'none', next.join('+') || 'none');
      s.equipmentDown = next;
    }
    if (patch.blood && typeof patch.blood === 'object' && s.blood) {
      for (const g of BLOOD_GROUPS) {
        const v = patch.blood[g];
        if (!Number.isFinite(v)) continue;
        const n = Math.max(0, Math.min(999, Math.round(v)));
        set(`blood ${g}`, s.blood[g], n);
        s.blood[g] = n;
      }
    }
    if (Number.isFinite(patch.erDoctors)) { const n = Math.max(0, Math.min(200, Math.round(patch.erDoctors))); set('ER doctors', s.erDoctors, n); s.erDoctors = n; }
    if (Number.isFinite(patch.erQueue)) { const n = Math.max(0, Math.min(500, Math.round(patch.erQueue))); set('ER queue', s.erQueue, n); s.erQueue = n; }
    if (Number.isFinite(patch.ventilatorsFree)) { const n = Math.max(0, Math.min(500, Math.round(patch.ventilatorsFree))); set('ventilators free', s.ventilatorsFree, n); s.ventilatorsFree = n; }
    s.verifiedAt = now();
    s.updatedAt = s.verifiedAt;
    s.source = 'dashboard';
    s.verifiedBy = actor
      ? { staffId: actor.staffId, name: actor.name, role: actor.role, roleLabel: actor.roleLabel || roleLabel(actor.role) }
      : { name: 'System', role: 'system', roleLabel: 'System' };
    const asOfficer = actor && officers.get(id)?.staffId === actor.staffId ? ' (as Data Update Officer)' : '';
    audit({ ...(actor || {}), hospitalId: id, action: changes.length ? 'status.updated' : 'status.verified', result: `${changes.join('; ') || 'figures confirmed current'}${asOfficer}` });
    reminded.delete(id); // a new 108-minute cycle starts now
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
    if (reminderTimer) clearInterval(reminderTimer);
  }

  // ---------------------------------------------------------------- 108-minute update cycle
  /** Nodal Officer appoints the staff member who keeps this hospital's availability updated. */
  function appointUpdateOfficer(hospitalId, staff, actor) {
    const h = getHospital(hospitalId);
    if (!h) throw Object.assign(new Error('hospital not found'), { status: 404 });
    const before = officers.get(hospitalId);
    if (staff) {
      officers.set(hospitalId, {
        staffId: staff.staffId, name: staff.name, role: staff.role, roleLabel: staff.roleLabel || roleLabel(staff.role),
        appointedAt: now(), appointedBy: actor ? { staffId: actor.staffId, name: actor.name, roleLabel: actor.roleLabel } : null,
      });
    } else officers.delete(hospitalId);
    const after = officers.get(hospitalId) || null;
    audit({ ...(actor || {}), hospitalId, action: 'officer.appointed', result: `Data Update Officer: ${before ? `${before.name} (${before.staffId})` : 'none'} → ${after ? `${after.name} (${after.staffId})` : 'none'}` });
    publish(`hospital:${hospitalId}`, 'officer', { officer: after });
    return after;
  }
  const updateOfficer = (hospitalId) => officers.get(hospitalId) || null;
  const isUpdateOfficer = (hospitalId, staffId) => Boolean(staffId) && officers.get(hospitalId)?.staffId === staffId;

  // Remind each hospital when its 108-minute update is coming up, due and overdue
  // (once per stage per cycle). "Due" and "overdue" are also written to the audit log.
  const reminded = new Map(); // hospitalId -> `${dueAt}|${state}`
  function checkUpdateCycles(at = Date.now()) {
    const sent = [];
    for (const h of hospitals) {
      const cyc = updateCycle(h.status.verifiedAt, at);
      if (cyc.state === 'ok') continue;
      const key = `${cyc.dueAt}|${cyc.state}`;
      if (reminded.get(h.id) === key) continue;
      reminded.set(h.id, key);
      const officer = officers.get(h.id) || null;
      const reminder = { hospitalId: h.id, ...cyc, lastUpdateAt: h.status.verifiedAt || null, officer };
      publish(`hospital:${h.id}`, 'reminder', reminder);
      if (cyc.state !== 'upcoming') {
        const late = cyc.minutesLeft === null ? 'never verified' : cyc.minutesLeft < 0 ? `${-cyc.minutesLeft} min late` : 'due now';
        audit({ hospitalId: h.id, name: 'System', role: 'system', roleLabel: 'System', action: cyc.state === 'due' ? 'update.reminder' : 'update.overdue',
          result: `108-minute availability update ${cyc.state} (${late})${officer ? ` – reminder to ${officer.name}` : ' – no Data Update Officer appointed'}${cyc.state === 'overdue' ? ' – escalated to Nodal Officer' : ''}` });
      }
      sent.push(reminder);
    }
    return sent;
  }
  const reminderTimer = reminderIntervalMs > 0 ? setInterval(() => checkUpdateCycles(), reminderIntervalMs) : null;
  reminderTimer?.unref?.();
  if (reminderTimer) later(() => checkUpdateCycles(), 1000);

  return {
    hospitals, ambulances, cases,
    subscribe, publish, listeners,
    createCase, getCase, checkCaseToken, checkTrackToken, requestAdmission, respond, startTransport, updatePosition, arrive, purge, emsUpdate, note,
    releaseCase, stabiliseAt, rerouteFailed,
    getHospital, updateHospitalStatus, startStatusSimulation, stop,
    appointUpdateOfficer, updateOfficer, isUpdateOfficer, checkUpdateCycles,
    view, hospitalView, trackView, audit, auditFor, verifyAudit,
  };
}
