import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
process.env.SEHAT_ROUTING = 'off';
const { createStore } = await import('../server/store.js');
const { createApp } = await import('../server/index.js');
const { createEmsClient, sign } = await import('../server/ems.js');
const { triage } = await import('../shared/triage.js');

const SECRET = 'practice-secret-for-tests';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; };

// A real HTTP server where Medreach talks to the practice control room over the
// signed contract, and the control room reports back to /api/ems/updates.
async function boot(extraEnv = {}) {
  const holder = {};
  const store = createStore({ simulatedResponseMs: 50, reminderIntervalMs: 0, ems: { name: 'cad', dispatch: (x) => holder.client.dispatch(x) } });
  const env = {
    SEHAT_PRACTICE_CAD: 'on', SEHAT_EMS_SECRET: SECRET, SEHAT_ROUTING: 'off',
    SEHAT_DEMO_SPEED: '600', SEHAT_PRACTICE_CAD_ASSIGN_MS: '50', SEHAT_PRACTICE_CAD_TICK_MS: '60',
    SEHAT_EMS_URL: 'http://placeholder/api/practice-cad/incidents', ...extraEnv,
  };
  const app = createApp(store, { dataMode: 'demo', env });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  env.SEHAT_EMS_URL = `${base}/api/practice-cad/incidents`;
  env.SEHAT_EMS_CALLBACK_URL = `${base}/api/ems/updates`;
  holder.client = createEmsClient({ url: env.SEHAT_EMS_URL, secret: SECRET });
  const close = () => { app.locals.practiceCad?.stop(); store.stop(); server.close(); };
  return { store, base, close, practice: app.locals.practiceCad };
}

function acceptedCase(store, text = 'papa ko seene mein dard hai, pasina aa raha hai') {
  const c = store.createCase({ triage: triage(text), location: { lat: 23.2355, lng: 77.4005 }, contact: { name: 'Rahul', phone: '9812345678' } });
  store.requestAdmission(c.id, { hospitalId: 'bansal', option: { bedType: 'icu', etaMin: 12 } });
  store.respond(c.id, 'bansal', { accept: true, bay: 'Resus-02', actor: { name: 'Desk', role: 'emergency_desk', roleLabel: 'Emergency Desk Officer' } });
  return c;
}

test('practice control room: signed incident in, unit dispatched, signed updates back, arrival', async () => {
  const { store, base, close } = await boot();
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.ambulance.dispatch, 'practice');
    const c = acceptedCase(store);
    store.startTransport(c.id, { mode: 'ambulance' });
    assert.equal(c.transport.phase, 'requested');
    assert.ok(await until(() => /^PRACTICE-108-\d{6}-\d{4}$/.test(c.transport.incident.id || '')), 'incident number from the control room');
    assert.ok(await until(() => c.transport.ambulance?.id), 'unit assigned through the webhook');
    assert.ok(c.transport.position && Number.isFinite(c.transport.etaMin));
    const seen = new Set();
    assert.ok(await until(() => { seen.add(c.transport.phase); return c.status === 'arrived'; }, 10000), 'case arrived via control-room updates');
    assert.ok(seen.has('at_patient') || seen.has('to_hospital'));
    assert.ok(c.timeline.some((e) => /assigned ambulance/.test(e.text)));
    const board = await (await fetch(`${base}/api/practice-cad/incidents`)).json();
    const rec = board.incidents.find((r) => r.ref === `MR-${c.id}`);
    assert.equal(rec.closed, true);
    assert.equal(rec.delivery, 'delivered');
    assert.equal(rec.callback, '••••••5678');
    assert.ok(board.fleet.every((a) => a.available), 'unit back in service');
  } finally { close(); }
});

test('practice control room: unsigned incidents refused; dispatcher actions need the key', async () => {
  const { store, base, close } = await boot({ SEHAT_PRACTICE_CAD_ASSIGN_MS: '60000' });
  try {
    const body = JSON.stringify({ incidentRef: 'MR-FAKE', pickup: { lat: 23.2, lng: 77.4 }, destination: { lat: 23.25, lng: 77.42 } });
    assert.equal((await fetch(`${base}/api/practice-cad/incidents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    const ts = Date.now();
    const bad = await fetch(`${base}/api/practice-cad/incidents`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Medreach-Timestamp': String(ts), 'X-Medreach-Signature': sign('wrong', ts, body) }, body });
    assert.equal(bad.status, 401);

    const c = acceptedCase(store);
    store.startTransport(c.id, { mode: 'ambulance' });
    assert.ok(await until(() => c.transport.incident.id));
    const id = c.transport.incident.id;
    const act = (what, key) => fetch(`${base}/api/practice-cad/incidents/${id}/${what}`, { method: 'POST', headers: key ? { 'X-Dispatcher-Key': key } : {} });
    assert.equal((await act('cancel')).status, 401);
    assert.equal((await act('cancel', 'nope')).status, 401);
    const ok = await act('cancel', SECRET);
    assert.equal(ok.status, 200);
    assert.ok(await until(() => c.transport.incident.status === 'cancelled'));
    assert.match(c.timeline.at(-1).text, /call 108/);
  } finally { close(); }
});

test('practice control room is off unless enabled', async () => {
  const store = createStore({ simulatedResponseMs: 50, reminderIntervalMs: 0 });
  const server = createApp(store, { dataMode: 'demo', env: {} }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/practice-cad/incidents`);
    assert.equal(r.status, 404);
  } finally { store.stop(); server.close(); }
});

test('settings with stray spaces, quotes or capitals still work; status says what is missing', async () => {
  const { cleanEnv, isOn, cleanUrl } = await import('../server/env.js');
  assert.ok(isOn(' ON ') && isOn('"on"') && isOn('true') && !isOn('off') && !isOn(''));
  assert.equal(cleanUrl(' medreach.example/api/practice-cad/incidents '), 'https://medreach.example/api/practice-cad/incidents');
  const env = cleanEnv({ SEHAT_PRACTICE_CAD: ' "On" ', SEHAT_EMS_SECRET: " 'abc' ", SEHAT_EMS_URL: 'x.example/api/practice-cad/incidents', OTHER: ' keep ' });
  assert.deepEqual([env.SEHAT_PRACTICE_CAD, env.SEHAT_EMS_SECRET, env.SEHAT_EMS_URL, env.OTHER], ['On', 'abc', 'https://x.example/api/practice-cad/incidents', ' keep ']);

  const store = createStore({ simulatedResponseMs: 50, reminderIntervalMs: 0 });
  const app = createApp(store, { dataMode: 'demo', env: { SEHAT_PRACTICE_CAD: ' ON ', SEHAT_EMS_SECRET: '' } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const st = await (await fetch(`${base}/api/practice-cad/status`)).json();
    assert.deepEqual(st, { on: false, checks: { SEHAT_PRACTICE_CAD: true, SEHAT_EMS_SECRET: false, SEHAT_EMS_URL: false } });
    assert.equal((await fetch(`${base}/api/practice-cad/incidents`)).status, 404);
  } finally { store.stop(); server.close(); }

  const { store: s2, base: b2, close } = await boot({ SEHAT_PRACTICE_CAD: ' On ' });
  try {
    assert.equal((await (await fetch(`${b2}/api/practice-cad/status`)).json()).on, true);
    assert.equal((await fetch(`${b2}/api/practice-cad/incidents`)).status, 200);
  } finally { close(); }
  void s2;
});

test('dispatcher key: pasted with name, quotes or spaces still works; a wrong key says why', async () => {
  const { cleanKey } = await import('../server/practice-cad.js');
  assert.equal(cleanKey(`SEHAT_EMS_SECRET=${SECRET}`), SECRET);
  assert.equal(cleanKey(` "${SECRET}" \n`), SECRET);
  assert.equal(cleanKey(`sehat_ems_secret: '${SECRET}'`), SECRET);

  const { base, close } = await boot({ SEHAT_PRACTICE_CAD_ASSIGN_MS: '60000', SEHAT_DATA_KEY: 'f'.repeat(64) });
  try {
    const check = (key) => fetch(`${base}/api/practice-cad/key-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    assert.equal((await check(`SEHAT_EMS_SECRET=${SECRET}`)).status, 200);
    const wrongLen = await check('abc');
    assert.equal(wrongLen.status, 401);
    assert.deepEqual(await wrongLen.json(), { ok: false, reason: 'mismatch', length: 3, expectedLength: SECRET.length });
    assert.equal((await (await check('f'.repeat(64))).json()).reason, 'other:SEHAT_DATA_KEY');
    assert.equal((await (await check('')).json()).reason, 'empty');
    // The real actions accept the same forgiving format.
    const r = await fetch(`${base}/api/practice-cad/incidents/NOPE/cancel`, { method: 'POST', headers: { 'X-Dispatcher-Key': ` "${SECRET}" ` } });
    assert.equal(r.status, 404);
  } finally { close(); }
});

test('manual mode: incident waits for the dispatcher, who assigns it; mode change needs the key', async () => {
  const { store, base, close } = await boot({ SEHAT_PRACTICE_CAD_ASSIGN_MS: '50', SEHAT_PRACTICE_CAD_MANUAL_MS: '60000' });
  try {
    const setMode = (mode, key) => fetch(`${base}/api/practice-cad/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Dispatcher-Key': key } : {}) }, body: JSON.stringify({ mode }) });
    assert.equal((await setMode('manual')).status, 401);
    assert.equal((await setMode('sideways', SECRET)).status, 400);
    assert.equal((await setMode('manual', SECRET)).status, 200);
    const board = async () => (await fetch(`${base}/api/practice-cad/incidents`)).json();
    assert.equal((await board()).settings.mode, 'manual');

    const c = acceptedCase(store);
    store.startTransport(c.id, { mode: 'ambulance' });
    assert.ok(await until(() => c.transport.incident.id));
    await wait(400); // far longer than the 50 ms auto-assign
    let rec = (await board()).incidents[0];
    assert.equal(rec.unit, null, 'still waiting for the dispatcher');
    assert.ok(Date.parse(rec.autoAssignAt) > Date.now(), 'fallback time shown');

    const r = await fetch(`${base}/api/practice-cad/incidents/${rec.id}/assign`, { method: 'POST', headers: { 'X-Dispatcher-Key': SECRET } });
    assert.equal(r.status, 200);
    rec = (await board()).incidents[0];
    assert.ok(rec.unit && rec.assignedBy === 'dispatcher' && rec.autoAssignAt === null);
    assert.ok(await until(() => c.transport.ambulance?.id === rec.unit.id), 'Medreach told about the unit');
  } finally { close(); }
});
