// API client with offline fallbacks. If the network is down, the same shared
// engines the server uses run right here in the browser.

import { triage as localTriage } from '/shared/triage.js';
import { rankHospitals, explain, scoreBreakdown } from '/shared/matching.js';

const HOSPITAL_CACHE_KEY = 'sehat.hospitals.v1';
const CONFIG_CACHE_KEY = 'medreach.config.v1';

// On a weak rural network a request must not hang for minutes: give up after a
// while and use the on-phone engines (or the SMS / 108 fallbacks) instead.
const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

async function json(url, opts = {}) {
  const { timeout = 20000, ...rest } = opts;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(rest.headers || {}) },
    body: rest.body ? JSON.stringify(rest.body) : undefined,
    signal: timeoutSignal(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const isNetworkError = (e) => !e.status; // fetch() TypeError, not an HTTP error

// Kept on the phone so offline mode still knows the SMS number and 108/102.
export async function getConfig() {
  try {
    const cfg = await json('/api/config', { timeout: 8000 });
    try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg)); } catch { /* storage blocked */ }
    return cfg;
  } catch {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CONFIG_CACHE_KEY)); } catch { /* ignore */ }
    return { ai: false, demoLocation: { lat: 23.2355, lng: 77.4005 }, ...(saved || {}), offline: true };
  }
}

export async function triage(payload) {
  try {
    return await json('/api/triage', { method: 'POST', body: payload, timeout: 15000 });
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const combined = payload.visionFindings ? `${payload.text}\n${payload.visionFindings}` : payload.text;
    return { ...localTriage(combined, payload), offline: true };
  }
}

export async function hospitals() {
  try {
    const list = await json('/api/hospitals', { timeout: 10000 });
    try { localStorage.setItem(HOSPITAL_CACHE_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* storage full/blocked */ }
    return list;
  } catch {
    try { return JSON.parse(localStorage.getItem(HOSPITAL_CACHE_KEY))?.list || []; } catch { return []; }
  }
}

/** Public ambulance fleet (home stations); null when offline. */
export async function ambulances() {
  try { return await json('/api/ambulances', { timeout: 8000 }); } catch { return null; }
}

export async function match(payload) {
  try {
    return await json('/api/match', { method: 'POST', body: payload, timeout: 12000 });
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const list = (await hospitals()).filter((h) => !(payload.excludeIds || []).includes(h.id));
    const out = rankHospitals(payload.triage, payload.location, list, { mode: payload.mode });
    for (const o of [...out.options, ...(out.stabilise ? [out.stabilise] : [])]) {
      o.checklist = explain(o, payload.lang);
      o.breakdown = scoreBreakdown(o, payload.lang);
    }
    return { ...out, offline: true };
  }
}

// The case token is returned once when the case is created and proves this
// device owns the case. It is kept in memory, plus this tab's sessionStorage
// (cleared when the tab closes) so the citizen dashboard in the same tab can
// follow the real ambulance position. It is never written to localStorage.
let caseToken = null;
const TOKEN_KEY = (id) => `sehat.caseTok.${id}`;
export function savedCaseToken(id) { try { return sessionStorage.getItem(TOKEN_KEY(id)); } catch { return null; } }
const withCase = (opts = {}) => ({ ...opts, headers: { ...(opts.headers || {}), 'X-Case-Token': caseToken || '' } });

export async function createCase(body) {
  const c = await json('/api/cases', { method: 'POST', body });
  caseToken = c.accessToken;
  try { sessionStorage.setItem(TOKEN_KEY(c.id), caseToken); } catch { /* private mode */ }
  return c;
}
export const requestAdmission = (id, body) => json(`/api/cases/${id}/request`, withCase({ method: 'POST', body }));
export const startTransport = (id, mode) => json(`/api/cases/${id}/transport`, withCase({ method: 'POST', body: { mode } }));
export const sendPosition = (id, body) => json(`/api/cases/${id}/position`, withCase({ method: 'POST', body })).catch(() => {});
export const markArrived = (id) => json(`/api/cases/${id}/arrived`, withCase({ method: 'POST' }));
export const streamCase = (id, token = caseToken) => new EventSource(`/api/stream/case/${id}?t=${encodeURIComponent(token || '')}`);
export const streamHospitals = () => new EventSource('/api/stream/hospitals');
export const getTrack = (id, t) => json(`/api/track/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`);
export const streamTrack = (id, t) => new EventSource(`/api/stream/track/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`);
