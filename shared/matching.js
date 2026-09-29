// Sehat Setu – find the RIGHT hospital, not just the nearest one.
//
//   capability available?  ──┐
//                            ├──► distance + ETA ──► ranked options
//   current status?        ──┘
//
// Runs on the server (with live hospital status) and in the browser (offline,
// with the last cached status), so a family is never left without an answer.

import { checkCapability, capLabel } from './capabilities.js';
import { roadKm, predictTravelMin, predictBedAvailability, predictErWaitMin } from './predict.js';

// Which bed the patient will need on arrival.
export function bedTypeFor(triage) {
  if (triage.severity === 'critical' || triage.required.includes('icu')) return 'icu';
  if (triage.type === 'pregnancy') return 'labour';
  return 'emergency';
}

/**
 * Rank hospitals for a triaged emergency.
 * @param {object} triage   result of triage()
 * @param {{lat:number,lng:number}} location
 * @param {object[]} hospitals  registry with live `status`
 * @param {object} [o] { hour, mode, maxKm }
 * @returns {{ options: object[], excluded: object[], stabilise: object|null }}
 */
export function rankHospitals(triage, location, hospitals, { hour = new Date().getHours(), mode = 'ambulance', maxKm = 150 } = {}) {
  const bedType = bedTypeFor(triage);
  const evaluated = hospitals.map((h) => {
    const km = Math.round(roadKm(location, h) * 10) / 10;
    const travel = predictTravelMin(km, { hour, mode });
    const capChecks = triage.required.map((cap) => checkCapability(h, cap));
    const prefChecks = triage.preferred.map((cap) => checkCapability(h, cap));
    const missing = capChecks.filter((c) => !c.live);
    const bed = predictBedAvailability(h, bedType, travel.minutes, hour);
    const erWait = predictErWaitMin(h, triage.severity, hour);
    const erStatus = h.status?.erStatus ?? 'open';

    const reasonsOut = [];
    if (km > maxKm) reasonsOut.push('too_far');
    if (erStatus === 'diverting') reasonsOut.push('er_diverting');
    // Specialty hospitals only take their own patient group.
    if (h.servesOnly === 'children' && !triage.patient?.isChild) reasonsOut.push('children_only');
    if (h.servesOnly === 'maternity' && triage.type !== 'pregnancy') reasonsOut.push('maternity_only');
    for (const m of missing) reasonsOut.push(`${m.reason}:${m.cap}`);
    if (bed.freeNow === 0 && bed.probability < 0.2) reasonsOut.push(`no_${bedType}_bed`);

    // "Time to definitive care" drives the score; the golden hour sets the scale.
    const timeToCare = travel.minutes + erWait;
    const scale = Math.max(30, triage.golden * 1.2);
    const timeScore = Math.max(0, 1 - timeToCare / scale);
    const prefScore = prefChecks.length ? prefChecks.filter((c) => c.live).length / prefChecks.length : 1;
    const busyPenalty = erStatus === 'busy' ? 0.08 : 0;
    const w = triage.severity === 'critical'
      ? { time: 0.55, bed: 0.25, pref: 0.15, level: 0.05 }
      : { time: 0.45, bed: 0.25, pref: 0.15, level: 0.15 };
    const levelScore = { tertiary: 1, secondary: 0.6, primary: 0.3 }[h.level] ?? 0.5;
    const score = Math.round(100 * Math.max(0,
      w.time * timeScore + w.bed * bed.probability + w.pref * prefScore + w.level * levelScore - busyPenalty));

    return {
      hospital: publicHospital(h),
      distanceKm: km,
      etaMin: travel.minutes,
      traffic: travel.trafficLabel,
      trafficFactor: travel.trafficFactor,
      erWaitMin: erWait,
      timeToCareMin: timeToCare,
      bed,
      bedType,
      erStatus,
      capChecks,
      prefChecks,
      eligible: reasonsOut.length === 0,
      excludedBecause: reasonsOut,
      score,
    };
  });

  const options = evaluated.filter((e) => e.eligible).sort((a, b) => b.score - a.score);
  const excluded = evaluated
    .filter((e) => !e.eligible && e.distanceKm <= maxKm)
    .sort((a, b) => a.etaMin - b.etaMin);

  options.forEach((o, i) => { o.rank = i + 1; o.recommended = i === 0; });

  // Golden-hour safety net: if the best capable hospital is far and the
  // patient is critical, suggest the nearest open emergency department for
  // stabilisation before transfer.
  let stabilise = null;
  const best = options[0];
  if (triage.severity === 'critical') {
    const nearestEr = evaluated
      .filter((e) => e.erStatus !== 'diverting' && checkCapability(e.hospital, 'emergency').live)
      .sort((a, b) => a.etaMin - b.etaMin)[0];
    if (nearestEr && (!best || (best.etaMin > triage.golden * 0.5 && nearestEr.etaMin < best.etaMin * 0.5))) {
      if (!best || nearestEr.hospital.id !== best.hospital.id) stabilise = nearestEr;
    }
  }
  return { options, excluded, stabilise, bedType };
}

export function publicHospital(h) {
  const { stats, ...rest } = h;
  return rest;
}

/** Human-readable reasons shown on each hospital card ("why this hospital"). */
export function explain(option, lang = 'en') {
  const hi = lang === 'hi';
  const out = [];
  const liveCaps = option.capChecks.filter((c) => c.live).length;
  out.push(hi
    ? `ज़रूरी ${option.capChecks.length} में से ${liveCaps} सुविधाएँ अभी उपलब्ध`
    : `${liveCaps}/${option.capChecks.length} required services available right now`);
  const beds = option.bed.freeNow;
  out.push(hi
    ? `${beds} ${option.bedType.toUpperCase()} बेड खाली · पहुँचने तक खाली रहने की संभावना ${Math.round(option.bed.probability * 100)}%`
    : `${beds} ${option.bedType.toUpperCase()} bed${beds === 1 ? '' : 's'} free · ${Math.round(option.bed.probability * 100)}% likely free on arrival`);
  const extras = option.prefChecks.filter((c) => c.live).map((c) => capLabel(c.cap, lang));
  if (extras.length) out.push(hi ? `अतिरिक्त: ${extras.join(', ')}` : `Also has: ${extras.join(', ')}`);
  if (option.trafficFactor > 1.1) {
    out.push(hi
      ? `अभी ट्रैफ़िक ${option.traffic === 'heavy' ? 'भारी' : 'मध्यम'} (+${Math.round((option.trafficFactor - 1) * 100)}% समय)`
      : `${option.traffic} traffic now (+${Math.round((option.trafficFactor - 1) * 100)}% travel time)`);
  }
  if (option.erWaitMin > 0) out.push(hi ? `अनुमानित इंतज़ार ${option.erWaitMin} मिनट` : `Predicted ER wait ${option.erWaitMin} min`);
  return out;
}
