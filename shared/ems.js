// National ambulance services: which number handles a case, and how urgent it is
// for the control room. Shared by the server and the browser demo.

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
