// National ambulance services – hand-off to the state 108 / 102 control room.
//
// India's free ambulance numbers: 108 (emergency ambulance, every state),
// 102 (Janani Express – pregnant women and newborns) and 112 (all emergencies).
// Ambulances are dispatched by the state's control room through its
// Computer-Aided Dispatch (CAD) system. Medreach never replaces that: it hands
// over a complete, structured incident (where, what, how urgent, which
// hospital has ALREADY accepted) so the call-taker doesn't have to re-ask, and
// keeps the family and the hospital updated from the control room's status.
//
// Integration contract (JSON over HTTPS, both directions HMAC-signed):
//   Medreach → control room   POST SEHAT_EMS_URL                → { incidentId, unit?, etaMin? }
//   control room → Medreach   POST /api/ems/updates             → status of the incident
//                             { incidentRef, incidentId?, status, unit?, position?, etaMin? (to hospital), etaToPatientMin? }
//   Headers: X-Medreach-Timestamp (unix ms), X-Medreach-Signature: sha256=HMAC(secret, `${ts}.${rawBody}`)
//
// Without SEHAT_EMS_URL the store uses a SIMULATED control room (demo fleet),
// clearly labelled as such. If the real control room can't be reached, the
// case says so and the family is told to call 108 directly.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_SKEW_MS = 5 * 60 * 1000;

export { serviceFor, priorityFor } from '../shared/ems.js';

export function sign(secret, timestamp, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/** Check an incoming signed request (raw body bytes as received). */
export function verifySignature(secret, { timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret || !timestamp || !signature || rawBody == null) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false; // stops replays
  const expected = Buffer.from(sign(secret, ts, rawBody));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The incident as the control room receives it. Only what dispatch needs:
 * no Aadhaar/ABHA numbers, no names unless the family consented.
 */
export function buildIncident({ c, h, ref, service, priority }) {
  const consented = c.consent?.patientDetails;
  return {
    version: '1.0',
    source: 'medreach',
    incidentRef: ref,
    createdAt: new Date().toISOString(),
    service,
    priority,
    ambulanceType: c.triage?.ambulanceType || 'BLS',
    complaint: {
      type: c.triage?.type, label: c.triage?.label, severity: c.triage?.severity,
      redFlags: c.triage?.redFlags || [], personAlone: Boolean(c.alone),
    },
    pickup: { lat: c.location.lat, lng: c.location.lng },
    destination: {
      hospitalId: h.id, name: h.name, lat: h.lat, lng: h.lng, area: h.area,
      accepted: true, acceptedBy: c.acceptedBy?.roleLabel || null, bay: c.bay || null,
    },
    patient: consented ? { age: c.patient?.age || null, gender: c.patient?.gender || null } : null,
    // A number the control room can call back (the family's trusted contact or the SMS sender).
    callback: c.contact?.phone ? String(c.contact.phone) : null,
  };
}

/**
 * Client for a real control room. `dispatch` resolves with
 * { incidentId, unit?: { id, type, base, lat, lng }, etaMin? } or throws.
 */
export function createEmsClient({ url, secret, fetchFn = globalThis.fetch, timeoutMs = 8000, retries = 1 }) {
  if (!url || !secret) return null;
  async function post(body) {
    const ts = Date.now();
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Medreach-Timestamp': String(ts), 'X-Medreach-Signature': sign(secret, ts, body), 'User-Agent': 'Medreach/1.0' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`control room answered HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.incidentId) throw new Error('control room did not return an incident ID');
    return data;
  }
  return {
    name: 'cad',
    async dispatch(input) {
      const body = JSON.stringify(buildIncident(input));
      let last;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try { return await post(body); } catch (err) { last = err; }
      }
      throw last;
    },
  };
}

export const emsEnabled = (env = process.env) => Boolean(env.SEHAT_EMS_URL && env.SEHAT_EMS_SECRET);
