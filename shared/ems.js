// National ambulance services: which number handles a case, and how urgent it is
// for the control room. Shared by the server and the browser demo.

import { roadKm } from './predict.js';

/** 102 (Janani Express) for pregnancy transport, otherwise 108. */
export const serviceFor = (triage) => (triage?.ambulanceType === 'JANANI' ? '102' : '108');

/** Control-room priority from Medreach severity: P1 critical, P2 serious, P3 other. */
export const priorityFor = (severity) => ({ critical: 'P1', serious: 'P2' }[severity] || 'P3');

/** Statuses a control room may report for an incident, mapped to Medreach transport phases. */
export const EMS_PHASES = {
  assigned: 'to_patient',
  enroute_to_patient: 'to_patient',
  at_patient: 'at_patient',
  patient_on_board: 'to_hospital',
  to_hospital: 'to_hospital',
};

/**
 * Nearest suitable free unit: the requested type is preferred, but not at any
 * distance – a basic ambulance 3 km away beats an advanced one 40 km away
 * (each step down the preference list counts as 8 extra km).
 * → { a: unit, km } | null
 */
export function pickUnit(units, type, from) {
  const order = type === 'ALS' ? ['ALS', 'BLS'] : type === 'JANANI' ? ['JANANI', 'BLS', 'ALS'] : ['BLS', 'ALS', 'JANANI'];
  const pool = units.filter((a) => a.available && order.includes(a.type))
    .map((a) => { const km = roadKm(from, a); return { a, km, score: km + order.indexOf(a.type) * 8 }; })
    .sort((x, y) => x.score - y.score);
  return pool[0] ? { a: pool[0].a, km: pool[0].km } : null;
}
