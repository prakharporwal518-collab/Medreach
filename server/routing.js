// Medreach – real road routes for ambulance and vehicle movement.
//
// Uses the public OSRM routing service (OpenStreetMap roads, no API key). The
// result is cached; on any error or timeout the caller keeps a straight line, so
// tracking never stops because routing is down.

import { downsample } from '../shared/geo.js';

const BASE = process.env.SEHAT_OSRM_URL || 'https://router.project-osrm.org';
const TIMEOUT_MS = Number(process.env.SEHAT_ROUTING_TIMEOUT_MS || 6000);
const cache = new Map();

export function routingEnabled(env = process.env) {
  return env.SEHAT_ROUTING !== 'off' && env.NODE_ENV !== 'test';
}

/** @returns {Promise<{coords:[number,number][], km:number, min:number} | null>} */
export async function roadRoute(from, to) {
  const key = [from.lat, from.lng, to.lat, to.lng].map((n) => Number(n).toFixed(4)).join(',');
  if (cache.has(key)) return cache.get(key);
  const url = `${BASE}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Medreach/1.0 (emergency coordination prototype)' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.routes?.[0];
    if (!r) return null;
    const out = {
      coords: downsample(r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), 150),
      km: Math.round(r.distance / 100) / 10,
      min: Math.max(1, Math.round(r.duration / 60)),
    };
    if (cache.size > 500) cache.clear();
    cache.set(key, out);
    return out;
  } catch {
    return null;
  }
}
