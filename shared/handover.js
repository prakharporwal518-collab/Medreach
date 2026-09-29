// SBAR pre-arrival handover note built from the case data (no AI needed).
// server/llm.js asks Claude to improve this draft when an API key is set.

import { EMERGENCIES } from './triage.js';
import { CAPABILITIES } from './capabilities.js';

export function templateHandover(c) {
  const t = c.triage;
  const p = c.patient || {};
  const who = [p.name, p.age ? `${p.age}y` : t.patient?.age ? `${t.patient.age}y` : null, p.gender].filter(Boolean).join(', ') || 'Unknown patient';
  return [
    `S: ${who} – ${t.severity.toUpperCase()} ${EMERGENCIES[t.type].label.en}.`,
    `B: ${[p.conditions?.length ? `K/C/O ${p.conditions.join(', ')}` : null, p.allergies?.length ? `Allergies: ${p.allergies.join(', ')}` : null, p.medicines?.length ? `Meds: ${p.medicines.join(', ')}` : null, p.bloodGroup ? `Blood group ${p.bloodGroup}` : null].filter(Boolean).join('. ') || 'No history available.'}`,
    `A: ${t.summary}${t.redFlagLabels?.length && !t.summary.includes('Red flags') ? ` Red flags: ${t.redFlagLabels.join(', ')}.` : ''}${c.vision?.description ? ` Photo: ${c.vision.description}` : ''}`,
    `R: Prepare ${t.required.map((x) => CAPABILITIES[x]?.en || x).join(', ')}. Bed: ${c.bedType?.toUpperCase() || 'ER'}.`,
  ].join('\n');
}
