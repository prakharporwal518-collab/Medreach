// Emergency by SMS – for villages where mobile data doesn't work but SMS does (2G).
//
// The app writes an SMS that a person can read AND the Medreach SMS gateway
// can parse. The machine part is a short code at the end:
//
//   MEDREACH SOS: Heart attack (CRITICAL) at 23.23550,77.40050 → Bansal Hospital
//   #MR1 cardiac C 23.23550 77.40050 bansal en
//
//   #MR1 <type> <C|S|M severity> <lat> <lng> [hospitalId|-] [en|hi]
//
// A plain SMS typed by hand also works if it contains coordinates
// ("heart attack 23.2355,77.4005"); without a location we can only reply
// "call 108", because the location is what everything else depends on.
// Shared by the phone (to write) and the server (to read).

import { EMERGENCIES, SEVERITY } from './triage.js';

const SEV_CODE = { critical: 'C', serious: 'S', moderate: 'M' };
const CODE_SEV = { C: 'critical', S: 'serious', M: 'moderate' };
const inIndia = (lat, lng) => lat > 5 && lat < 38 && lng > 67 && lng < 99;
export const MAX_SMS_TEXT = 480;

export function buildEmergencySms({ triage, location, hospital = null, lang = 'en' }) {
  const lat = location.lat.toFixed(5);
  const lng = location.lng.toFixed(5);
  const sev = (triage.severity || 'serious').toUpperCase();
  const human = lang === 'hi'
    ? `MEDREACH SOS: ${triage.label} (${sev}) स्थान ${lat},${lng}${hospital ? ` → ${hospital.name}` : ''}`
    : `MEDREACH SOS: ${triage.label} (${sev}) at ${lat},${lng}${hospital ? ` → ${hospital.name}` : ''}`;
  const code = `#MR1 ${triage.type || 'general'} ${SEV_CODE[triage.severity] || 'S'} ${lat} ${lng} ${hospital?.id || '-'} ${lang === 'hi' ? 'hi' : 'en'}`;
  return `${human}\n${code}`;
}

/**
 * → { ok, type, severity, location, hospitalId, lang, text } or { ok: false, reason }.
 * Never throws: SMS text comes from anyone.
 */
export function parseEmergencySms(raw) {
  const text = String(raw ?? '').slice(0, MAX_SMS_TEXT);
  const m = /#MR1\s+([a-z_]+)\s+([CSM])\s+(-?\d{1,2}\.\d{2,7})\s+(-?\d{2,3}\.\d{2,7})(?:\s+([a-z0-9-]+|-))?(?:\s+(en|hi))?/i.exec(text);
  if (m) {
    const lat = Number(m[3]);
    const lng = Number(m[4]);
    if (!inIndia(lat, lng)) return { ok: false, reason: 'location' };
    const type = m[1].toLowerCase();
    return {
      ok: true,
      type: EMERGENCIES[type] ? type : null,
      severity: CODE_SEV[m[2].toUpperCase()],
      location: { lat, lng },
      hospitalId: m[5] && m[5] !== '-' ? m[5].toLowerCase() : null,
      lang: (m[6] || 'en').toLowerCase(),
      text: text.replace(m[0], '').trim(),
    };
  }
  // Hand-typed: "<what happened> 23.2355, 77.4005"
  const ll = /(-?\d{1,2}\.\d{2,7})\s*[, ]\s*(-?\d{2,3}\.\d{2,7})/.exec(text);
  if (ll && inIndia(Number(ll[1]), Number(ll[2]))) {
    return { ok: true, type: null, severity: null, location: { lat: Number(ll[1]), lng: Number(ll[2]) }, hospitalId: null, lang: /[ऀ-ॿ]/.test(text) ? 'hi' : 'en', text: text.replace(ll[0], ' ').trim() };
  }
  return { ok: false, reason: 'location' };
}

/** The higher of two severities (an SMS can raise urgency, never lower the rules' floor). */
export const maxSeverity = (a, b) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b) || a || b;

// Replies are short: one SMS where possible.
export function smsText(kind, d, lang = 'en') {
  const hi = lang === 'hi';
  switch (kind) {
    case 'no_location':
      return hi ? 'MEDREACH: आपका स्थान नहीं मिला। तुरंत 108 पर कॉल करें। Medreach ऐप से SMS भेजें ताकि स्थान साथ जाए।'
        : 'MEDREACH: We could not find your location in the SMS. CALL 108 NOW. Send the SMS from the Medreach app so it includes your location.';
    case 'no_hospital':
      return hi ? `MEDREACH ${d.caseId}: अभी कोई उपयुक्त अस्पताल नहीं मिला। तुरंत 108 पर कॉल करें।`
        : `MEDREACH ${d.caseId}: No suitable hospital could accept right now. CALL 108 NOW.`;
    case 'received':
      return hi ? `MEDREACH ${d.caseId}: ${d.label} (${d.severity}) मिला। ${d.hospital} से स्वीकृति माँगी जा रही है। स्वीकृति पर SMS आएगा। हालत बिगड़े तो 108 पर कॉल करें।`
        : `MEDREACH ${d.caseId}: ${d.label} (${d.severity}) received. Asking ${d.hospital} to accept now – you will get an SMS. If the patient gets worse, CALL 108.`;
    case 'accepted':
      return hi ? `MEDREACH ${d.caseId}: ${d.hospital} ने मरीज़ को स्वीकार किया (बे ${d.bay}). ${d.ambulance}${d.track ? ` लाइव: ${d.track}` : ''}`
        : `MEDREACH ${d.caseId}: ${d.hospital} ACCEPTED the patient (bay ${d.bay}). ${d.ambulance}${d.track ? ` Live: ${d.track}` : ''}`;
    case 'retry':
      return hi ? `MEDREACH ${d.caseId}: ${d.previous} स्वीकार नहीं कर सका। अब ${d.hospital} से पूछ रहे हैं।`
        : `MEDREACH ${d.caseId}: ${d.previous} could not accept. Now asking ${d.hospital}.`;
    default:
      return '';
  }
}
