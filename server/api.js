// Medreach – API routes, independent of the web framework.
// Used by server/index.js (Express) and by the single-file demo (in-browser),
// so both enforce exactly the same rules.
//
// Access model
//   • Citizen device   – X-Case-Token (returned once when the case is created)
//   • Trusted contact  – read-only track token (limited view, no medical details)
//   • Hospital staff   – Bearer session token from Hospital ID + Staff ID + OTP,
//                        bound to one hospital, permissions by role, all actions audited
//   • Citizen account  – signed token after Aadhaar + OTP (optional: reporting an
//                        emergency never needs a login)

import { triage as ruleTriage } from '../shared/triage.js';
import { rankHospitals, explain, scoreBreakdown, publicHospital } from '../shared/matching.js';
import { forecastArrivals } from '../shared/predict.js';
import { templateHandover } from '../shared/handover.js';
import { DEMO_LOCATION } from './data/hospitals.js';
import { STAFF } from './data/staff.js';
import { ROLES, roleLabel } from '../shared/roles.js';
import { createCitizenAuth } from './citizen-auth.js';
import { parseEmergencySms, smsText, maxSeverity } from '../shared/sms.js';
import { checkCapability } from '../shared/capabilities.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

const NO_SMS = { live: false, send: async () => ({ sent: false, simulated: true }) };

export function createApi({
  store, auth, dataMode = 'demo', ai = null,
  citizenAuth = createCitizenAuth({ demoMode: dataMode === 'demo' }),
  // Integrations: real 108/102 control room, SMS gateway, public URL for links in SMS.
  integrations = { emsLive: false, smsNumber: null, publicUrl: '' },
  smsSender = NO_SMS,
}) {
  const aiOn = () => Boolean(ai?.enabled());
  // Lets the single-file demo react to referrals (e.g. log the desk officer in).
  const hooks = { beforeRequest: async () => {}, afterRequest: () => {} };

  function caseFor(id, caseToken) {
    const c = store.getCase(id) || fail(404, 'case not found');
    if (!store.checkCaseToken(c, caseToken)) fail(403, 'not your case');
    return c;
  }

  // Every permission a status patch needs (a full update touches several areas).
  function statusPermissions(patch) {
    const need = new Set();
    if (patch.beds) need.add('status.beds');
    if (patch.onDuty || patch.erDoctors !== undefined) need.add('status.duty');
    if (patch.equipmentDown || patch.ventilatorsFree !== undefined) need.add('status.equipment');
    if (patch.blood) need.add('status.blood');
    if (patch.erStatus || patch.erQueue !== undefined) need.add('status.er');
    if (!need.size) need.add('status.verify');
    return [...need];
  }

  // One path for every referral (app, "I'm alone", SMS): template handover now, AI upgrade later.
  async function requestHospital(c, hospitalId, option) {
    if (!store.getHospital(hospitalId)) fail(404, 'hospital not found');
    await hooks.beforeRequest(hospitalId);
    const draft = { ...c, bedType: option?.bedType, etaMin: option?.etaMin, patient: c.consent?.patientDetails ? c.patient : {} };
    store.requestAdmission(c.id, { hospitalId, option, handover: { text: templateHandover(draft), engine: 'template' } });
    hooks.afterRequest(hospitalId, store.listeners(`hospital:${hospitalId}`) > 0);
    if (aiOn()) {
      // Upgrade the handover note with Generative AI in the background.
      ai.handover(draft).then((handover) => {
        if (c.hospitalId !== hospitalId) return;
        c.handover = handover;
        store.publish(`hospital:${hospitalId}`, 'case', store.hospitalView(c));
      }).catch(() => {});
    }
    return c;
  }

  // ---------------------------------------------------------------- 📩 emergency by SMS (no mobile data needed)
  const SEV_LABEL = { critical: 'CRITICAL', serious: 'SERIOUS', moderate: 'MODERATE' };
  const maskTo = (p) => `••••••${String(p ?? '').replace(/\D/g, '').slice(-4)}`;
  const optionWire = (o) => ({ bedType: o.bedType, etaMin: o.etaMin, distanceKm: o.distanceKm, bed: o.bed, score: o.score });
  const trackLink = (c) => (integrations.publicUrl ? `${integrations.publicUrl.replace(/\/$/, '')}/report?track=${c.id}&t=${c.trackToken}` : '');

  async function sendSms(c, to, text) {
    if (!to || !text) return;
    try {
      const out = await smsSender.send(to, text);
      store.note(c.id, 'sms_sent', `SMS${out.simulated ? ' (simulated – no gateway)' : ''} to ${maskTo(to)}: ${text}`, `SMS to the reporter${out.simulated ? ' (simulated)' : ''}: ${text}`);
    } catch (err) {
      store.note(c.id, 'sms_failed', `SMS to ${maskTo(to)} could not be sent (${String(err?.message || err).slice(0, 80)})`);
    }
  }

  // Ask the ranked hospitals one after another; when one accepts, request the
  // 108/102 ambulance and tell the sender by SMS. Runs on the server, so it
  // continues even though the sender's phone has no internet.
  function orchestrateSms(c, options, from, lang) {
    let next = 0;
    let done = false;
    let accepted = false;
    const handled = new Set();
    const finish = () => { if (!done) { done = true; unsubscribe(); clearTimeout(timer); } };
    const tryNext = (previous) => {
      if (done) return;
      if (next >= options.length) { finish(); sendSms(c, from, smsText('no_hospital', { caseId: c.id }, lang)); return; }
      const o = options[next++];
      if (previous) sendSms(c, from, smsText('retry', { caseId: c.id, previous, hospital: o.hospital.name }, lang));
      requestHospital(c, o.hospital.id, optionWire(o)).catch(() => tryNext(o.hospital.name));
    };
    const onAccepted = () => {
      try { store.startTransport(c.id, { mode: 'ambulance' }); } catch { /* already moving */ }
      const h = store.getHospital(c.hospitalId);
      const t = c.transport;
      const svc = t?.incident?.service || '108';
      const amb = t?.mode === 'ambulance' && t.ambulance
        ? `${svc} ambulance ${t.ambulance.id} (${t.ambulance.type}) coming to you, about ${t.etaToPatientMin ?? t.etaMin} min away. Incident ${t.incident.id}.`
        : t?.mode === 'ambulance'
          ? `Your location was sent to the ${svc} control room (ref ${t.incident.ref}).`
          : `No ${svc} ambulance is free nearby – CALL ${svc} or go by own vehicle.`;
      sendSms(c, from, smsText('accepted', { caseId: c.id, hospital: h.name, bay: c.bay, ambulance: amb, track: trackLink(c) }, lang));
    };
    const unsubscribe = store.subscribe(`case:${c.id}`, {
      write() {
        if (done) return;
        if (c.status === 'accepted' && !accepted) { accepted = true; queueMicrotask(onAccepted); return; }
        const key = c.requests.length;
        if (accepted || c.reroute) return; // after acceptance any re-routing is handled by orchestrateReroute
        if (['declined', 'timeout'].includes(c.status) && !handled.has(key)) {
          handled.add(key);
          const previous = store.getHospital(c.hospitalId)?.name;
          queueMicrotask(() => tryNext(previous));
        }
        if (c.status === 'arrived') finish();
      },
    });
    const timer = setTimeout(finish, 3 * 60 * 60 * 1000);
    timer.unref?.();
    tryNext(null);
  }

  // ---------------------------------------------------------------- 🔁 auto re-route
  // The accepting hospital can no longer receive the patient. Ask the next capable
  // hospitals one by one (ranked from where the patient is now); the ambulance keeps
  // coming and is redirected the moment one accepts. If none can, go to the nearest
  // open emergency department for stabilisation. Server-side: works even if the
  // family's phone has no internet.
  function orchestrateReroute(c) {
    const r = c.reroute;
    const t = c.transport;
    const origin = t?.position && (t.phase === 'to_hospital' || t.mode === 'own') ? t.position : c.location;
    const mode = t?.mode === 'own' ? 'private' : 'ambulance';
    const pool = store.hospitals.filter((h) => !r.tried.includes(h.id));
    const ranked = rankHospitals(c.triage, origin, pool, { mode });
    const options = ranked.options.slice(0, 4);
    let next = 0;
    let done = false;
    const handled = new Set();
    const finish = () => { if (!done) { done = true; unsubscribe(); clearTimeout(timer); } };
    const fallback = () => {
      const er = [...ranked.options, ...ranked.excluded]
        .filter((o) => !c.reroute.tried.includes(o.hospital.id) && o.erStatus !== 'diverting' && checkCapability(o.hospital, 'emergency').live)
        .sort((a, b) => a.etaMin - b.etaMin)[0];
      if (er) store.stabiliseAt(c.id, er.hospital.id);
      else store.rerouteFailed(c.id);
    };
    const tryNext = () => {
      if (done) return;
      if (!c.reroute?.active) { finish(); return; }
      if (next >= options.length) { finish(); fallback(); return; }
      const o = options[next++];
      requestHospital(c, o.hospital.id, optionWire(o)).catch(() => tryNext());
    };
    const unsubscribe = store.subscribe(`case:${c.id}`, {
      write() {
        if (done) return;
        if (!c.reroute?.active) {
          finish();
          const phone = c.channel === 'sms' ? c.contact?.phone : null;
          const to = store.getHospital(c.hospitalId);
          if (phone && to && ['accepted', 'enroute'].includes(c.status)) {
            queueMicrotask(() => sendSms(c, phone, smsText('rerouted', { caseId: c.id, previous: r.fromName, hospital: to.name }, c.lang === 'hi' ? 'hi' : 'en')));
          }
          return;
        }
        const key = c.requests.length;
        if (['declined', 'timeout'].includes(c.status) && !handled.has(key)) {
          handled.add(key);
          queueMicrotask(tryNext);
        }
      },
    });
    const timer = setTimeout(finish, 60 * 60 * 1000);
    timer.unref?.();
    tryNext();
  }

  async function smsEmergency({ from = null, text = '' } = {}) {
    const p = parseEmergencySms(text);
    const lang = p.lang === 'hi' ? 'hi' : 'en';
    if (!p.ok) return { ok: false, reply: smsText('no_location', {}, lang) };
    let tri = ruleTriage(p.text || '', { lang, hintType: p.type });
    if (p.severity && maxSeverity(p.severity, tri.severity) !== tri.severity) {
      const severity = maxSeverity(p.severity, tri.severity);
      tri = { ...tri, severity, ambulanceType: tri.type === 'pregnancy' && severity !== 'critical' ? 'JANANI' : severity === 'critical' ? 'ALS' : 'BLS' };
    }
    const c = store.createCase({
      triage: tri, location: p.location, lang, channel: 'sms',
      text: `[SMS] ${p.text}`.trim(), consent: { patientDetails: false },
      contact: from ? { name: 'SMS sender', phone: String(from) } : null,
    });
    store.note(c.id, 'sms_received', `Emergency received by SMS from ${maskTo(from)}`, 'Emergency received by SMS');
    const ranked = rankHospitals(tri, p.location, store.hospitals, { mode: 'ambulance' });
    const options = [...(ranked.stabilise ? [ranked.stabilise] : []), ...ranked.options];
    const pref = options.findIndex((o) => o.hospital.id === p.hospitalId);
    if (pref > 0) options.unshift(...options.splice(pref, 1));
    const list = options.slice(0, 4);
    if (!list.length) {
      const reply = smsText('no_hospital', { caseId: c.id }, lang);
      return { ok: true, caseId: c.id, trackToken: c.trackToken, reply };
    }
    orchestrateSms(c, list, from, lang);
    const reply = smsText('received', { caseId: c.id, label: tri.label, severity: SEV_LABEL[tri.severity], hospital: list[0].hospital.name }, lang);
    return { ok: true, caseId: c.id, trackToken: c.trackToken, reply };
  }

  const routes = [
    ['GET', /^\/api\/config$/, () => ({
      ai: aiOn(),
      dataMode,
      demoLocation: DEMO_LOCATION,
      emergencyNumber: '108',
      citizenSignIn: citizenAuth.enabled() ? 'aadhaar-otp' : 'unavailable',
      ambulance: { numbers: { emergency: '108', mother: '102', all: '112' }, dispatch: integrations.emsLive ? (integrations.emsPractice ? 'practice' : 'control-room') : 'simulated' },
      smsNumber: integrations.smsNumber || null,
      smsDemo: dataMode === 'demo',
      simulated: dataMode === 'demo'
        ? { hospitalData: true, ambulanceDispatch: true, hospitalResponseWhenNoStaffLoggedIn: true, sms: true }
        : { hospitalData: false, ambulanceDispatch: true, hospitalResponseWhenNoStaffLoggedIn: false, sms: false },
    })],

    // ---------------------------------------------------------------- 🧠 AI understands (NLP → requirements)
    ['POST', /^\/api\/triage$/, async ({ body }) => {
      const { text = '', lang = 'en', answers = {}, hintType = null, visionFindings = '' } = body;
      if (!text.trim() && !hintType) fail(400, 'describe the emergency or pick a type');
      const rule = ruleTriage(visionFindings ? `${text}\n${visionFindings}` : text, { lang, answers, hintType });
      return aiOn() ? ai.triage({ text, lang, answers, visionFindings, ruleResult: rule }) : rule;
    }],
    ['POST', /^\/api\/vision$/, async ({ body }) => {
      const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(body.image || '');
      if (!m) fail(400, 'send image as a base64 data URL');
      if (!aiOn()) return { ai: false };
      const out = await ai.vision({ imageBase64: m[2], mediaType: m[1], lang: body.lang });
      return { ai: out?.engine === 'claude-vision', ...out };
    }],

    // ---------------------------------------------------------------- 🏥 deterministic matching
    ['GET', /^\/api\/hospitals$/, () => store.hospitals.map(publicHospital)],
    // Public fleet status: unit, type, base and whether it is free. Never patient data or live position.
    ['GET', /^\/api\/ambulances$/, () => {
      // Availability comes from whichever fleet dispatches: the practice 108 control room's, else the built-in one.
      const live = integrations.liveFleet?.();
      const busy = live ? new Map(live.map((u) => [u.id, u.available])) : null;
      return store.ambulances.map(({ id, type, base, area, home, lat, lng, available }) => ({
        id, type, base, area, lat: (home || { lat }).lat, lng: (home || { lng }).lng,
        available: Boolean(busy?.has(id) ? busy.get(id) : available),
      }));
    }],
    ['POST', /^\/api\/match$/, ({ body }) => {
      const { triage, location, mode = 'ambulance', lang = 'en', excludeIds = [] } = body;
      if (!triage?.required || !Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
        fail(400, 'triage and location {lat,lng} are required');
      }
      const result = rankHospitals(triage, location, store.hospitals.filter((h) => !excludeIds.includes(h.id)), { mode });
      for (const o of [...result.options, ...(result.stabilise ? [result.stabilise] : [])]) {
        o.checklist = explain(o, lang);
        o.breakdown = scoreBreakdown(o, lang);
      }
      return result;
    }],

    // ---------------------------------------------------------------- cases (citizen)
    ['POST', /^\/api\/cases$/, ({ body }) => {
      if (!body.triage || !body.location) fail(400, 'triage and location are required');
      const c = store.createCase({ ...body, channel: 'app' });
      // Tokens are returned exactly once, to the device that created the case.
      return { ...store.view(c), accessToken: c.accessToken, trackToken: c.trackToken, __status: 201 };
    }],
    ['GET', /^\/api\/cases\/([^/]+)$/, ({ params, caseToken }) => store.view(caseFor(params[0], caseToken))],
    ['POST', /^\/api\/cases\/([^/]+)\/request$/, async ({ params, body, caseToken }) => {
      const c = caseFor(params[0], caseToken);
      await requestHospital(c, body.hospitalId, body.option);
      return store.view(c);
    }],
    ['POST', /^\/api\/cases\/([^/]+)\/transport$/, ({ params, body, caseToken }) => {
      caseFor(params[0], caseToken);
      return store.view(store.startTransport(params[0], { mode: body.mode }));
    }],
    ['POST', /^\/api\/cases\/([^/]+)\/position$/, ({ params, body, caseToken }) => {
      caseFor(params[0], caseToken);
      return { ok: true, status: store.updatePosition(params[0], body).status };
    }],
    ['POST', /^\/api\/cases\/([^/]+)\/arrived$/, ({ params, caseToken }) => {
      caseFor(params[0], caseToken);
      return store.view(store.arrive(params[0]));
    }],

    // Demo only: try the SMS channel without a phone (same code path as the real gateway webhook).
    ['POST', /^\/api\/sms\/demo$/, async ({ body }) => {
      if (dataMode !== 'demo') fail(404, 'not found');
      return smsEmergency({ from: '9000000000', text: String(body.text || '') });
    }],

    // ---------------------------------------------------------------- trusted contact (read-only)
    ['GET', /^\/api\/track\/([^/]+)$/, ({ params, query }) => {
      const c = store.getCase(params[0]);
      if (!store.checkTrackToken(c, query.t)) fail(403, 'invalid tracking link');
      return store.trackView(c);
    }],

    // ---------------------------------------------------------------- citizen sign-in (Aadhaar + OTP)
    ['POST', /^\/api\/citizen\/otp$/, ({ body }) => citizenAuth.requestOtp({ aadhaar: body.aadhaar, consent: body.consent })],
    ['POST', /^\/api\/citizen\/verify$/, ({ body }) => citizenAuth.verifyOtp({ txnId: body.txnId, otp: body.otp, name: body.name })],
    ['GET', /^\/api\/citizen\/me$/, async ({ token }) => ({ citizen: (await citizenAuth.session(token)) || fail(401, 'Please sign in again') })],
    ['GET', /^\/api\/citizen\/demo-ids$/, () => {
      if (dataMode !== 'demo') fail(404, 'not found');
      return citizenAuth.demoIdentities();
    }],

    // ---------------------------------------------------------------- hospital staff auth
    ['POST', /^\/api\/auth\/otp$/, ({ body }) => {
      if (!body.hospitalId || !body.staffId) fail(400, 'Hospital ID and Staff ID are required');
      return auth.requestOtp(body.hospitalId, body.staffId);
    }],
    ['POST', /^\/api\/auth\/verify$/, ({ body }) => auth.verifyOtp(body.hospitalId, body.staffId, body.otp)],
    ['POST', /^\/api\/auth\/logout$/, ({ token }) => { auth.logout(token); return { ok: true }; }],
    ['GET', /^\/api\/auth\/me$/, ({ token }) => {
      const staff = auth.session(token) || fail(401, 'Login required');
      return { staff, permissions: ROLES[staff.role].can };
    }],
    // Demo only: list staff IDs so judges can log in without a phone.
    ['GET', /^\/api\/auth\/demo-staff$/, ({ query }) => {
      if (dataMode !== 'demo') fail(404, 'not found');
      return STAFF.filter((s) => !query.hospitalId || s.hospitalId === query.hospitalId || s.role === 'admin')
        .map(({ staffId, hospitalId, name, role }) => ({ staffId, hospitalId, name, role, roleLabel: ROLES[role].label }));
    }],

    // ---------------------------------------------------------------- hospital console (authorised)
    ['POST', /^\/api\/hospitals\/([^/]+)\/cases\/([^/]+)\/respond$/, ({ params, body, token }) => {
      const staff = auth.require(token, 'referral.respond', params[0]);
      const c = store.respond(params[1], params[0], { accept: Boolean(body.accept), reason: body.reason, bay: body.bay, actor: staff });
      return store.hospitalView(c);
    }],
    // Accepted patient can no longer be received here → release the bed and auto re-route.
    ['POST', /^\/api\/hospitals\/([^/]+)\/cases\/([^/]+)\/release$/, ({ params, body, token }) => {
      const staff = auth.require(token, 'referral.respond', params[0]);
      const c = store.releaseCase(params[1], params[0], { reason: String(body.reason || '').trim().slice(0, 120), actor: staff });
      orchestrateReroute(c);
      return store.hospitalView(c);
    }],
    ['PATCH', /^\/api\/hospitals\/([^/]+)\/status$/, ({ params, body, token }) => {
      const staff = auth.session(token) || fail(401, 'Login required');
      // The appointed Data Update Officer may update every availability field of their hospital.
      const delegated = staff.hospitalId === params[0] && store.isUpdateOfficer(params[0], staff.staffId);
      if (!delegated) for (const p of statusPermissions(body)) auth.require(token, p, params[0]);
      return publicHospital(store.updateHospitalStatus(params[0], body, staff));
    }],
    // Staff of this hospital (for appointing the Data Update Officer). No phone numbers.
    ['GET', /^\/api\/hospitals\/([^/]+)\/staff$/, ({ params, token }) => {
      auth.require(token, 'cases.view', params[0]);
      return STAFF.filter((s) => s.hospitalId === params[0]).map(({ staffId, name, role }) => ({ staffId, name, role, roleLabel: roleLabel(role) }));
    }],
    ['PUT', /^\/api\/hospitals\/([^/]+)\/update-officer$/, ({ params, body, token }) => {
      const actor = auth.require(token, 'officer.appoint', params[0]);
      const staff = body.staffId ? STAFF.find((s) => s.hospitalId === params[0] && s.staffId.toLowerCase() === String(body.staffId).toLowerCase()) : null;
      if (body.staffId && !staff) fail(404, 'No such staff member at this hospital');
      return { officer: store.appointUpdateOfficer(params[0], staff && { staffId: staff.staffId, name: staff.name, role: staff.role }, actor) };
    }],
    ['GET', /^\/api\/hospitals\/([^/]+)\/dashboard$/, ({ params, token }) => {
      auth.require(token, 'cases.view', params[0]);
      const h = store.getHospital(params[0]) || fail(404, 'hospital not found');
      // Hospital-specific access: only referrals currently addressed to this hospital.
      const cases = [...store.cases.values()].filter((c) => c.hospitalId === h.id).map(store.hospitalView);
      return { hospital: publicHospital(h), cases, forecast: forecastArrivals(h, 8), officer: store.updateOfficer(h.id) };
    }],
    ['GET', /^\/api\/hospitals\/([^/]+)\/audit$/, ({ params, token }) => {
      auth.require(token, 'audit.view', params[0]);
      return store.auditFor(params[0]);
    }],
    // Integrity check of the tamper-evident (hash-chained) audit log.
    ['GET', /^\/api\/hospitals\/([^/]+)\/audit\/verify$/, ({ params, token }) => {
      auth.require(token, 'audit.view', params[0]);
      return store.verifyAudit();
    }],
  ];

  /** Handle one API call. Returns { status, data }. */
  async function handle({ method, path, body = {}, query = {}, token = null, caseToken = null }) {
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(path);
      if (!match) continue;
      try {
        const data = await fn({ params: match.slice(1), body: body || {}, query, token, caseToken });
        const status = data?.__status || 200;
        if (data && data.__status) delete data.__status;
        return { status, data };
      } catch (err) {
        return { status: err.status || 500, data: { error: err.message } };
      }
    }
    return { status: 404, data: { error: 'not found' } };
  }

  /**
   * Subscribe to a live stream. `onEvent(event, jsonString)`. Returns
   * { unsubscribe, initial } or throws { status } if not authorised.
   */
  function stream(path, query, onEvent) {
    let m;
    const res = { write(payload) { const e = /^event: (.*)\ndata: (.*)\n\n$/s.exec(payload); if (e) onEvent(e[1], e[2]); } };
    if ((m = path.match(/^\/api\/stream\/case\/([^/]+)$/))) {
      const c = store.getCase(m[1]);
      if (!store.checkCaseToken(c, query.t)) fail(403, 'not your case');
      return { unsubscribe: store.subscribe(`case:${c.id}`, res), initial: ['case', store.view(c)] };
    }
    if ((m = path.match(/^\/api\/stream\/track\/([^/]+)$/))) {
      const c = store.getCase(m[1]);
      if (!store.checkTrackToken(c, query.t)) fail(403, 'invalid tracking link');
      return { unsubscribe: store.subscribe(`track:${c.id}`, res), initial: ['case', store.trackView(c)] };
    }
    if ((m = path.match(/^\/api\/stream\/hospital\/([^/]+)$/))) {
      auth.require(query.token, 'cases.view', m[1]);
      return { unsubscribe: store.subscribe(`hospital:${m[1]}`, res), initial: null };
    }
    if (path === '/api/stream/hospitals') return { unsubscribe: store.subscribe('hospitals', res), initial: null };
    fail(404, 'not found');
  }

  return { handle, stream, hooks, smsEmergency };
}
