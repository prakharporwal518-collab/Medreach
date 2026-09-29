import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1'; // deterministic: use the offline engines
const { createApp } = await import('../server/index.js');
const { createStore } = await import('../server/store.js');

let server;
let base;
let store;
const loc = { lat: 23.2355, lng: 77.4005 };

before(async () => {
  store = createStore({ simulatedResponseMs: 50, demoSpeed: 2000 });
  server = createApp(store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { store.stop(); server.close(); });

const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('flowchart end-to-end: emergency → AI → hospitals → acceptance → ambulance → arrived', async () => {
  const tr = await post('/api/triage', { text: 'papa ko seene mein dard, 65 saal', lang: 'en' });
  assert.equal(tr.status, 200);
  assert.equal(tr.body.type, 'cardiac');

  const match = await post('/api/match', { triage: tr.body, location: loc });
  assert.ok(match.body.options.length >= 2);
  const best = match.body.options[0];
  assert.ok(best.reasons.length >= 2);

  const created = await post('/api/cases', { triage: tr.body, location: loc });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const req = await post(`/api/cases/${id}/request`, { hospitalId: best.hospital.id, option: { bedType: best.bedType, etaMin: best.etaMin, bed: best.bed } });
  assert.equal(req.body.status, 'requested');
  assert.match(req.body.handover.text, /^S: /);

  await wait(120); // simulated ER desk responds
  const accepted = await (await fetch(`${base}/api/cases/${id}`)).json();
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.bay);

  const tp = await post(`/api/cases/${id}/transport`, { mode: 'ambulance' });
  assert.equal(tp.body.status, 'enroute');
  assert.equal(tp.body.transport.ambulance.type, 'ALS');

  const arrived = await post(`/api/cases/${id}/arrived`, {});
  assert.equal(arrived.body.status, 'arrived');
  assert.ok(arrived.body.timeline.length >= 5);
});

test('hospital console decline is respected and bed is reserved on accept', async () => {
  const tr = (await post('/api/triage', { text: 'road accident', lang: 'en' })).body;
  const id = (await post('/api/cases', { triage: tr, location: loc })).body.id;

  // Simulate an open console so no auto-response happens.
  const fakeRes = { write() {} };
  const unsub = store.subscribe('hospital:aiims-bpl', fakeRes);
  await post(`/api/cases/${id}/request`, { hospitalId: 'aiims-bpl', option: { bedType: 'emergency', etaMin: 10 } });
  const declined = await post(`/api/hospitals/aiims-bpl/cases/${id}/respond`, { accept: false, reason: 'CT down' });
  assert.equal(declined.body.status, 'declined');

  const freeBefore = store.getHospital('aiims-bpl').status.beds.emergency.free;
  await post(`/api/cases/${id}/request`, { hospitalId: 'aiims-bpl', option: { bedType: 'emergency', etaMin: 10 } });
  const ok = await post(`/api/hospitals/aiims-bpl/cases/${id}/respond`, { accept: true, bay: 'Bay 7' });
  assert.equal(ok.body.status, 'accepted');
  assert.equal(ok.body.bay, 'Bay 7');
  assert.equal(store.getHospital('aiims-bpl').status.beds.emergency.free, freeBefore - 1);
  unsub();
});

test('hospital status updates change routing immediately', async () => {
  const tr = (await post('/api/triage', { text: 'snake bite', lang: 'en' })).body;
  const res = await fetch(`${base}/api/hospitals/jp-hospital/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ erStatus: 'diverting' }),
  });
  assert.equal(res.status, 200);
  const match = (await post('/api/match', { triage: tr, location: loc })).body;
  assert.ok(!match.options.some((o) => o.hospital.id === 'jp-hospital'));
});

test('input validation', async () => {
  assert.equal((await post('/api/triage', { text: '' })).status, 400);
  assert.equal((await post('/api/match', { triage: {} })).status, 400);
  assert.equal((await post('/api/cases/NOPE/transport', { mode: 'own' })).status, 404);
});
