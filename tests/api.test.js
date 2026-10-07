import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1'; // deterministic: use the offline engines
process.env.SEHAT_ROUTING = 'off'; // no network calls from tests
const { createApp } = await import('../server/index.js');
const { createStore } = await import('../server/store.js');

let server;
let base;
let store;
const loc = { lat: 23.2355, lng: 77.4005 };

before(async () => {
  store = createStore({ simulatedResponseMs: 50, demoSpeed: 2000 });
  server = createApp(store, { dataMode: 'demo' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { store.stop(); server.close(); });

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const post = (path, body, headers) => call('POST', path, body, headers);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(hospitalId, staffId) {
  const otp = await post('/api/auth/otp', { hospitalId, staffId });
  assert.ok(otp.body.demoOtp, 'demo mode shows the OTP');
  const v = await post('/api/auth/verify', { hospitalId, staffId, otp: otp.body.demoOtp });
  assert.equal(v.status, 200);
  return { Authorization: `Bearer ${v.body.token}` };
}

async function newCase(text, extra = {}) {
  const tr = (await post('/api/triage', { text, lang: 'en' })).body;
  const created = await post('/api/cases', { triage: tr, location: loc, ...extra });
  assert.equal(created.status, 201);
  return { tr, id: created.body.id, h: { 'X-Case-Token': created.body.accessToken }, trackToken: created.body.trackToken };
}

test('flowchart end-to-end: emergency → AI → hospitals → acceptance → ambulance → arrived', async () => {
  const { tr, id, h } = await newCase('papa ko seene mein dard, 65 saal');
  assert.equal(tr.type, 'cardiac');

  const match = await post('/api/match', { triage: tr, location: loc });
  const best = match.body.options[0];
  assert.ok(best.checklist.some((i) => /Required capability available/.test(i.text)));
  assert.ok(best.checklist.some((i) => /Data source: Simulated demo data/.test(i.text)));
  assert.equal(best.breakdown.length >= 4, true);

  const req = await post(`/api/cases/${id}/request`, { hospitalId: best.hospital.id, option: { bedType: best.bedType, etaMin: best.etaMin, bed: best.bed } }, h);
  assert.equal(req.body.status, 'requested');
  assert.ok(req.body.reportedCapacity, 'reported capacity snapshot is kept separately');

  await wait(120); // simulated ER desk responds (no staff logged in)
  const accepted = (await call('GET', `/api/cases/${id}`, null, h)).body;
  assert.equal(accepted.status, 'accepted');
  assert.match(accepted.bay, /Resus-\d\d/);
  assert.equal(accepted.acceptedBy.role, 'simulated');

  const tp = await post(`/api/cases/${id}/transport`, { mode: 'ambulance' }, h);
  assert.equal(tp.body.transport.simulated, true);
  assert.match(tp.body.timeline.at(-1).text, /SIMULATED/);

  const arrived = await post(`/api/cases/${id}/arrived`, {}, h);
  assert.equal(arrived.body.status, 'arrived');
});

test('case endpoints require the case token', async () => {
  const { id } = await newCase('snake bite');
  assert.equal((await call('GET', `/api/cases/${id}`)).status, 403);
  assert.equal((await post(`/api/cases/${id}/request`, { hospitalId: 'aiims-bpl' }, { 'X-Case-Token': 'wrong' })).status, 403);
});

test('hospital console needs login; staff can only act for their own hospital', async () => {
  const { id, h } = await newCase('road accident');
  // No login → 401
  assert.equal((await post(`/api/hospitals/aiims-bpl/cases/${id}/respond`, { accept: true })).status, 401);
  // AIIMS desk officer cannot change Bansal's data → 403
  const aiimsDesk = await login('aiims-bpl', 'AIIMS-BPL-ED01');
  assert.equal((await call('PATCH', '/api/hospitals/bansal/status', { erStatus: 'busy' }, aiimsDesk)).status, 403);
  // Emergency desk may not edit bed counts (Resource Manager's job) → 403
  assert.equal((await call('PATCH', '/api/hospitals/aiims-bpl/status', { beds: { icu: { free: 1 } } }, aiimsDesk)).status, 403);

  // Keep a console "open" so no auto-response happens, then respond as the desk officer.
  const unsub = store.subscribe('hospital:aiims-bpl', { write() {} });
  await post(`/api/cases/${id}/request`, { hospitalId: 'aiims-bpl', option: { bedType: 'emergency', etaMin: 10 } }, h);
  const ok = await post(`/api/hospitals/aiims-bpl/cases/${id}/respond`, { accept: true, bay: 'Resus-02' }, aiimsDesk);
  assert.equal(ok.body.status, 'accepted');
  assert.equal(ok.body.acceptedBy.roleLabel, 'Emergency Desk Officer');
  assert.equal(ok.body.bay, 'Resus-02');
  unsub();

  // The action is in the audit log (visible to the nodal officer, not the desk).
  assert.equal((await call('GET', '/api/hospitals/aiims-bpl/audit', null, aiimsDesk)).status, 403);
  const nodal = await login('aiims-bpl', 'AIIMS-BPL-NO01');
  const log = (await call('GET', '/api/hospitals/aiims-bpl/audit', null, nodal)).body;
  assert.ok(log.some((e) => e.action === 'referral.accepted' && e.staffId === 'AIIMS-BPL-ED01'));
});

test('status update re-verifies data and records who did it', async () => {
  const rm = await login('bansal', 'BANSAL-RM01');
  const res = await call('PATCH', '/api/hospitals/bansal/status', { beds: { icu: { free: 2 } } }, rm);
  assert.equal(res.status, 200);
  assert.equal(res.body.status.source, 'dashboard');
  assert.equal(res.body.status.verifiedBy.roleLabel, 'Resource Manager');
  assert.ok(Date.now() - Date.parse(res.body.status.verifiedAt) < 5000);
});

test('dashboard change immediately changes what the citizen sees', async () => {
  const tr = (await post('/api/triage', { text: 'snake bite', lang: 'en' })).body;
  const before = (await post('/api/match', { triage: tr, location: loc })).body;
  assert.ok(before.options.some((o) => o.hospital.id === 'jp-hospital'));
  const rm = await login('jp-hospital', 'JP-HOSPITAL-RM01');
  await call('PATCH', '/api/hospitals/jp-hospital/status', { erStatus: 'diverting' }, rm);
  const after = (await post('/api/match', { triage: tr, location: loc })).body;
  assert.ok(!after.options.some((o) => o.hospital.id === 'jp-hospital'));
});

test('OTP brute force is blocked and wrong OTP is rejected', async () => {
  await post('/api/auth/otp', { hospitalId: 'hamidia', staffId: 'HAMIDIA-ED01' });
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/verify', { hospitalId: 'hamidia', staffId: 'HAMIDIA-ED01', otp: '000000' })).status, 401);
  assert.equal((await post('/api/auth/verify', { hospitalId: 'hamidia', staffId: 'HAMIDIA-ED01', otp: '000000' })).status, 429);
});

test('privacy: no consent → no patient details; hospital sees masked IDs; family sees no medical details', async () => {
  const patient = { name: 'Ramesh', age: 60, abhaId: '91-4521-7788-1203', allergies: ['Penicillin'] };
  const noConsent = await newCase('heart attack', { patient, consent: { patientDetails: false } });
  assert.deepEqual((await call('GET', `/api/cases/${noConsent.id}`, null, noConsent.h)).body.patient, {});

  const withConsent = await newCase('heart attack', { patient, consent: { patientDetails: true }, contact: { name: 'Son', phone: '9876543210' } });
  const hv = store.hospitalView(store.getCase(withConsent.id));
  assert.equal(hv.patient.abhaId, '••••1203');
  assert.equal(hv.contact, undefined);
  assert.equal(hv.text, undefined);

  const track = await call('GET', `/api/track/${withConsent.id}?t=${withConsent.trackToken}`);
  assert.equal(track.status, 200);
  assert.equal(track.body.patient, undefined);
  assert.ok(track.body.timeline.some((e) => /Trusted contact/.test(e.text)));
  assert.equal((await call('GET', `/api/track/${withConsent.id}?t=bad`)).status, 403);
});

test('retention: patient details are purged after arrival', async () => {
  const s = createStore({ retentionMs: 30, simulatedResponseMs: 10 });
  const c = s.createCase({ triage: (await post('/api/triage', { text: 'dog bite' })).body, location: loc, patient: { name: 'X' }, consent: { patientDetails: true } });
  s.requestAdmission(c.id, { hospitalId: 'jp-hospital', option: { bedType: 'emergency' } });
  await wait(40);
  s.arrive(c.id);
  await wait(60);
  assert.deepEqual(s.getCase(c.id).patient, {});
  assert.equal(s.getCase(c.id).purged, true);
  s.stop();
});

test('input validation', async () => {
  assert.equal((await post('/api/triage', { text: '' })).status, 400);
  assert.equal((await post('/api/match', { triage: {} })).status, 400);
  assert.equal((await post('/api/auth/otp', {})).status, 400);
});
