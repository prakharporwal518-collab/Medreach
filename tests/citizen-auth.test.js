import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
process.env.SEHAT_ROUTING = 'off';
const { createCitizenAuth, DEMO_PEOPLE } = await import('../server/citizen-auth.js');
const { aadhaarProblem, verhoeffValid, verhoeffDigit, maskAadhaar, formatAadhaar } = await import('../shared/aadhaar.js');
const { createApp } = await import('../server/index.js');
const { createStore } = await import('../server/store.js');

const RAMESH = DEMO_PEOPLE[0].aadhaar;
// A valid number that is not one of the demo people.
const OTHER = `23456789012${verhoeffDigit('23456789012')}`;
const rejects = async (p, status, re) => {
  await assert.rejects(p, (e) => { assert.equal(e.status, status); if (re) assert.match(e.message, re); return true; });
};

test('Aadhaar format: 12 digits, not starting 0/1, Verhoeff check digit', () => {
  for (const p of DEMO_PEOPLE) assert.equal(aadhaarProblem(p.aadhaar), null);
  assert.equal(aadhaarProblem(OTHER), null);
  assert.equal(aadhaarProblem(formatAadhaar(OTHER)), null); // spaces are fine
  // One wrong digit or two swapped digits are caught.
  const typo = `${OTHER.slice(0, 5)}${(Number(OTHER[5]) + 1) % 10}${OTHER.slice(6)}`;
  assert.ok(!verhoeffValid(typo));
  assert.ok(!verhoeffValid(`${OTHER.slice(0, 3)}${OTHER[4]}${OTHER[3]}${OTHER.slice(5)}`) || OTHER[3] === OTHER[4]);
  assert.match(aadhaarProblem('12345'), /12 digits/);
  assert.match(aadhaarProblem(`1${OTHER.slice(1)}`), /cannot start/);
  assert.equal(maskAadhaar(OTHER), `XXXX XXXX ${OTHER.slice(-4)}`);
});

test('sign-in: OTP to the Aadhaar-linked mobile, signed token, Aadhaar never returned', async () => {
  const auth = createCitizenAuth({ demoMode: true });
  await rejects(auth.requestOtp({ aadhaar: RAMESH }), 400, /consent/);
  await rejects(auth.requestOtp({ aadhaar: '999900010010', consent: true }), 400, /not a valid/);
  const sent = await auth.requestOtp({ aadhaar: RAMESH, consent: true });
  assert.equal(sent.maskedMobile, '••••••1001');
  assert.equal(sent.maskedAadhaar, `XXXX XXXX ${RAMESH.slice(-4)}`);
  assert.equal(sent.needsName, false);
  const out = await auth.verifyOtp({ txnId: sent.txnId, otp: sent.demoOtp });
  assert.equal(out.citizen.name, 'Ramesh Kumar');
  assert.ok(!JSON.stringify({ sent, out }).includes(RAMESH), 'the full Aadhaar number must never leave the server');
  assert.deepEqual(await auth.session(out.token), out.citizen);
  // The same OTP cannot be used twice.
  await rejects(auth.verifyOtp({ txnId: sent.txnId, otp: sent.demoOtp }), 401);
});

test('tokens: forged, edited or expired tokens are rejected', async () => {
  let t = 1_000_000;
  const auth = createCitizenAuth({ demoMode: true, now: () => t });
  const sent = await auth.requestOtp({ aadhaar: RAMESH, consent: true });
  const { token } = await auth.verifyOtp({ txnId: sent.txnId, otp: sent.demoOtp });
  const [body, sig] = token.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), name: 'Someone Else' })).toString('base64url');
  assert.equal(await auth.session(`${edited}.${sig}`), null);
  assert.equal(await auth.session('garbage'), null);
  // A token from another server key is worthless here.
  const other = createCitizenAuth({ demoMode: true, now: () => t });
  assert.equal(await other.session(token), null);
  t += 31 * 24 * 60 * 60 * 1000;
  assert.equal(await auth.session(token), null);
});

test('same person → same reference (with the same key); different key → different reference', async () => {
  const key = new Uint8Array(32).fill(7);
  const ref = async (auth) => {
    const s = await auth.requestOtp({ aadhaar: RAMESH, consent: true });
    return (await auth.verifyOtp({ txnId: s.txnId, otp: s.demoOtp })).citizen.ref;
  };
  const a = await ref(createCitizenAuth({ secret: key }));
  assert.equal(a, await ref(createCitizenAuth({ secret: key })));
  assert.notEqual(a, await ref(createCitizenAuth({ secret: new Uint8Array(32).fill(8) })));
  assert.ok(!a.includes(RAMESH.slice(-4)));
});

test('wrong OTPs: 3 tries per OTP, then a new OTP is needed; lock after 10 failures', async () => {
  const auth = createCitizenAuth({ demoMode: true });
  const s = await auth.requestOtp({ aadhaar: RAMESH, consent: true });
  const wrong = s.demoOtp === '111111' ? '222222' : '111111';
  await rejects(auth.verifyOtp({ txnId: s.txnId, otp: wrong }), 401, /2 tries left/);
  await rejects(auth.verifyOtp({ txnId: s.txnId, otp: wrong }), 401, /1 try left/);
  await rejects(auth.verifyOtp({ txnId: s.txnId, otp: wrong }), 401, /no tries left/);
  await rejects(auth.verifyOtp({ txnId: s.txnId, otp: s.demoOtp }), 401, /request a new/);
  await rejects(auth.verifyOtp({ txnId: s.txnId, otp: '12' }), 401);

  // Lockout is per person, across OTPs: the 10th wrong OTP within 15 minutes locks sign-in.
  let t = 5_000_000;
  const lock = createCitizenAuth({ demoMode: true, now: () => t });
  const failOnce = async (x) => { await assert.rejects(lock.verifyOtp({ txnId: x.txnId, otp: x.demoOtp === '000000' ? '999999' : '000000', name: 'Test Person' })); };
  for (let i = 0; i < 3; i++) {
    const x = await lock.requestOtp({ aadhaar: OTHER, consent: true });
    for (let j = 0; j < 3; j++) await failOnce(x);
  }
  t += 11 * 60 * 1000; // a new 10-minute OTP window, still inside the 15-minute lock window
  const last = await lock.requestOtp({ aadhaar: OTHER, consent: true });
  await failOnce(last); // 10th failure
  await rejects(lock.verifyOtp({ txnId: last.txnId, otp: last.demoOtp, name: 'Test Person' }), 429, /15 minutes/);
  await rejects(lock.requestOtp({ aadhaar: OTHER, consent: true }), 429, /15 minutes/);
});

test('no SMS bombing: at most 3 OTPs per Aadhaar in 10 minutes', async () => {
  const auth = createCitizenAuth({ demoMode: true });
  for (let i = 0; i < 3; i++) await auth.requestOtp({ aadhaar: RAMESH, consent: true });
  await rejects(auth.requestOtp({ aadhaar: RAMESH, consent: true }), 429, /wait 10 minutes/);
  // Someone else is not affected.
  assert.ok((await auth.requestOtp({ aadhaar: OTHER, consent: true })).txnId);
});

test('unknown (non-demo) number: name as on Aadhaar is required', async () => {
  const auth = createCitizenAuth({ demoMode: true });
  const s = await auth.requestOtp({ aadhaar: OTHER, consent: true });
  assert.equal(s.needsName, true);
  assert.match(s.maskedMobile, /^••••••\d{4}$/);
  await rejects(auth.verifyOtp({ txnId: s.txnId, otp: s.demoOtp }), 400, /full name/);
  const out = await auth.verifyOtp({ txnId: s.txnId, otp: s.demoOtp, name: '  Priya <b>Singh</b> ' });
  assert.equal(out.citizen.name, 'Priya bSinghb'); // markup characters are stripped
});

test('live mode without a licensed Aadhaar provider refuses sign-in clearly', async () => {
  const auth = createCitizenAuth({ demoMode: false });
  assert.equal(auth.enabled(), false);
  await rejects(auth.requestOtp({ aadhaar: RAMESH, consent: true }), 503, /not connected/);
  assert.deepEqual(auth.demoIdentities(), []);
});

test('API: citizen sign-in routes and public ambulance status', async () => {
  const store = createStore({ simulatedResponseMs: 50 });
  const server = createApp(store, { dataMode: 'demo' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const ids = await (await fetch(`${base}/api/citizen/demo-ids`)).json();
    assert.equal(ids.length, 3);
    const sent = await (await post('/api/citizen/otp', { aadhaar: ids[1].aadhaar, consent: true })).json();
    assert.ok(sent.demoOtp);
    const out = await (await post('/api/citizen/verify', { txnId: sent.txnId, otp: sent.demoOtp })).json();
    assert.equal(out.citizen.name, 'Sunita Sharma');
    const me = await fetch(`${base}/api/citizen/me`, { headers: { Authorization: `Bearer ${out.token}` } });
    assert.equal(me.status, 200);
    assert.equal((await fetch(`${base}/api/citizen/me`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`).then((r) => r.json())).citizenSignIn, 'aadhaar-otp');

    const amb = await (await fetch(`${base}/api/ambulances`)).json();
    assert.ok(amb.length > 0);
    for (const a of amb) assert.deepEqual(Object.keys(a).sort(), ['available', 'base', 'id', 'type']);
  } finally { store.stop(); server.close(); }
});
