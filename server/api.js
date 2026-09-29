// Sehat Setu – API routes, independent of the web framework.
// Used by server/index.js (Express) and by the single-file demo (in-browser),
// so both enforce exactly the same rules.
//
// Access model
//   • Citizen device   – X-Case-Token (returned once when the case is created)
//   • Trusted contact  – read-only track token (limited view, no medical details)
//   • Hospital staff   – Bearer session token from Hospital ID + Staff ID + OTP,
//                        bound to one hospital, permissions by role, all actions audited

import { triage as ruleTriage } from '../shared/triage.js';
import { rankHospitals, explain, scoreBreakdown, publicHospital } from '../shared/matching.js';
import { forecastArrivals } from '../shared/predict.js';
import { templateHandover } from '../shared/handover.js';
import { DEMO_LOCATION } from './data/hospitals.js';
import { STAFF } from './data/staff.js';
import { ROLES } from '../shared/roles.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function createApi({ store, auth, dataMode = 'demo', ai = null }) {
  const aiOn = () => Boolean(ai?.enabled());
  // Lets the single-file demo react to referrals (e.g. log the desk officer in).
  const hooks = { beforeRequest: async () => {}, afterRequest: () => {} };

  function caseFor(id, caseToken) {
    const c = store.getCase(id) || fail(404, 'case not found');
    if (!store.checkCaseToken(c, caseToken)) fail(403, 'not your case');
    return c;
  }

  // Which permission a status patch needs.
  function statusPermission(patch) {
    if (patch.beds) return 'status.beds';
    if (patch.onDuty) return 'status.duty';
    if (patch.equipmentDown || patch.ventilatorsFree !== undefined) return 'status.equipment';
    if (patch.erStatus || patch.erQueue !== undefined) return 'status.er';
    return 'status.verify';
  }

  const routes = [
    ['GET', /^\/api\/config$/, () => ({
      ai: aiOn(),
      dataMode,
      demoLocation: DEMO_LOCATION,
      emergencyNumber: '108',
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
      const c = store.createCase(body);
      // Tokens are returned exactly once, to the device that created the case.
      return { ...store.view(c), accessToken: c.accessToken, trackToken: c.trackToken, __status: 201 };
    }],
    ['GET', /^\/api\/cases\/([^/]+)$/, ({ params, caseToken }) => store.view(caseFor(params[0], caseToken))],
    ['POST', /^\/api\/cases\/([^/]+)\/request$/, async ({ params, body, caseToken }) => {
      const c = caseFor(params[0], caseToken);
      const { hospitalId, option } = body;
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
        });
      }
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

    // ---------------------------------------------------------------- trusted contact (read-only)
    ['GET', /^\/api\/track\/([^/]+)$/, ({ params, query }) => {
      const c = store.getCase(params[0]);
      if (!store.checkTrackToken(c, query.t)) fail(403, 'invalid tracking link');
      return store.trackView(c);
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
    ['PATCH', /^\/api\/hospitals\/([^/]+)\/status$/, ({ params, body, token }) => {
      const staff = auth.require(token, statusPermission(body), params[0]);
      return publicHospital(store.updateHospitalStatus(params[0], body, staff));
    }],
    ['GET', /^\/api\/hospitals\/([^/]+)\/dashboard$/, ({ params, token }) => {
      auth.require(token, 'cases.view', params[0]);
      const h = store.getHospital(params[0]) || fail(404, 'hospital not found');
      // Hospital-specific access: only referrals currently addressed to this hospital.
      const cases = [...store.cases.values()].filter((c) => c.hospitalId === h.id).map(store.hospitalView);
      return { hospital: publicHospital(h), cases, forecast: forecastArrivals(h, 8) };
    }],
    ['GET', /^\/api\/hospitals\/([^/]+)\/audit$/, ({ params, token }) => {
      auth.require(token, 'audit.view', params[0]);
      return store.auditFor(params[0]);
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

  return { handle, stream, hooks };
}
