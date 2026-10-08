import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
process.env.SEHAT_ROUTING = 'off';
const { createStore } = await import('../server/store.js');
const { createApp } = await import('../server/index.js');
const { createApi } = await import('../server/api.js');
const { createAuth } = await import('../server/auth.js');
const ems = await import('../server/ems.js');
const { buildEmergencySms, parseEmergencySms, maxSeverity } = await import('../shared/sms.js');
const { triage } = await import('../shared/triage.js');

const loc = { lat: 23.2355, lng: 77.4005 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return false; };

function acceptedCase(store, tri = triage('papa ko seene mein dard hai, pasina aa raha hai')) {
  const c = store.createCase({ triage: tri, location: loc, contact: { name: 'Rahul', phone: '9812345678' } });
  store.requestAdmission(c.id, { hospitalId: 'bansal', option: { bedType: 'icu', etaMin: 12 } });
  store.respond(c.id, 'bansal', { accept: true, bay: 'Resus-02', actor: { name: 'Desk', role: 'emergency_desk', roleLabel: 'Emergency Desk Officer' } });
  return c;
}

test('108 vs 102 and priorities; incident carries no identity without consent', () => {
  assert.equal(ems.serviceFor({ ambulanceType: 'JANANI' }), '102');
  assert.equal(ems.serviceFor({ ambulanceType: 'ALS' }), '108');
  assert.deepEqual(['critical', 'serious', 'moderate'].map(ems.priorityFor), ['P1', 'P2', 'P3']);
  const store = createStore({ simulatedResponseMs: 50 });
  const c = acceptedCase(store);
  const inc = ems.buildIncident({ c, h: store.getHospital('bansal'), ref: `MR-${c.id}`, service: '108', priority: 'P1' });
  assert.equal(inc.destination.accepted, true);
  assert.equal(inc.destination.bay, 'Resus-02');
  assert.equal(inc.patient, null);
  assert.equal(inc.callback, '9812345678');
  assert.deepEqual(inc.pickup, loc);
  store.stop();
});

test('signatures: valid, tampered and replayed requests', () => {
  const ts = Date.now();
  const body = JSON.stringify({ incidentRef: 'MR-1', status: 'assigned' });
  const signature = ems.sign('s3cret', ts, body);
  assert.ok(ems.verifySignature('s3cret', { timestamp: ts, signature, rawBody: body }));
  assert.ok(!ems.verifySignature('s3cret', { timestamp: ts, signature, rawBody: body.replace('assigned', 'arrived') }));
  assert.ok(!ems.verifySignature('other', { timestamp: ts, signature, rawBody: body }));
  assert.ok(!ems.verifySignature('s3cret', { timestamp: ts, signature, rawBody: body, now: ts + 10 * 60 * 1000 }));
});

test('simulated control room: incident number, 108 for heart attack, 102 for pregnancy', async () => {
  const store = createStore({ simulatedResponseMs: 50, demoSpeed: 30 });
  const c = acceptedCase(store);
  store.startTransport(c.id, { mode: 'ambulance' });
  assert.match(c.transport.incident.id, /^108-MP-\d{6}-\d{5}$/);
  assert.equal(c.transport.incident.channel, 'simulated');
  assert.equal(store.trackView(c).transport.incident.service, '108');
  const p = acceptedCase(store, triage('pregnant woman labour pain started'));
  store.startTransport(p.id, { mode: 'ambulance' });
  assert.equal(p.transport.incident.service, '102');
  assert.match(p.transport.incident.id, /^102-MP-/);
  store.stop();
});

test('real control room: signed incident out, status updates in, arrival', async () => {
  const sent = [];
  const fetchFn = async (url, opts) => {
    sent.push({ url, opts });
    return new Response(JSON.stringify({ incidentId: 'MP108-2026-778', unit: { id: '108-ALS-21', type: 'ALS', base: 'Kolar', lat: 23.18, lng: 77.41 }, etaMin: 9 }), { status: 200 });
  };
  const client = ems.createEmsClient({ url: 'https://cad.example/incidents', secret: 'k', fetchFn });
  const store = createStore({ simulatedResponseMs: 50, ems: client });
  const c = acceptedCase(store);
  store.startTransport(c.id, { mode: 'ambulance' });
  assert.equal(c.transport.phase, 'requested');
  assert.ok(await until(() => c.transport.ambulance?.id === '108-ALS-21'));
  const { opts } = sent[0];
  assert.ok(ems.verifySignature('k', { timestamp: opts.headers['X-Medreach-Timestamp'], signature: opts.headers['X-Medreach-Signature'], rawBody: opts.body }));
  assert.equal(JSON.parse(opts.body).incidentRef, `MR-${c.id}`);
  assert.equal(c.transport.incident.id, 'MP108-2026-778');
  assert.deepEqual(c.transport.position, { lat: 23.18, lng: 77.41 });
  assert.equal(c.transport.etaMin, 9);
  store.emsUpdate({ incidentRef: `MR-${c.id}`, status: 'at_patient', position: loc });
  assert.equal(c.transport.phase, 'at_patient');
  store.emsUpdate({ incidentId: 'MP108-2026-778', status: 'to_hospital', etaMin: 6 });
  assert.equal(c.transport.phase, 'to_hospital');
  store.emsUpdate({ incidentRef: `MR-${c.id}`, status: 'arrived' });
  assert.equal(c.status, 'arrived');
  assert.equal(store.emsUpdate({ incidentRef: 'MR-unknown', status: 'arrived' }), null);
  store.stop();
});

test('control room unreachable → the family is told to call 108', async () => {
  const client = ems.createEmsClient({ url: 'https://cad.example/x', secret: 'k', retries: 1, fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  const store = createStore({ simulatedResponseMs: 50, ems: client });
  const c = acceptedCase(store);
  store.startTransport(c.id, { mode: 'ambulance' });
  assert.ok(await until(() => c.transport.incident.status === 'failed'));
  assert.match(c.timeline.at(-1).text, /CALL 108 NOW/);
  assert.match(store.trackView(c).timeline.at(-1).text, /please call 108/);
  store.stop();
});

test('control-room webhook: signature required', async () => {
  const store = createStore({ simulatedResponseMs: 50, ems: { name: 'cad', dispatch: async () => ({ incidentId: 'X-1' }) } });
  const server = createApp(store, { dataMode: 'demo', env: { SEHAT_EMS_SECRET: 'hook' } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = acceptedCase(store);
    store.startTransport(c.id, { mode: 'ambulance' });
    await until(() => c.transport.incident.id === 'X-1');
    const body = JSON.stringify({ incidentRef: `MR-${c.id}`, status: 'assigned', unit: { id: 'U7', type: 'BLS' }, position: { lat: 23.25, lng: 77.42 }, etaMin: 11 });
    const ts = Date.now();
    const post = (headers, b = body) => fetch(`${base}/api/ems/updates`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: b });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'X-Medreach-Timestamp': String(ts), 'X-Medreach-Signature': ems.sign('wrong', ts, body) })).status, 401);
    const ok = await post({ 'X-Medreach-Timestamp': String(ts), 'X-Medreach-Signature': ems.sign('hook', ts, body) });
    assert.equal(ok.status, 200);
    assert.equal(c.transport.ambulance.id, 'U7');
    assert.equal(c.transport.etaMin, 11);
  } finally { store.stop(); server.close(); }
});

test('SMS format: the app writes it, the gateway reads it', () => {
  const tri = triage('heart attack');
  const sms = buildEmergencySms({ triage: tri, location: loc, hospital: { id: 'bansal', name: 'Bansal Hospital' } });
  assert.match(sms, /^MEDREACH SOS: .*23\.23550,77\.40050/);
  const p = parseEmergencySms(sms);
  assert.deepEqual([p.ok, p.type, p.severity, p.hospitalId, p.lang], [true, 'cardiac', 'critical', 'bansal', 'en']);
  assert.deepEqual(p.location, { lat: 23.2355, lng: 77.4005 });
  // Typed by hand, with coordinates.
  const hand = parseEmergencySms('saanp ne kaata 23.30, 77.35 jaldi');
  assert.equal(hand.ok, true);
  assert.deepEqual(hand.location, { lat: 23.3, lng: 77.35 });
  assert.equal(parseEmergencySms('help please').ok, false);
  assert.equal(parseEmergencySms('#MR1 cardiac C 51.5 -0.12 - en').ok, false); // outside India
  assert.equal(parseEmergencySms('x'.repeat(5000)).ok, false);
  assert.equal(maxSeverity('critical', 'serious'), 'critical');
  assert.equal(maxSeverity('moderate', 'serious'), 'serious');
});

function smsApi(store) {
  const outbox = [];
  const auth = createAuth({ demoMode: true, audit: store.audit });
  const api = createApi({ store, auth, dataMode: 'demo', smsSender: { live: true, send: async (to, text) => { outbox.push({ to, text }); return { sent: true }; } } });
  return { api, outbox };
}

test('SMS emergency: case created, hospital accepts, 108 ambulance requested, replies sent', async () => {
  const store = createStore({ simulatedResponseMs: 60, demoSpeed: 30 });
  const { api, outbox } = smsApi(store);
  const out = await api.smsEmergency({ from: '9876500011', text: buildEmergencySms({ triage: triage('heart attack'), location: loc }) });
  assert.equal(out.ok, true);
  assert.match(out.reply, /received\. Asking .* to accept/);
  const c = store.getCase(out.caseId);
  assert.equal(c.channel, 'sms');
  assert.ok(await until(() => outbox.some((m) => /ACCEPTED/.test(m.text))));
  assert.equal(c.transport.mode, 'ambulance');
  assert.match(outbox.find((m) => /ACCEPTED/.test(m.text)).text, /108 ambulance .* Incident 108-MP-/);
  assert.ok(c.timeline.some((e) => e.event === 'sms_sent'));
  // No location → only "call 108".
  const bad = await api.smsEmergency({ from: '9876500011', text: 'help heart attack' });
  assert.equal(bad.ok, false);
  assert.match(bad.reply, /CALL 108/);
  store.stop();
});

test('SMS emergency: if hospitals decline, the next is asked; if none can, the sender is told to call 108', async () => {
  const store = createStore({ simulatedResponseMs: 40 });
  for (const h of store.hospitals) for (const b of Object.values(h.status.beds)) b.free = 0;
  const { api, outbox } = smsApi(store);
  const out = await api.smsEmergency({ from: '9876500022', text: `snake bite #MR1 snakebite C 23.2355 77.4005 - en` });
  assert.ok(await until(() => outbox.some((m) => /No suitable hospital/.test(m.text)), 4000));
  assert.ok(outbox.some((m) => /could not accept\. Now asking/.test(m.text)));
  assert.ok(store.getCase(out.caseId).requests.length >= 2);
  store.stop();
});

test('SMS webhook (gateway key) and demo simulator', async () => {
  const store = createStore({ simulatedResponseMs: 50 });
  const server = createApp(store, { dataMode: 'demo', env: { SEHAT_SMS_SECRET: 'gw-key' }, smsSender: { live: false, send: async () => ({ sent: false, simulated: true }) } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const text = buildEmergencySms({ triage: triage('burns'), location: loc });
    assert.equal((await post('/api/sms/inbound', { from: '98', text }, { 'X-Medreach-Key': 'nope' })).status, 401);
    const r = await post('/api/sms/inbound', { from: '9876500033', text }, { 'X-Medreach-Key': 'gw-key' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.reply, /MEDREACH SS-/);
    const demo = await (await post('/api/sms/demo', { text })).json();
    assert.equal(demo.ok, true);
    assert.ok(demo.trackToken);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.ambulance.dispatch, 'simulated');
    assert.equal(cfg.smsDemo, true);
  } finally { store.stop(); server.close(); }
  // Without a secret the webhook does not exist; in live mode there is no simulator.
  const store2 = createStore({ simulatedResponseMs: 50 });
  const server2 = createApp(store2, { dataMode: 'live', env: {} }).listen(0);
  await new Promise((r) => server2.once('listening', r));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    assert.equal((await fetch(`${base2}/api/sms/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base2}/api/sms/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  } finally { store2.stop(); server2.close(); }
});

test('simulated control room sends the nearest suitable unit, not a far-away preferred type', () => {
  const store = createStore({ simulatedResponseMs: 50 });
  const village = { lat: 23.60123, lng: 77.40456 }; // near Berasia
  const c = store.createCase({ triage: triage('heart attack'), location: village });
  store.requestAdmission(c.id, { hospitalId: 'bmhrc', option: { bedType: 'icu', etaMin: 40 } });
  store.respond(c.id, 'bmhrc', { accept: true, actor: { name: 'Desk', role: 'emergency_desk', roleLabel: 'Desk' } });
  store.startTransport(c.id, { mode: 'ambulance' });
  assert.equal(c.transport.ambulance.id, '108-BLS-06'); // Berasia's own unit, not an ALS from Bhopal
  assert.ok(c.transport.etaToPatientMin < 15);
  store.stop();
});
