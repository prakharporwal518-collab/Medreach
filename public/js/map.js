// 🗺️ Maps & navigation – Leaflet + OpenStreetMap tiles, road routing via the
// public OSRM service, with a straight-line fallback when offline.

const L = window.L;

export function createMap(el, center, zoom = 13) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  // Leaflet needs a size recalculation when its container was hidden.
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}

export function emojiIcon(emoji, size = 28) {
  return L.divIcon({ className: 'pin', html: `<span style="font-size:${size}px">${emoji}</span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

export function marker(map, pos, emoji, popup) {
  const m = L.marker([pos.lat, pos.lng], { icon: emojiIcon(emoji) }).addTo(map);
  if (popup) m.bindPopup(popup);
  return m;
}

const MANEUVER = {
  en: {
    depart: 'Start', arrive: 'Arrive at destination', 'turn-left': 'Turn left', 'turn-right': 'Turn right',
    'turn-slight left': 'Keep slightly left', 'turn-slight right': 'Keep slightly right', 'turn-sharp left': 'Sharp left',
    'turn-sharp right': 'Sharp right', 'turn-straight': 'Continue straight', 'turn-uturn': 'Make a U-turn',
    roundabout: 'Take the roundabout', rotary: 'Take the roundabout', merge: 'Merge', 'on ramp': 'Take the ramp',
    'off ramp': 'Take the exit', fork: 'Keep at the fork', 'end of road': 'At the end of the road turn', continue: 'Continue',
    'new name': 'Continue', onto: 'onto', for: 'for',
  },
  hi: {
    depart: 'शुरू करें', arrive: 'मंज़िल पर पहुँचें', 'turn-left': 'बाएँ मुड़ें', 'turn-right': 'दाएँ मुड़ें',
    'turn-slight left': 'थोड़ा बाएँ रहें', 'turn-slight right': 'थोड़ा दाएँ रहें', 'turn-sharp left': 'तेज़ बाएँ',
    'turn-sharp right': 'तेज़ दाएँ', 'turn-straight': 'सीधे चलें', 'turn-uturn': 'यू-टर्न लें',
    roundabout: 'गोल चक्कर लें', rotary: 'गोल चक्कर लें', merge: 'मिलें', 'on ramp': 'रैंप लें',
    'off ramp': 'निकास लें', fork: 'दोराहे पर रहें', 'end of road': 'सड़क के अंत में मुड़ें', continue: 'चलते रहें',
    'new name': 'चलते रहें', onto: '→', for: '',
  },
};

function describeStep(step, lang) {
  const t = MANEUVER[lang] || MANEUVER.en;
  const { type, modifier } = step.maneuver;
  const key = type === 'turn' || type === 'end of road' ? `turn-${modifier || 'straight'}` : type;
  let text = t[key] || t[type] || t.continue;
  if (type === 'end of road') text = `${t['end of road']} ${modifier?.includes('left') ? (lang === 'hi' ? 'बाएँ' : 'left') : (lang === 'hi' ? 'दाएँ' : 'right')}`;
  if (step.name) text += ` ${t.onto} ${step.name}`;
  const dist = step.distance >= 1000 ? `${(step.distance / 1000).toFixed(1)} km` : `${Math.round(step.distance / 10) * 10} m`;
  return { text, distance: dist, modifier: modifier || '', type };
}

/**
 * Road route between two points.
 * @returns {{coords:[number,number][], distanceKm:number, durationMin:number, steps:object[], fallback:boolean}}
 */
export async function route(from, to, lang = 'en') {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const r = data.routes?.[0];
    if (!r) throw new Error('no route');
    return {
      coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distanceKm: Math.round(r.distance / 100) / 10,
      durationMin: Math.round(r.duration / 60),
      steps: r.legs[0].steps.filter((s) => s.distance > 0 || s.maneuver.type === 'arrive').map((s) => describeStep(s, lang)),
      fallback: false,
    };
  } catch {
    return { coords: [[from.lat, from.lng], [to.lat, to.lng]], distanceKm: null, durationMin: null, steps: [], fallback: true };
  }
}

/** Point at fraction f (0..1) along a polyline. */
export function pointAlong(coords, f) {
  if (coords.length < 2) return coords[0];
  const seg = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i]) {
      const k = seg[i] ? target / seg[i] : 0;
      return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * k, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * k];
    }
    target -= seg[i];
  }
  return coords.at(-1);
}

export const ARROWS = { left: '⬅️', right: '➡️', 'slight left': '↖️', 'slight right': '↗️', 'sharp left': '⬅️', 'sharp right': '➡️', uturn: '↩️', straight: '⬆️' };
