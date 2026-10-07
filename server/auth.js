// Hospital staff authentication: Hospital ID + Staff ID + OTP → session.
//
//   • OTP: 6 digits, valid 5 minutes, max 5 attempts, single use
//   • Session token: random 32 bytes, valid 8 hours, bound to ONE hospital
//   • Every login attempt is written to the audit log
//
// Prototype note: there is no SMS gateway, so in DEMO data mode the OTP is
// returned in the response and shown on screen. In a live deployment it is
// only sent to the staff member's registered mobile.

import { STAFF } from './data/staff.js';
import { ROLES, can } from '../shared/roles.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const randomHex = (bytes) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)),
  (b) => b.toString(16).padStart(2, '0')).join('');
const randomOtp = () => String(100000 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const mask = (mobile) => `••••••${mobile.slice(-4)}`;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function createAuth({ staff = STAFF, demoMode = true, audit = () => {}, now = () => Date.now() } = {}) {
  const otps = new Map();     // `${hospitalId}|${staffId}` -> { code, expires, attempts }
  const sessions = new Map(); // token -> { staff, expires }
  const failures = new Map(); // `${hospitalId}|${staffId}` -> { count, since } – account lockout
  const LOCK_AFTER = 10;
  const LOCK_MS = 15 * 60 * 1000;
  // Compare without leaking how many leading characters matched.
  const sameCode = (a, b) => {
    const x = String(a).trim();
    const y = String(b);
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0;
  };
  const locked = (key) => {
    const f = failures.get(key);
    if (!f) return false;
    if (now() - f.since > LOCK_MS) { failures.delete(key); return false; }
    return f.count >= LOCK_AFTER;
  };

  const find = (hospitalId, staffId) => staff.find((s) =>
    s.hospitalId.toLowerCase() === String(hospitalId).trim().toLowerCase()
    && s.staffId.toLowerCase() === String(staffId).trim().toLowerCase());

  function requestOtp(hospitalId, staffId) {
    const s = find(hospitalId, staffId);
    // Same answer whether or not the ID exists, so staff IDs can't be probed.
    if (!s) {
      audit({ hospitalId, staffId, action: 'login.otp_requested', result: 'unknown_staff' });
      return { sent: true, maskedMobile: '••••••????' };
    }
    const code = randomOtp();
    otps.set(`${s.hospitalId}|${s.staffId}`, { code, expires: now() + OTP_TTL_MS, attempts: 0 });
    audit({ hospitalId: s.hospitalId, staffId: s.staffId, name: s.name, role: s.role, action: 'login.otp_requested', result: 'sent' });
    return { sent: true, maskedMobile: mask(s.mobile), expiresInSec: OTP_TTL_MS / 1000, ...(demoMode ? { demoOtp: code } : {}) };
  }

  function verifyOtp(hospitalId, staffId, code) {
    const s = find(hospitalId, staffId);
    const entry = s && otps.get(`${s.hospitalId}|${s.staffId}`);
    if (s && locked(`${s.hospitalId}|${s.staffId}`)) {
      audit({ hospitalId: s.hospitalId, staffId: s.staffId, name: s.name, role: s.role, action: 'login.failed', result: 'account_locked' });
      fail(429, 'Too many wrong OTPs – this account is locked for 15 minutes');
    }
    if (!s || !entry) fail(401, 'Request a new OTP');
    if (now() > entry.expires) { otps.delete(`${s.hospitalId}|${s.staffId}`); fail(401, 'OTP expired – request a new one'); }
    if (++entry.attempts > MAX_ATTEMPTS) { otps.delete(`${s.hospitalId}|${s.staffId}`); fail(429, 'Too many attempts – request a new OTP'); }
    if (!sameCode(code, entry.code)) {
      const key = `${s.hospitalId}|${s.staffId}`;
      const f = failures.get(key) || { count: 0, since: now() };
      f.count += 1;
      failures.set(key, f);
      audit({ hospitalId: s.hospitalId, staffId: s.staffId, name: s.name, role: s.role, action: 'login.failed', result: 'wrong_otp' });
      fail(401, `Wrong OTP (${MAX_ATTEMPTS - entry.attempts} attempts left)`);
    }
    otps.delete(`${s.hospitalId}|${s.staffId}`);
    failures.delete(`${s.hospitalId}|${s.staffId}`);
    const token = randomHex(32);
    const expires = now() + SESSION_TTL_MS;
    const who = { staffId: s.staffId, hospitalId: s.hospitalId, name: s.name, role: s.role, roleLabel: ROLES[s.role].label };
    sessions.set(token, { staff: who, expires });
    audit({ ...who, action: 'login.success' });
    return { token, staff: who, expiresAt: new Date(expires).toISOString(), permissions: ROLES[s.role].can };
  }

  function session(token) {
    const s = token && sessions.get(token);
    if (!s) return null;
    if (now() > s.expires) { sessions.delete(token); return null; }
    return s.staff;
  }

  /** Throws 401/403 unless the token's staff may do `action` on `hospitalId`. */
  function require(token, action, hospitalId) {
    const staff = session(token);
    if (!staff) fail(401, 'Login required');
    if (!can(staff, action, hospitalId)) {
      audit({ ...staff, action: 'access.denied', result: `${action} on ${hospitalId}` });
      fail(403, `${ROLES[staff.role]?.label || staff.role} is not allowed to do this for this hospital`);
    }
    return staff;
  }

  function logout(token) {
    const staff = session(token);
    sessions.delete(token);
    if (staff) audit({ ...staff, action: 'logout' });
  }

  return { requestOtp, verifyOtp, session, require, logout };
}
