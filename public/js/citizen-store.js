// Citizen account & personal health profile – stored ONLY on this device.
//
// Sign-in is Aadhaar + OTP (to the Aadhaar-linked mobile), verified by the
// server, so one real person = one account and fake accounts can't be made.
// The device keeps only what the server returns: a keyed reference (not the
// Aadhaar number), the name, "XXXX XXXX 1234", the masked mobile and a signed
// session token. The full Aadhaar number is never saved anywhere.
//
// Privacy by design: the server never holds a citizen's profile, health
// records or case list. Nothing is shared until the citizen raises an
// emergency (and patient details only with explicit consent).
//
// This is completely separate from the hospital-staff session (which lives
// in sessionStorage and is issued by the server after Hospital ID + Staff ID + OTP).

const ACCOUNTS = 'medreach.citizen.accounts';
const SESSION = 'medreach.citizen.session';
const PROFILE = (ref) => `medreach.citizen.profile.${ref}`;
// Accounts from before Aadhaar sign-in (mobile + password); kept only to migrate their data.
const LEGACY = { accounts: 'sehat.citizen.accounts', session: 'sehat.citizen.session', profile: (p) => `sehat.citizen.profile.${p}` };

function read(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export const normalisePhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/**
 * Save the identity the server verified (from POST /api/citizen/verify).
 * Returns { account, isNew }.
 */
export function signInVerified({ token, citizen, expiresAt }) {
  if (!token || !citizen?.ref) throw new Error('Verification failed – please try again');
  const accounts = read(ACCOUNTS, {});
  const { ref } = citizen;
  if (!accounts[ref]) {
    // The server key changed (e.g. a restart without SEHAT_DATA_KEY): re-link the
    // one account on this device with the same masked Aadhaar and mobile.
    const same = Object.values(accounts).filter((a) => a.maskedAadhaar === citizen.maskedAadhaar && a.maskedMobile === citizen.maskedMobile);
    if (same.length === 1) {
      const old = same[0].ref;
      write(PROFILE(ref), read(PROFILE(old), {}));
      remove(PROFILE(old));
      delete accounts[old];
    }
  }
  const isNew = !accounts[ref] && !read(PROFILE(ref));
  accounts[ref] = {
    email: '', createdAt: new Date().toISOString(),
    ...accounts[ref],
    ref, name: citizen.name, maskedAadhaar: citizen.maskedAadhaar, maskedMobile: citizen.maskedMobile,
    verifiedAt: citizen.verifiedAt, verifiedWith: citizen.verifiedWith,
  };
  write(ACCOUNTS, accounts);
  if (!read(PROFILE(ref))) write(PROFILE(ref), migrateLegacy() || { health: {}, contacts: [], cases: [], lang: 'en' });
  write(SESSION, { ref, token, expiresAt });
  return { account: current(), isNew };
}

// Move the health profile of an old mobile+password account (if one was signed in) to the
// verified account, then delete the old account including its password hash.
function migrateLegacy() {
  const s = read(LEGACY.session);
  const legacy = read(LEGACY.accounts, {});
  if (!s?.phone || !legacy[s.phone]) return null;
  const prof = read(LEGACY.profile(s.phone));
  delete legacy[s.phone];
  write(LEGACY.accounts, legacy);
  remove(LEGACY.profile(s.phone));
  remove(LEGACY.session);
  return prof ? { health: {}, contacts: [], cases: [], lang: 'en', ...prof } : null;
}

/** True if this device still has an old (pre-Aadhaar) account. */
export const hasLegacyAccount = () => Object.keys(read(LEGACY.accounts, {})).length > 0;

export function signOut() {
  remove(SESSION);
}

/** Signed session token, for calls to /api/citizen/*. */
export function token() {
  return read(SESSION)?.token || null;
}

/** The signed-in citizen, or null (also null once the session has expired). */
export function current() {
  const s = read(SESSION);
  if (!s?.ref) return null;
  if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) { signOut(); return null; }
  return read(ACCOUNTS, {})[s.ref] || null;
}

export function profile() {
  const me = current();
  if (!me) return null;
  return { health: {}, contacts: [], cases: [], lang: 'en', ...read(PROFILE(me.ref), {}) };
}

export function saveProfile(patch) {
  const me = current();
  if (!me) return null;
  const next = { ...profile(), ...patch };
  write(PROFILE(me.ref), next);
  // The emergency flow reads the primary trusted contact from this key.
  const primary = next.contacts?.[0];
  write('sehat.contact', primary ? { name: primary.name, phone: primary.phone } : null);
  return next;
}

/** Only the email can be changed: name, Aadhaar and mobile come from the Aadhaar verification. */
export function updateAccount({ email }) {
  const me = current();
  if (!me) return null;
  const accounts = read(ACCOUNTS, {});
  accounts[me.ref] = { ...accounts[me.ref], email: String(email ?? accounts[me.ref].email ?? '').trim() };
  write(ACCOUNTS, accounts);
  return current();
}

/** Remember a case raised from this device (only the read-only tracking token). */
export function addCase(entry) {
  const p = profile();
  if (!p) return;
  const cases = [entry, ...(p.cases || []).filter((c) => c.id !== entry.id)].slice(0, 30);
  saveProfile({ cases });
}

export function updateCase(id, patch) {
  const p = profile();
  if (!p) return;
  saveProfile({ cases: (p.cases || []).map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

/** Delete the account and every piece of data about it from this device. */
export function deleteEverything() {
  const me = current();
  if (!me) return;
  const accounts = read(ACCOUNTS, {});
  delete accounts[me.ref];
  write(ACCOUNTS, accounts);
  remove(PROFILE(me.ref));
  remove('sehat.contact');
  signOut();
}

/** Hospital-staff session (server-issued, per browser tab). Read-only helper. */
export function staffSession() {
  try { return JSON.parse(sessionStorage.getItem('sehat.staff')); } catch { return null; }
}
