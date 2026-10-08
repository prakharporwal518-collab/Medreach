// Citizen sign-in: Aadhaar number + OTP sent to the mobile linked to that Aadhaar.
//
// Why: one real person has one Aadhaar, so nobody can create many fake or
// duplicate citizen accounts, and the OTP proves the person holds the phone
// registered with UIDAI for that Aadhaar.
//
// Privacy (Aadhaar Act 2016, s.29, and UIDAI rules for requesting entities):
//   • explicit consent is required before every authentication
//   • the Aadhaar number is NEVER stored, logged or sent back. We keep only
//       - ref: HMAC-SHA256(server key, Aadhaar) – recognises the same person,
//         cannot be reversed without the server key
//       - the last 4 digits, for display as "XXXX XXXX 1234"
//   • OTP: 6 digits, valid 5 minutes, 3 tries, max 3 OTPs per Aadhaar per
//     10 minutes (no SMS bombing), lock for 15 minutes after 10 wrong OTPs
//   • the session is a signed token (HMAC) valid 30 days; nothing about the
//     citizen is kept on the server
//
// Real Aadhaar OTP needs a licensed AUA/KUA connected to UIDAI through an
// ASA. In DEMO data mode a simulated UIDAI is used and the OTP is shown on
// screen (no SMS gateway). In LIVE mode pass a `provider`; without one,
// citizen sign-in is refused – reporting an emergency never needs a login.
//
// Provider interface:
//   sendOtp(aadhaar)          → { providerTxn, maskedMobile, needsName?, demoOtp? }
//   checkOtp(providerTxn, otp) → { ok, kyc: { name, gender, yob } | null }
//
// Uses only Web Crypto, so the single-file demo runs it in the browser too.

import { aadhaarProblem, cleanAadhaar, maskAadhaar, verhoeffDigit, formatAadhaar } from '../shared/aadhaar.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRIES = 3;
const OTPS_PER_WINDOW = 3;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const randomOtp = () => String(100000 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const maskMobile = (m) => `••••••${String(m).slice(-4)}`;
// Compare without leaking how many leading characters matched.
const same = (a, b) => {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
};

// Fictional people for the demo (numbers start with 9999 and are not real Aadhaar numbers).
export const DEMO_PEOPLE = [
  { base: '99990001001', name: 'Ramesh Kumar', gender: 'M', yob: 1963, mobile: '9000001001' },
  { base: '99990001002', name: 'Sunita Sharma', gender: 'F', yob: 1988, mobile: '9000001002' },
  { base: '99990001003', name: 'Arjun Verma', gender: 'M', yob: 2001, mobile: '9000001003' },
].map(({ base, ...p }) => ({ ...p, aadhaar: base + verhoeffDigit(base) }));

/** Simulated UIDAI for demo mode: OTP returned to be shown on screen, no SMS. */
export function demoAadhaarProvider({ hmacHex }) {
  const pending = new Map(); // providerTxn -> { code, kyc, expires }
  return {
    name: 'demo',
    async sendOtp(aadhaar) {
      for (const [k, v] of pending) if (Date.now() > v.expires) pending.delete(k);
      const person = DEMO_PEOPLE.find((p) => p.aadhaar === aadhaar);
      // Any other valid number gets a stable, made-up "linked mobile" (never a real one).
      const mobile = person?.mobile ?? `9${String(parseInt((await hmacHex(`demo-mobile|${aadhaar}`)).slice(0, 12), 16) % 1e9).padStart(9, '0')}`;
      const providerTxn = randomHex(12);
      const code = randomOtp();
      pending.set(providerTxn, { code, expires: Date.now() + OTP_TTL_MS, kyc: person ? { name: person.name, gender: person.gender, yob: person.yob } : null });
      return { providerTxn, maskedMobile: maskMobile(mobile), needsName: !person, demoOtp: code };
    },
    async checkOtp(providerTxn, otp) {
      const p = pending.get(providerTxn);
      if (!p || !same(otp, p.code)) return { ok: false, kyc: null };
      pending.delete(providerTxn);
      return { ok: true, kyc: p.kyc };
    },
  };
}

export function createCitizenAuth({ demoMode = true, provider = null, secret = null, now = () => Date.now() } = {}) {
  const keyBytes = secret ? (typeof secret === 'string' ? enc.encode(secret) : secret) : globalThis.crypto.getRandomValues(new Uint8Array(32));
  let keyP = null;
  const hmacKey = () => (keyP ||= globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  const hmac = async (msg) => new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(msg)));
  const hmacHex = async (msg) => hex(await hmac(msg));
  const prov = provider || (demoMode ? demoAadhaarProvider({ hmacHex }) : null);

  const txns = new Map();     // txnId -> { ref, last4, providerTxn, maskedMobile, needsName, expires, tries }
  const requests = new Map(); // ref -> { count, since }
  const failures = new Map(); // ref -> { count, since }

  const purge = () => {
    const t = now();
    for (const [k, v] of txns) if (t > v.expires) txns.delete(k);
    for (const [k, v] of requests) if (t - v.since > WINDOW_MS) requests.delete(k);
    for (const [k, v] of failures) if (t - v.since > LOCK_MS) failures.delete(k);
  };
  const locked = (ref) => (failures.get(ref)?.count || 0) >= LOCK_AFTER;

  async function requestOtp({ aadhaar, consent } = {}) {
    if (!prov) fail(503, 'Aadhaar sign-in is not connected on this server yet. You can still report an emergency without logging in.');
    if (consent !== true) fail(400, 'Please give your consent for Aadhaar verification');
    const n = cleanAadhaar(aadhaar);
    const problem = aadhaarProblem(n);
    if (problem) fail(400, problem);
    purge();
    const ref = (await hmacHex(`aadhaar-ref|${n}`)).slice(0, 40);
    if (locked(ref)) fail(429, 'Too many wrong OTPs for this Aadhaar – please try again in 15 minutes');
    const r = requests.get(ref) || { count: 0, since: now() };
    if (r.count >= OTPS_PER_WINDOW) fail(429, 'An OTP was already sent 3 times – please wait 10 minutes before asking again');
    r.count += 1;
    requests.set(ref, r);
    const sent = await prov.sendOtp(n);
    const txnId = randomHex(16);
    txns.set(txnId, {
      ref, last4: n.slice(-4), providerTxn: sent.providerTxn, maskedMobile: sent.maskedMobile,
      needsName: Boolean(sent.needsName), expires: now() + OTP_TTL_MS, tries: 0,
    });
    return {
      txnId, maskedAadhaar: maskAadhaar(n), maskedMobile: sent.maskedMobile, expiresInSec: OTP_TTL_MS / 1000,
      needsName: Boolean(sent.needsName), ...(demoMode && sent.demoOtp ? { demoOtp: sent.demoOtp } : {}),
    };
  }

  async function verifyOtp({ txnId, otp, name } = {}) {
    purge();
    const t = txns.get(String(txnId || ''));
    if (!t) fail(401, 'This OTP has expired – please request a new one');
    if (locked(t.ref)) { txns.delete(txnId); fail(429, 'Too many wrong OTPs for this Aadhaar – please try again in 15 minutes'); }
    const code = String(otp ?? '').trim();
    if (!/^\d{6}$/.test(code)) fail(400, 'Enter the 6-digit OTP');
    let givenName = null;
    if (t.needsName) {
      givenName = String(name ?? '').replace(/[^\p{L}\p{M} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (givenName.length < 2) fail(400, 'Enter your full name as printed on your Aadhaar card');
    }
    t.tries += 1;
    const res = await prov.checkOtp(t.providerTxn, code);
    if (!res.ok) {
      const f = failures.get(t.ref) || { count: 0, since: now() };
      f.count += 1;
      failures.set(t.ref, f);
      if (t.tries >= MAX_TRIES) { txns.delete(txnId); fail(401, 'Wrong OTP – no tries left, please request a new OTP'); }
      fail(401, `Wrong OTP (${MAX_TRIES - t.tries} ${MAX_TRIES - t.tries === 1 ? 'try' : 'tries'} left)`);
    }
    txns.delete(txnId);
    failures.delete(t.ref);
    const citizen = {
      ref: t.ref,
      name: res.kyc?.name || givenName,
      maskedAadhaar: `XXXX XXXX ${t.last4}`,
      maskedMobile: t.maskedMobile,
      verifiedAt: new Date(now()).toISOString(),
      verifiedWith: prov.name === 'demo' ? 'Aadhaar OTP (simulated UIDAI – demo)' : 'Aadhaar OTP',
    };
    const exp = now() + TOKEN_TTL_MS;
    const body = b64url(enc.encode(JSON.stringify({ ...citizen, exp })));
    const token = `${body}.${b64url(await hmac(`citizen-token|${body}`))}`;
    return { token, citizen, expiresAt: new Date(exp).toISOString() };
  }

  /** The citizen a token belongs to, or null if it is forged, malformed or expired. */
  async function session(token) {
    const [body, sig, extra] = String(token || '').split('.');
    if (!body || !sig || extra !== undefined) return null;
    if (!same(sig, b64url(await hmac(`citizen-token|${body}`)))) return null;
    try {
      const { exp, ...citizen } = JSON.parse(dec.decode(fromB64url(body)));
      return Number.isFinite(exp) && now() < exp ? citizen : null;
    } catch { return null; }
  }

  /** Demo only: the fictional Aadhaar numbers judges can use. */
  const demoIdentities = () => (prov?.name === 'demo'
    ? DEMO_PEOPLE.map((p) => ({ aadhaar: formatAadhaar(p.aadhaar), name: p.name, maskedMobile: maskMobile(p.mobile) }))
    : []);

  return { requestOtp, verifyOtp, session, demoIdentities, enabled: () => Boolean(prov) };
}
