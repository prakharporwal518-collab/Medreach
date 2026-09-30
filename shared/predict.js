// Medreach – predictive analytics.
//
// Small, explainable statistical models (no black box) that answer the three
// questions a dispatcher asks in their head:
//   1. How long will it REALLY take to get there at this hour?   (traffic model)
//   2. Will a bed still be free when we arrive?                  (Poisson queue model)
//   3. How long will we wait in the emergency room?              (queue model)
// In production these curves would be fitted on historical 108 / hospital
// HMIS data; here they are seeded with realistic Indian urban patterns.

// Relative ER arrivals by hour of day (mean = 1.0). Evening peak, night trough.
export const HOURLY_ER_PATTERN = [
  0.55, 0.45, 0.40, 0.38, 0.40, 0.50, 0.70, 0.90, 1.05, 1.15, 1.20, 1.20,
  1.15, 1.10, 1.05, 1.05, 1.10, 1.25, 1.40, 1.50, 1.45, 1.30, 1.00, 0.75,
];

// Urban traffic congestion multiplier on travel time, by hour of day.
export const URBAN_TRAFFIC = [
  0.80, 0.78, 0.78, 0.78, 0.80, 0.85, 0.95, 1.15, 1.45, 1.60, 1.50, 1.30,
  1.25, 1.25, 1.25, 1.30, 1.40, 1.55, 1.70, 1.65, 1.40, 1.15, 0.95, 0.85,
];

export const ROAD_FACTOR = 1.35; // straight-line → road distance (Indian cities)

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function roadKm(a, b) {
  return haversineKm(a, b) * ROAD_FACTOR;
}

/**
 * Predict travel time in minutes.
 * Long trips are mostly highway (faster, less affected by city traffic).
 * @param {number} km road distance
 * @param {object} o { hour, mode: 'ambulance'|'private' }
 */
export function predictTravelMin(km, { hour = new Date().getHours(), mode = 'private' } = {}) {
  const cityKm = Math.min(km, 12);
  const highwayKm = Math.max(0, km - 12);
  const traffic = URBAN_TRAFFIC[hour % 24];
  // An ambulance with siren beats traffic partly, not fully.
  const trafficEffect = mode === 'ambulance' ? 1 + (traffic - 1) * 0.45 : traffic;
  const citySpeed = (mode === 'ambulance' ? 32 : 26) / trafficEffect; // km/h
  const highwaySpeed = mode === 'ambulance' ? 60 : 55;
  const minutes = (cityKm / citySpeed + highwayKm / highwaySpeed) * 60;
  return {
    minutes: Math.max(2, Math.round(minutes)),
    trafficFactor: Math.round(trafficEffect * 100) / 100,
    trafficLabel: traffic >= 1.45 ? 'heavy' : traffic >= 1.15 ? 'moderate' : 'light',
  };
}

function poissonCdf(k, lambda) {
  // P(X <= k) for X ~ Poisson(lambda)
  if (k < 0) return 0;
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * Probability that at least one bed of `bedType` is still free when we arrive.
 * Model: over the next `etaMin` minutes, competing admissions arrive as a
 * Poisson process whose rate follows the hour-of-day pattern; expected
 * discharges free up extra beds. Bed is available if competing admissions
 * < free beds now + discharges.
 */
export function predictBedAvailability(hospital, bedType, etaMin, hour = new Date().getHours()) {
  const beds = hospital.status?.beds?.[bedType] ?? { free: 0, total: 0 };
  const stats = hospital.stats || {};
  const admitRatePerHour = (stats.admissionsPerHour?.[bedType] ?? 0.5) * HOURLY_ER_PATTERN[hour % 24];
  const dischargePerHour = stats.dischargesPerHour?.[bedType] ?? 0.3;
  const hours = Math.max(etaMin, 1) / 60;
  // Patients already waiting in the ER will also claim some of these beds.
  const queueShare = { icu: 0.08, labour: 0.05, emergency: 0.2 }[bedType] ?? 0.1;
  const queuePressure = (hospital.status?.erQueue ?? 0) * queueShare;
  const lambda = admitRatePerHour * hours + queuePressure;
  const expectedDischarges = Math.floor(dischargePerHour * hours);
  const capacity = beds.free + expectedDischarges;
  const probability = capacity <= 0 ? 0.05 : poissonCdf(capacity - 1, lambda);
  return {
    bedType,
    freeNow: beds.free,
    total: beds.total,
    expectedFreeOnArrival: Math.max(0, Math.round((beds.free + dischargePerHour * hours - lambda) * 10) / 10),
    probability: Math.round(probability * 100) / 100,
  };
}

/**
 * Predicted wait before a doctor sees the patient (minutes).
 * Critical patients are triaged to the front of the queue.
 */
export function predictErWaitMin(hospital, severity = 'serious', hour = new Date().getHours()) {
  const s = hospital.status || {};
  const doctors = Math.max(1, s.erDoctors ?? 2);
  const queue = (s.erQueue ?? 0) * HOURLY_ER_PATTERN[hour % 24];
  const perPatient = 12; // average minutes of doctor time per patient
  const wait = (queue / doctors) * perPatient;
  const priority = { critical: 0.1, serious: 0.45, moderate: 1 }[severity] ?? 1;
  return Math.round(Math.min(180, wait * priority));
}

/** Expected ER arrivals for the next `hours` hours (for the hospital console). */
export function forecastArrivals(hospital, hours = 6, from = new Date().getHours()) {
  const base = hospital.stats?.erArrivalsPerHour ?? 4;
  return Array.from({ length: hours }, (_, i) => {
    const h = (from + i) % 24;
    return { hour: h, expected: Math.round(base * HOURLY_ER_PATTERN[h] * 10) / 10 };
  });
}
