import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
process.env.SEHAT_ROUTING = 'off';
const { createApp } = await import('../server/index.js');
const { createStore } = await import('../server/store.js');
const { createVault } = await import('../server/vault.js');

const loc = { lat: 23.2355, lng: 77.4005 };

test('vault: AES-256-GCM round trip, fresh IV each time, tampering rejected', () => {
  const v = createVault('a'.repeat(64));
  const a = v.seal({ name: 'Ramesh', abhaId: '12-3456-7890-1234' });
  const b = v.seal({ name: 'Ramesh', abhaId: '12-3456-7890-1234' });
  assert.notEqual(a, b);
  assert.ok(!a.includes('Ramesh'));
  assert.deepEqual(v.open(a), { name: 'Ramesh', abhaId: '12-3456-7890-1234' });
  const parts = a.split('.');
  parts[3] = Buffer.from('{"name":"Evil"}').toString('base64');
  assert.throws(() => v.open(parts.join('.')));
  assert.throws(() => createVault('short'));
});

test('patient details, description and contact are stored only in sealed form', () => {
  const store = createStore({ vault: createVault(), simulatedResponseMs: 50 });
  const c = store.createCase({
    triage: { type: 'cardiac', label: 'Heart attack', severity: 'critical', required: [], ambulanceType: 'ALS' },
    location: loc, text: 'papa ko seene mein dard', contact: { name: 'Rahul', phone: '9812345678' },
    patient: { name: 'Ramesh Kumar', abhaId: '12-3456-7890-1234' }, consent: { patientDetails: true },
  });
  // Authorised views still read the plain values …
  assert.equal(c.patient.name, 'Ramesh Kumar');
  assert.equal(store.view(c).text, 'papa ko seene mein dard');
  // … but nothing personal sits in memory in readable form.
  const internals = Object.getOwnPropertyNames(c).map((k) => Object.getOwnPropertyDescriptor(c, k));
  for (const d of internals) if ('value' in d) assert.ok(!JSON.stringify(d.value ?? '').includes('Ramesh'));
  store.stop();
});

test('security headers on pages and no-store on API responses', async () => {
  const store = createStore({ simulatedResponseMs: 50 });
  const server = createApp(store, { dataMode: 'demo' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/report`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  // Map tiles are fetched by the service worker, which is bound by connect-src.
  const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src'));
  assert.match(connect, /tile\.openstreetmap\.org/);
  assert.match(connect, /fonts\.gstatic\.com/);
  assert.match(page.headers.get('strict-transport-security'), /max-age/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  const api = await fetch(`${base}/api/config`);
  assert.equal(api.headers.get('cache-control'), 'no-store');
  // Request bodies are capped (only /api/vision may be large).
  const big = await fetch(`${base}/api/triage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(200 * 1024) }) });
  assert.equal(big.status, 413);
  store.stop(); server.close();
});

test('rate limit: OTP requests are throttled per client', async () => {
  const store = createStore({ simulatedResponseMs: 50 });
  const limits = [{ name: 'otp', match: (r) => r.method === 'POST' && r.path === '/api/auth/otp', max: 3, windowMs: 60000 }];
  const server = createApp(store, { dataMode: 'demo', limits }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = () => fetch(`${base}/api/auth/otp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hospitalId: 'bansal', staffId: 'BANSAL-ED01' }) });
  for (let i = 0; i < 3; i++) assert.equal((await ask()).status, 200);
  const blocked = await ask();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  store.stop(); server.close();
});

test('staff account locks after repeated wrong OTPs', async () => {
  const { createAuth } = await import('../server/auth.js');
  const auth = createAuth({ demoMode: true, audit: () => {} });
  let lockedOut = false;
  for (let round = 0; round < 4 && !lockedOut; round++) {
    auth.requestOtp('bansal', 'BANSAL-ED01');
    for (let i = 0; i < 5; i++) {
      try { auth.verifyOtp('bansal', 'BANSAL-ED01', '000000'); } catch (e) { if (/locked/.test(e.message)) { lockedOut = true; break; } }
    }
  }
  assert.ok(lockedOut);
  // Even the right code is refused while locked.
  const { demoOtp } = auth.requestOtp('bansal', 'BANSAL-ED01');
  assert.throws(() => auth.verifyOtp('bansal', 'BANSAL-ED01', demoOtp), /locked/);
});

test('audit log is hash-chained: editing, deleting or reordering an entry is detected', async () => {
  const { sha256 } = await import('../shared/sha256.js');
  const { createHash } = await import('node:crypto');
  assert.equal(sha256('Medreach'), createHash('sha256').update('Medreach').digest('hex'));
  const store = createStore({ simulatedResponseMs: 50 });
  store.audit({ hospitalId: 'bansal', staffId: 'BANSAL-ED01', action: 'login.success' });
  store.updateHospitalStatus('bansal', { beds: { icu: { free: 1 } } }, { staffId: 'BANSAL-RM01', name: 'R', role: 'resource' });
  store.audit({ hospitalId: 'bansal', staffId: 'BANSAL-ED01', action: 'logout' });
  const ok = store.verifyAudit();
  assert.equal(ok.ok, true);
  assert.equal(ok.entries, 3);
  const log = store.auditFor('*').reverse(); // oldest first
  assert.throws(() => { log[1].result = 'ICU beds free: 9'; }, TypeError); // entries are frozen
  const edited = log.map((e, i) => (i === 1 ? { ...e, result: 'ICU beds free: 9' } : e));
  assert.deepEqual(store.verifyAudit(edited, '0'.repeat(64)), { ok: false, entries: 3, brokenAt: 2, head: null });
  assert.equal(store.verifyAudit([log[0], log[2]], '0'.repeat(64)).ok, false); // deleted
  assert.equal(store.verifyAudit([log[1], log[0], log[2]], '0'.repeat(64)).ok, false); // reordered
  store.stop();
});

test('staff sessions are stored hashed; hospital figures are bounded', async () => {
  const { createAuth } = await import('../server/auth.js');
  const auth = createAuth({ demoMode: true, audit: () => {} });
  const { demoOtp } = auth.requestOtp('bansal', 'BANSAL-ED01');
  const { token } = auth.verifyOtp('bansal', 'BANSAL-ED01', demoOtp);
  assert.equal(auth.session(token).staffId, 'BANSAL-ED01');
  assert.equal(auth.session(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')), null);
  assert.equal(auth.session(undefined), null);
  auth.logout(token);
  assert.equal(auth.session(token), null);

  const store = createStore({ simulatedResponseMs: 50 });
  const h = store.updateHospitalStatus('bansal', { erQueue: 1e9, ventilatorsFree: -5, onDuty: ['cardiology', 'cardiology'] });
  assert.equal(h.status.erQueue, 500);
  assert.equal(h.status.ventilatorsFree, 0);
  assert.deepEqual(h.status.onDuty, ['cardiology']);
  store.stop();
});
