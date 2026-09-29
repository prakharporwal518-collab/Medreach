// API client with offline fallbacks. If the network is down, the same shared
// engines the server uses run right here in the browser.

import { triage as localTriage } from '/shared/triage.js';
import { rankHospitals, explain } from '/shared/matching.js';

const HOSPITAL_CACHE_KEY = 'sehat.hospitals.v1';

async function json(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const isNetworkError = (e) => !e.status; // fetch() TypeError, not an HTTP error

export async function getConfig() {
  try { return await json('/api/config'); } catch { return { ai: false, demoLocation: { lat: 23.2355, lng: 77.4005 }, offline: true }; }
}

export async function triage(payload) {
  try {
    return await json('/api/triage', { method: 'POST', body: payload });
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const combined = payload.visionFindings ? `${payload.text}\n${payload.visionFindings}` : payload.text;
    return { ...localTriage(combined, payload), offline: true };
  }
}

export async function hospitals() {
  try {
    const list = await json('/api/hospitals');
    try { localStorage.setItem(HOSPITAL_CACHE_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* storage full/blocked */ }
    return list;
  } catch {
    try { return JSON.parse(localStorage.getItem(HOSPITAL_CACHE_KEY))?.list || []; } catch { return []; }
  }
}

export async function match(payload) {
  try {
    return await json('/api/match', { method: 'POST', body: payload });
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const list = (await hospitals()).filter((h) => !(payload.excludeIds || []).includes(h.id));
    const out = rankHospitals(payload.triage, payload.location, list, { mode: payload.mode });
    for (const o of [...out.options, ...(out.stabilise ? [out.stabilise] : [])]) o.reasons = explain(o, payload.lang);
    return { ...out, offline: true };
  }
}

export const createCase = (body) => json('/api/cases', { method: 'POST', body });
export const requestAdmission = (id, body) => json(`/api/cases/${id}/request`, { method: 'POST', body });
export const startTransport = (id, mode) => json(`/api/cases/${id}/transport`, { method: 'POST', body: { mode } });
export const sendPosition = (id, body) => json(`/api/cases/${id}/position`, { method: 'POST', body }).catch(() => {});
export const markArrived = (id) => json(`/api/cases/${id}/arrived`, { method: 'POST' });
export const streamCase = (id) => new EventSource(`/api/stream/case/${id}`);
