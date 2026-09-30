// Citizen account & personal health profile – stored ONLY on this device.
//
// Privacy by design: the server never holds a citizen's profile, health
// records or case list. Nothing is shared until the citizen raises an
// emergency (and patient details only with explicit consent). Passwords are
// never stored – only a salted PBKDF2 hash (Web Crypto).
//
// This is completely separate from the hospital-staff session (which lives
// in sessionStorage and is issued by the server after Hospital ID + Staff ID + OTP).

const ACCOUNTS = 'sehat.citizen.accounts';
const SESSION = 'sehat.citizen.session';
const PROFILE = (phone) => `sehat.citizen.profile.${phone}`;

function read(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const normalisePhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}

export async function register({ name, email, phone, password }) {
  const p = normalisePhone(phone);
  if (!name?.trim()) throw new Error('Please enter your full name');
  if (p.length !== 10) throw new Error('Enter a valid 10-digit mobile number');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  const accounts = read(ACCOUNTS, {});
  if (accounts[p]) throw new Error('An account with this mobile already exists on this device – sign in instead');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  accounts[p] = { name: name.trim(), email: (email || '').trim(), phone: p, salt, hash: await hashPassword(password, salt), createdAt: new Date().toISOString() };
  write(ACCOUNTS, accounts);
  write(PROFILE(p), { health: {}, contacts: [], cases: [], lang: 'en' });
  write(SESSION, { phone: p, at: Date.now() });
  return accounts[p];
}

export async function signIn(phone, password) {
  const p = normalisePhone(phone);
  const acc = read(ACCOUNTS, {})[p];
  // Same message for unknown number / wrong password.
  if (!acc || (await hashPassword(password || '', acc.salt)) !== acc.hash) throw new Error('Mobile number or password is incorrect');
  write(SESSION, { phone: p, at: Date.now() });
  return acc;
}

export function signOut() {
  try { localStorage.removeItem(SESSION); } catch { /* ignore */ }
}

/** The signed-in citizen (without the password hash), or null. */
export function current() {
  const s = read(SESSION);
  if (!s?.phone) return null;
  const acc = read(ACCOUNTS, {})[s.phone];
  if (!acc) return null;
  const { hash, salt, ...pub } = acc;
  return pub;
}

export function profile() {
  const me = current();
  if (!me) return null;
  return { health: {}, contacts: [], cases: [], lang: 'en', ...read(PROFILE(me.phone), {}) };
}

export function saveProfile(patch) {
  const me = current();
  if (!me) return null;
  const next = { ...profile(), ...patch };
  write(PROFILE(me.phone), next);
  // The emergency flow reads the primary trusted contact from this key.
  const primary = next.contacts?.[0];
  write('sehat.contact', primary ? { name: primary.name, phone: primary.phone } : null);
  return next;
}

export function updateAccount({ name, email }) {
  const me = current();
  if (!me) return null;
  const accounts = read(ACCOUNTS, {});
  accounts[me.phone] = { ...accounts[me.phone], ...(name ? { name: name.trim() } : {}), email: (email ?? accounts[me.phone].email).trim() };
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
  delete accounts[me.phone];
  write(ACCOUNTS, accounts);
  try {
    localStorage.removeItem(PROFILE(me.phone));
    localStorage.removeItem('sehat.contact');
  } catch { /* ignore */ }
  signOut();
}

/** Hospital-staff session (server-issued, per browser tab). Read-only helper. */
export function staffSession() {
  try { return JSON.parse(sessionStorage.getItem('sehat.staff')); } catch { return null; }
}
