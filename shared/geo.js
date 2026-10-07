// Medreach – small geometry helpers shared by the server and the browser.

/** Point at fraction f (0..1) along a polyline of [lat, lng] pairs. */
export function pointAlong(coords, f) {
  if (!coords?.length) return null;
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

/** Keep at most `max` points (always first and last), so routes stay small on the wire. */
export function downsample(coords, max = 80) {
  if (!coords || coords.length <= max) return coords || [];
  const out = [];
  const step = (coords.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

/** Remaining part of a polyline after fraction f (starts at the current point). */
export function remainingPath(coords, f) {
  if (!coords?.length) return [];
  const here = pointAlong(coords, f);
  let total = 0;
  const seg = [];
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let target = Math.max(0, Math.min(1, f)) * total;
  let i = 0;
  while (i < seg.length && target > seg[i]) { target -= seg[i]; i++; }
  return [here, ...coords.slice(i + 1)];
}

export const straightLine = (a, b) => [[a.lat, a.lng], [b.lat, b.lng]];
