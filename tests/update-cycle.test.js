import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
process.env.SEHAT_ROUTING = 'off';
const { createStore } = await import('../server/store.js');
const { createApp } = await import('../server/index.js');
const { updateCycle, freshness, UPDATE_CYCLE_MIN } = await import('../shared/freshness.js');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (m) => new Date(NOW - m * 60000).toISOString();

test('108-minute cycle: ok → upcoming → due → overdue', () => {
  assert.equal(UPDATE_CYCLE_MIN, 108);
  assert.equal(updateCycle(ago(10), NOW).state, 'ok');
  assert.equal(updateCycle(ago(100), NOW).state, 'upcoming');
  assert.equal(updateCycle(ago(100), NOW).minutesLeft, 8);
  assert.equal(updateCycle(ago(108), NOW).state, 'due');
  assert.equal(updateCycle(ago(115), NOW).state, 'due');
  assert.equal(updateCycle(ago(130), NOW).state, 'overdue');
  assert.equal(updateCycle(null, NOW).state, 'overdue');
  assert.equal(updateCycle(ago(0), NOW).dueAt, new Date(NOW + 108 * 60000).toISOString());
  // Citizens see "unverified" exactly when the hospital has missed its update.
  assert.equal(freshness(ago(100), NOW).level, 'aging');
  assert.equal(freshness(ago(109), NOW).level, 'stale');
});

test('reminders: once per stage, logged when due/overdue, reset by an update', () => {
  const store = createStore({ reminderIntervalMs: 0 });
  const events = [];
  store.subscribe('hospital:bansal', { write: (p) => { if (p.startsWith('event: reminder')) events.push(JSON.parse(p.split('data: ')[1])); } });
  const h = store.getHospital('bansal');
  const t0 = Date.now();
  h.status.verifiedAt = new Date(t0 - 100 * 60000).toISOString();
  store.checkUpdateCycles(t0);
  store.checkUpdateCycles(t0 + 1000); // no duplicate
  assert.deepEqual(events.map((e) => e.state), ['upcoming']);
  store.checkUpdateCycles(t0 + 9 * 60000);
  store.checkUpdateCycles(t0 + 25 * 60000);
  assert.deepEqual(events.map((e) => e.state), ['upcoming', 'due', 'overdue']);
  const log = store.auditFor('bansal').map((e) => e.action);
  assert.ok(log.includes('update.reminder') && log.includes('update.overdue'));
  assert.match(store.auditFor('bansal')[0].result, /escalated to Nodal Officer/);
  // A full update starts a new cycle: no reminder until it is close again.
  store.updateHospitalStatus('bansal', { beds: { icu: { free: 2 } } }, { staffId: 'BANSAL-RM01', name: 'R', role: 'resource_manager' });
  events.length = 0;
  store.checkUpdateCycles(Date.now());
  assert.equal(events.length, 0);
  store.stop();
});

test('blood stock by group and ER doctors: validated and bounded', () => {
  const store = createStore({ reminderIntervalMs: 0 });
  const h = store.getHospital('aiims-bpl');
  assert.deepEqual(Object.keys(h.status.blood), ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-']);
  store.updateHospitalStatus('aiims-bpl', { blood: { 'O-': 4, 'AB-': -3, 'B+': 5000, 'X+': 9, 'A+': 'lots' }, erDoctors: 7 });
  assert.equal(h.status.blood['O-'], 4);
  assert.equal(h.status.blood['AB-'], 0);
  assert.equal(h.status.blood['B+'], 999);
  assert.ok(!('X+' in h.status.blood));
  assert.equal(h.status.erDoctors, 7);
  // No blood bank → no blood figures to fake.
  const noBank = store.getHospital('siddhanta');
  assert.equal(noBank.status.blood, undefined);
  store.updateHospitalStatus('siddhanta', { blood: { 'O+': 10 } });
  assert.equal(noBank.status.blood, undefined);
  store.stop();
});

test('Data Update Officer: appointed by the Nodal Officer, may then update everything', async () => {
  const store = createStore({ reminderIntervalMs: 0, simulatedResponseMs: 50 });
  const server = createApp(store, { dataMode: 'demo', env: {} }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const login = async (hospitalId, staffId) => {
    const o = await call('POST', '/api/auth/otp', { hospitalId, staffId });
    return (await call('POST', '/api/auth/verify', { hospitalId, staffId, otp: o.body.demoOtp })).body.token;
  };
  try {
    const nodal = await login('bansal', 'BANSAL-NO01');
    const desk = await login('bansal', 'BANSAL-ED01');
    const otherNodal = await login('aiims-bpl', 'AIIMS-BPL-NO01');
    const full = { erStatus: 'open', erQueue: 4, erDoctors: 3, beds: { icu: { free: 2 } }, onDuty: ['cardiology'], equipmentDown: [], ventilatorsFree: 2, blood: { 'O+': 12 } };

    // A desk officer alone may not update beds / blood (and a mixed patch checks EVERY field).
    assert.equal((await call('PATCH', '/api/hospitals/bansal/status', full, desk)).status, 403);
    assert.equal((await call('PATCH', '/api/hospitals/bansal/status', { erStatus: 'busy', blood: { 'O+': 1 } }, desk)).status, 403);
    // Only this hospital's Nodal Officer can appoint.
    assert.equal((await call('PUT', '/api/hospitals/bansal/update-officer', { staffId: 'BANSAL-ED01' }, desk)).status, 403);
    assert.equal((await call('PUT', '/api/hospitals/bansal/update-officer', { staffId: 'BANSAL-ED01' }, otherNodal)).status, 403);
    assert.equal((await call('PUT', '/api/hospitals/bansal/update-officer', { staffId: 'AIIMS-BPL-ED01' }, nodal)).status, 404);
    const staff = await call('GET', '/api/hospitals/bansal/staff', null, desk);
    assert.equal(staff.body.length, 3);
    assert.ok(staff.body.every((s) => !('mobile' in s)));
    const ap = await call('PUT', '/api/hospitals/bansal/update-officer', { staffId: 'BANSAL-ED01' }, nodal);
    assert.equal(ap.status, 200);
    assert.equal(ap.body.officer.name, staff.body.find((s) => s.staffId === 'BANSAL-ED01').name);
    // Now the appointed officer can submit the full update …
    const upd = await call('PATCH', '/api/hospitals/bansal/status', full, desk);
    assert.equal(upd.status, 200);
    assert.equal(upd.body.status.blood['O+'], 12);
    // … but not for another hospital.
    assert.equal((await call('PATCH', '/api/hospitals/aiims-bpl/status', full, desk)).status, 403);
    const dash = await call('GET', '/api/hospitals/bansal/dashboard', null, desk);
    assert.equal(dash.body.officer.staffId, 'BANSAL-ED01');
    assert.ok(store.auditFor('bansal').some((e) => e.action === 'officer.appointed'));
    assert.ok(store.auditFor('bansal').some((e) => /as Data Update Officer/.test(e.result || '')));
  } finally { store.stop(); server.close(); }
});
