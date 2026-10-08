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
