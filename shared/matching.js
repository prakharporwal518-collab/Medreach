// Medreach – find the RIGHT hospital, not just the nearest one.
//
//   AI / NLP extracts requirements ──► THIS deterministic engine ──► ranked options
//
//   capability available?  ──┐
//                            ├──► distance + ETA ──► ranked, explained options
//   current status?        ──┘
//
// The AI never picks the hospital. It only states what the patient needs;
// selection is constrained by explicit requirements and staff-verified data.
// Runs on the server (live status) and in the browser (offline, cached status).

import { checkCapability, capLabel } from './capabilities.js';
import { roadKm, predictTravelMin, predictBedAvailability, predictErWaitMin } from './predict.js';
import { freshness, freshnessLabel, ago } from './freshness.js';

// Which bed the patient will need on arrival.
export function bedTypeFor(triage) {
  if (triage.severity === 'critical' || triage.required.includes('icu')) return 'icu';
  if (triage.type === 'pregnancy') return 'labour';
  return 'emergency';
}

// How much we trust reported capacity, by freshness.
const TRUST = { fresh: 1, aging: 0.8, stale: 0.45 };

/**
 * Rank hospitals for a triaged emergency.
 * @param {object} triage   result of triage()
 * @param {{lat:number,lng:number}} location
 * @param {object[]} hospitals  registry with live `status`
 * @param {object} [o] { hour, mode, maxKm, now }
 * @returns {{ options: object[], excluded: object[], stabilise: object|null, bedType: string }}
 */
export function rankHospitals(triage, location, hospitals, {
  hour = new Date().getHours(), mode = 'ambulance', maxKm = 150, now = Date.now(),
} = {}) {
  const bedType = bedTypeFor(triage);
  const evaluated = hospitals.map((h) => {
    const km = Math.round(roadKm(location, h) * 10) / 10;
    const travel = predictTravelMin(km, { hour, mode });
    const capChecks = triage.required.map((cap) => checkCapability(h, cap));
    const prefChecks = triage.preferred.map((cap) => checkCapability(h, cap));
    const missing = capChecks.filter((c) => !c.live);
    const fresh = freshness(h.status?.verifiedAt, now);
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
    if (bed.freeNow === 0 && bed.probability < 0.2 && fresh.verified) reasonsOut.push(`no_${bedType}_bed`);

    // ---- Score (0–100), built from named, explainable parts.
    const w = triage.severity === 'critical'
      ? { time: 55, capacity: 25, services: 15, level: 5 }
      : { time: 45, capacity: 25, services: 15, level: 15 };
    const timeToCare = travel.minutes + erWait;
    const scale = Math.max(30, triage.golden * 1.2);
    const timeScore = Math.max(0, 1 - timeToCare / scale);
    const prefScore = prefChecks.length ? prefChecks.filter((c) => c.live).length / prefChecks.length : 1;
    const levelScore = { tertiary: 1, secondary: 0.6, primary: 0.3 }[h.level] ?? 0.5;
    const parts = {
      time: Math.round(w.time * timeScore),
      capacity: Math.round(w.capacity * bed.probability * TRUST[fresh.level]),
      services: Math.round(w.services * prefScore),
      level: Math.round(w.level * levelScore),
      busy: erStatus === 'busy' ? -8 : 0,
    };
    const score = Math.max(0, Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));

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
      freshness: fresh,
      capacityVerified: fresh.verified,
      capChecks,
      prefChecks,
      eligible: reasonsOut.length === 0,
      excludedBecause: reasonsOut,
      score,
      scoreParts: parts,
      scoreMax: w,
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

/**
 * "Why this hospital?" – a checklist the citizen (and a judge) can read,
 * instead of an unexplained number. Each item: { ok: true|false|'warn', icon, text }.
 * Reported capacity is always labelled as REPORTED, with who/when/source.
 */
export function explain(option, lang = 'en') {
  const hi = lang === 'hi';
  const out = [];
  const h = option.hospital;
  const live = option.capChecks.filter((c) => c.live).map((c) => capLabel(c.cap, lang));
  out.push({ ok: true, icon: '✅', text: hi ? `ज़रूरी सुविधाएँ उपलब्ध: ${live.join(', ')}` : `Required capability available: ${live.join(', ')}` });
  out.push(option.erStatus === 'busy'
    ? { ok: 'warn', icon: '🟠', text: hi ? 'इमरजेंसी खुली – व्यस्त' : 'Emergency department open – busy' }
    : { ok: true, icon: '✅', text: hi ? 'इमरजेंसी विभाग खुला' : 'Emergency department open' });

  const bedName = option.bedType.toUpperCase();
  const beds = option.bed.freeNow;
  const f = option.freshness;
  const fl = freshnessLabel(f, lang);
  if (f.verified) {
    out.push({
      ok: beds > 0 ? true : 'warn', icon: beds > 0 ? '✅' : '⚠️',
      text: hi
        ? `${bedName} क्षमता रिपोर्ट: ${beds} बेड (${ago(f.minutes, lang)})`
        : `${bedName} capacity reported: ${beds} bed${beds === 1 ? '' : 's'} (${ago(f.minutes, lang)})`,
    });
  } else {
    out.push({ ok: 'warn', icon: '⚠️', text: hi ? `${bedName} क्षमता असत्यापित – भर्ती की पुष्टि ज़रूरी` : `${bedName} capacity not verified recently – acceptance required before travel` });
  }
  out.push({ ok: f.level === 'fresh' ? true : 'warn', icon: fl.icon, text: fl.text });

  const extras = option.prefChecks.filter((c) => c.live).map((c) => capLabel(c.cap, lang));
  if (extras.length) out.push({ ok: true, icon: '➕', text: hi ? `अतिरिक्त: ${extras.join(', ')}` : `Also has: ${extras.join(', ')}` });

  const traffic = option.trafficFactor > 1.1
    ? (hi ? ` · ट्रैफ़िक +${Math.round((option.trafficFactor - 1) * 100)}%` : ` · ${option.traffic} traffic +${Math.round((option.trafficFactor - 1) * 100)}%`)
    : '';
  out.push({ ok: true, icon: '🚑', text: hi ? `पहुँच ~${option.etaMin} मिनट (${option.distanceKm} कि.मी.)${traffic}` : `ETA ${option.etaMin} min (${option.distanceKm} km)${traffic}` });
  out.push({ ok: 'pending', icon: '⏳', text: hi ? 'भर्ती: अभी अनुरोध नहीं भेजा' : 'Referral: not requested yet' });

  const src = h.status?.source === 'dashboard'
    ? (hi ? 'अस्पताल इमरजेंसी डैशबोर्ड' : 'Hospital Emergency Dashboard')
    : (hi ? 'सिम्युलेटेड डेमो डेटा' : 'Simulated demo data');
  const by = h.status?.verifiedBy?.role && h.status?.source === 'dashboard' ? ` · ${h.status.verifiedBy.roleLabel || h.status.verifiedBy.role}` : '';
  out.push({ ok: 'info', icon: '🗂️', text: hi ? `डेटा स्रोत: ${src}${by}` : `Data source: ${src}${by}` });
  return out;
}

/** Human-readable score breakdown for the "What does 92 mean?" question. */
export function scoreBreakdown(option, lang = 'en') {
  const hi = lang === 'hi';
  const p = option.scoreParts;
  const m = option.scoreMax;
  const rows = [
    [hi ? 'पहुँचने + इलाज शुरू होने का समय' : 'Time to care (travel + ER wait)', p.time, m.time],
    [hi ? 'पहुँचने पर बेड (ताज़गी सहित)' : 'Bed on arrival × data freshness', p.capacity, m.capacity],
    [hi ? 'अतिरिक्त उपयोगी सुविधाएँ' : 'Extra helpful services', p.services, m.services],
    [hi ? 'अस्पताल स्तर' : 'Facility level', p.level, m.level],
  ];
  if (p.busy) rows.push([hi ? 'इमरजेंसी व्यस्त' : 'ER busy penalty', p.busy, 0]);
  return rows;
}
