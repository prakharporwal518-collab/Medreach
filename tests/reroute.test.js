import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
process.env.SEHAT_ROUTING = 'off';
const { createApp } = await import('../server/index.js');
const { createStore } = await import('../server/store.js');
const { createEmsClient } = await import('../server/ems.js');

const loc = { lat: 23.2355, lng: 77.4005 }; // New Market, Bhopal
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; };

async function boot(storeOpts = {}, appOpts = {}) {
  const store = createStore({ simulatedResponseMs: 40, reminderIntervalMs: 0, demoSpeed: 30, ...storeOpts });
  const app = createApp(store, { dataMode: 'demo', ...appOpts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const post = (path, body, headers) => call('POST', path, body, headers);
  const login = async (hospitalId, staffId) => {
    const otp = await post('/api/auth/otp', { hospitalId, staffId });
    const v = await post('/api/auth/verify', { hospitalId, staffId, otp: otp.body.demoOtp });
    assert.equal(v.status, 200);
    return { Authorization: `Bearer ${v.body.token}` };
  };
  const close = () => { app.locals.practiceCad?.stop(); store.stop(); server.close(); };
  return { store, base, app, post, call, login, close };
}

// Report a heart attack, get the best hospital to accept (simulated desk), return everything needed.
async function acceptedCase(env, text = 'papa ko seene mein dard hai, pasina aa raha hai') {
  const tr = (await env.post('/api/triage', { text, lang: 'en' })).body;
  const created = await env.post('/api/cases', { triage: tr, location: loc });
  const h = { 'X-Case-Token': created.body.accessToken };
  const id = created.body.id;
  const best = (await env.post('/api/match', { triage: tr, location: loc })).body.options[0];
  await env.post(`/api/cases/${id}/request`, { hospitalId: best.hospital.id, option: { bedType: best.bedType, etaMin: best.etaMin, bed: best.bed } }, h);
  const c = env.store.getCase(id);
  assert.ok(await until(() => c.status === 'accepted'), 'first hospital accepted');
  return { c, id, h, first: best.hospital.id, tr };
}
const staffId = (hospitalId) => `${hospitalId.toUpperCase()}-ED01`;

test('re-route while the ambulance is on its way: bed released, next hospital accepts, ambulance redirected', async () => {
  const env = await boot({ demoSpeed: 3000 }); // each simulated tick covers a whole leg
  try {
    const { c, id, h, first } = await acceptedCase(env);
    const firstH = env.store.getHospital(first);
    const bedType = c.bedType;
    const freeAfterAccept = firstH.status.beds[bedType].free;
    assert.equal(c.bedReserved, true, 'bed was reserved on acceptance');

    await env.post(`/api/cases/${id}/transport`, { mode: 'ambulance' }, h);
    assert.equal(c.status, 'enroute');
    const unit = c.transport.ambulance.id;

    // Only staff of the accepting hospital may release it.
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'x' })).status, 401);
    const other = first === 'aiims-bpl' ? 'hamidia' : 'aiims-bpl';
    const otherDesk = await env.login(other, staffId(other));
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'x' }, otherDesk)).status, 403);

    const desk = await env.login(first, staffId(first));
    const out = await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'ICU bed taken by a critical walk-in' }, desk);
    assert.equal(out.status, 200);
    assert.equal(firstH.status.beds[bedType].free, freeAfterAccept + 1, 'reserved bed given back');
    assert.ok(c.timeline.some((e) => e.event === 'released' && /critical walk-in/.test(e.text)));

    // Server-side: the next capable hospital is asked and accepts (simulated desk); same ambulance continues.
    assert.ok(await until(() => c.status === 'enroute' && c.hospitalId !== first), 're-routed and moving again');
    assert.equal(c.transport.ambulance.id, unit, 'same ambulance keeps coming');
    assert.equal(c.reroute.active, false);
    assert.equal(c.reroutes[0].fromHospitalId, first);
    assert.equal(c.reroutes[0].toHospitalId, c.hospitalId);
    assert.ok(c.timeline.some((e) => e.event === 'rerouted' && /redirected to/.test(e.text)));
    assert.equal(c.requests.find((r) => r.hospitalId === first).outcome, 'released');
    assert.ok(c.requests.at(-1).reroute, 'the new request is marked as a re-route');

    // The citizen sees the new destination; the family link shows the re-route history.
    const view = (await env.call('GET', `/api/cases/${id}`, null, h)).body;
    assert.equal(view.destination.id, c.hospitalId);
    const track = env.store.trackView(c);
    assert.equal(track.reroutes[0].to, view.destination.name);

    // The old hospital can't release it again; the ambulance reaches the NEW hospital.
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'again' }, desk)).status, 409);
    const target = c.hospitalId;
    assert.ok(await until(() => c.status === 'arrived', 12000), 'arrives');
    assert.equal(c.hospitalId, target);
  } finally { env.close(); }
});

test('re-route before transport was chosen: the family simply continues with the new hospital', async () => {
  const env = await boot();
  try {
    const { c, id, h, first } = await acceptedCase(env);
    const desk = await env.login(first, staffId(first));
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'Ventilator failed' }, desk)).status, 200);
    assert.ok(await until(() => c.status === 'accepted' && c.hospitalId !== first));
    assert.ok(c.bedReserved, 'the new hospital reserved a bed');
    const t = await env.post(`/api/cases/${id}/transport`, { mode: 'ambulance' }, h);
    assert.equal(t.status, 200);
    assert.equal(t.body.destination.id, c.hospitalId);
  } finally { env.close(); }
});

test('nobody else can take the patient: go to the nearest open emergency department for stabilisation', async () => {
  const env = await boot();
  try {
    const { c, id, first } = await acceptedCase(env);
    // Every other hospital reports no bed of this type (fresh data) → no capable option left.
    for (const hosp of env.store.hospitals) if (hosp.id !== first) { hosp.status.beds[c.bedType] = { free: 0, total: hosp.status.beds[c.bedType]?.total ?? 0 }; hosp.status.verifiedAt = new Date().toISOString(); }
    const desk = await env.login(first, staffId(first));
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'No bed' }, desk)).status, 200);
    assert.ok(await until(() => c.stabilisation === true), 'stabilisation fallback');
    assert.notEqual(c.hospitalId, first);
    assert.equal(c.status, 'accepted');
    assert.ok(c.timeline.some((e) => e.event === 'stabilisation'));
  } finally { env.close(); }
});

test('re-route with the 108 control room: the incident gets the new destination over the signed contract', async () => {
  const SECRET = 'reroute-secret';
  const holder = {};
  const cadEnv = { SEHAT_PRACTICE_CAD: 'on', SEHAT_EMS_SECRET: SECRET, SEHAT_ROUTING: 'off', SEHAT_DEMO_SPEED: '30', SEHAT_PRACTICE_CAD_ASSIGN_MS: '40', SEHAT_PRACTICE_CAD_TICK_MS: '80', SEHAT_EMS_URL: 'http://placeholder/api/practice-cad/incidents' };
  const env = await boot(
    { ems: { name: 'cad', dispatch: (x) => holder.client.dispatch(x), redirect: (x) => holder.client.redirect(x) } },
    { env: cadEnv },
  );
  try {
    holder.client = createEmsClient({ url: `${env.base}/api/practice-cad/incidents`, secret: SECRET });
    cadEnv.SEHAT_EMS_CALLBACK_URL = `${env.base}/api/ems/updates`; // control room status updates come back here
    const { c, id, h, first } = await acceptedCase(env);
    await env.post(`/api/cases/${id}/transport`, { mode: 'ambulance' }, h);
    assert.ok(await until(() => c.transport.incident.id), 'incident created in the control room');
    const desk = await env.login(first, staffId(first));
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'ICU full' }, desk)).status, 200);
    assert.ok(await until(() => c.hospitalId !== first && c.status === 'enroute'));
    assert.ok(await until(() => c.timeline.some((e) => e.event === 'dispatch_redirected')), 'control room informed');
    const board = (await env.call('GET', '/api/practice-cad/incidents')).body;
    const rec = board.incidents.find((r) => r.ref === `MR-${id}`);
    assert.equal(rec.destination.name, env.store.getHospital(c.hospitalId).name);
    assert.equal(rec.rerouted, 1);
    assert.ok(rec.history.some((x) => /RE-ROUTED/.test(x.text)));
    // The public ambulance list shows the control room's unit as busy.
    assert.ok(await until(() => c.transport.ambulance?.id), 'unit reported back by the control room');
    const fleet = (await env.call('GET', '/api/ambulances')).body;
    assert.equal(fleet.find((a) => a.id === rec.unit.id).available, false);
    assert.equal(fleet.filter((a) => !a.available).length, 1);
  } finally { env.close(); }
});

test('re-route: a hospital that declines is skipped and the next one is asked; its staff accept on the dashboard', async () => {
  const env = await boot({ demoSpeed: 1 });
  try {
    const { c, id, h, first } = await acceptedCase(env);
    await env.post(`/api/cases/${id}/transport`, { mode: 'ambulance' }, h);
    // Every other hospital has an ER console open now → real (not simulated) answers are awaited.
    const offs = env.store.hospitals.filter((x) => x.id !== first).map((x) => env.store.subscribe(`hospital:${x.id}`, { write() {} }));
    try {
      const desk = await env.login(first, staffId(first));
      assert.equal((await env.post(`/api/hospitals/${first}/cases/${id}/release`, { reason: 'Specialist unavailable' }, desk)).status, 200);
      assert.equal(c.status, 'requested', 'the next hospital is asked straight away');
      assert.equal(c.transport.ambulance && c.reroute.active, true, 'ambulance keeps coming while we look');
      const a = c.hospitalId;
      assert.notEqual(a, first);
      const aDesk = await env.login(a, staffId(a));
      // The re-route request shows up on the next hospital's dashboard with where it came from.
      const queue = (await env.call('GET', `/api/hospitals/${a}/dashboard`, null, aDesk)).body;
      const card = queue.cases.find((x) => x.id === id);
      assert.ok(card, 'visible on the next hospital dashboard');
      assert.equal(card.reroutes?.[0]?.fromHospitalId, first);
      assert.equal((await env.post(`/api/hospitals/${a}/cases/${id}/respond`, { accept: false, reason: 'ICU full' }, aDesk)).status, 200);
      assert.ok(await until(() => c.status === 'requested' && c.hospitalId !== a), 'next hospital asked after a decline');
      const b = c.hospitalId;
      assert.notEqual(b, first);
      const bDesk = await env.login(b, staffId(b));
      assert.equal((await env.post(`/api/hospitals/${b}/cases/${id}/respond`, { accept: true, bay: 'Resus-02' }, bDesk)).status, 200);
      assert.equal(c.status, 'enroute');
      assert.equal(c.reroute.active, false);
      assert.deepEqual(c.reroute.tried, [first, a, b], 'the releasing hospital is never asked again');
      assert.equal(env.store.view(c).destination.id, b);
    } finally { offs.forEach((off) => off()); }
  } finally { env.close(); }
});

test('re-route for a family with no internet (SMS): the server does it all and texts the new hospital', async () => {
  const outbox = [];
  const env = await boot({}, { env: { SEHAT_SMS_SECRET: 'gw-key' }, smsSender: { live: true, send: async (to, text) => { outbox.push({ to, text }); return { sent: true }; } } });
  try {
    const { buildEmergencySms } = await import('../shared/sms.js');
    const tr = (await env.post('/api/triage', { text: 'heart attack', lang: 'en' })).body;
    const r = await env.post('/api/sms/inbound', { from: '9876500044', text: buildEmergencySms({ triage: tr, location: loc }) }, { 'X-Medreach-Key': 'gw-key' });
    assert.equal(r.status, 200);
    const c = [...env.store.cases.values()].find((x) => x.channel === 'sms');
    assert.ok(await until(() => c.status === 'enroute'), 'accepted and ambulance requested by the server');
    const first = c.hospitalId;
    const desk = await env.login(first, staffId(first));
    assert.equal((await env.post(`/api/hospitals/${first}/cases/${c.id}/release`, { reason: 'ICU bed taken' }, desk)).status, 200);
    assert.ok(await until(() => outbox.some((m) => /RE-ROUTED/.test(m.text))), 'family told by SMS');
    const sms = outbox.find((m) => /RE-ROUTED/.test(m.text)).text;
    assert.match(sms, /can no longer take the patient/);
    assert.equal(outbox.filter((m) => /RE-ROUTED/.test(m.text)).length, 1, 'exactly one re-route SMS');
    assert.ok(sms.includes(env.store.getHospital(c.hospitalId).name));
    assert.notEqual(c.hospitalId, first);
    // The orchestrator from the original SMS did not escalate a second time.
    assert.equal(c.requests.filter((x) => x.outcome === 'pending').length, 0);
  } finally { env.close(); }
});
