// Live map used by both dashboards: markers are keyed and move/re-colour in
// place when live updates arrive (no map redraw, no flicker).
import { createMap } from './map.js';

const L = () => window.L;
const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// kinds: open · busy · full (hospitals) · self (this hospital) · me (you) ·
//        patient · ambulance · car · dest (accepted hospital)
export function pin(kind, text = '') {
  const size = kind === 'self' || kind === 'dest' ? 38 : kind === 'ambulance' || kind === 'car' ? 34 : 30;
  return L().divIcon({
    className: 'lm-wrap',
    html: `<span class="lm-pin lm-${kind}" style="width:${size}px;height:${size}px">${escAttr(text)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

export const statusKind = (h) => (h.status?.erStatus === 'diverting' ? 'full' : h.status?.erStatus === 'busy' ? 'busy' : 'open');

export class LiveMap {
  constructor(el, center, zoom = 12) {
    this.map = createMap(el, center, zoom);
    this.markers = new Map();
    this.lines = new Map();
    this.fitted = false;
  }

  /** Add or move a marker. */
  set(key, pos, kind, { text = '', popup = '', z = 0 } = {}) {
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) { this.drop(key); return null; }
    let m = this.markers.get(key);
    const sig = `${kind}|${text}`;
    if (!m) {
      m = L().marker([pos.lat, pos.lng], { icon: pin(kind, text), zIndexOffset: z, keyboard: false }).addTo(this.map);
      m.sig = sig;
      this.markers.set(key, m);
    } else {
      m.setLatLng([pos.lat, pos.lng]);
      if (m.sig !== sig) { m.setIcon(pin(kind, text)); m.sig = sig; }
    }
    if (popup) { if (m.getPopup()) m.setPopupContent(popup); else m.bindPopup(popup); }
    return m;
  }

  /** Add or update a dashed route line. */
  line(key, a, b, color = '#e11d48') {
    if (!a || !b) { this.drop(key); return; }
    const pts = [[a.lat, a.lng], [b.lat, b.lng]];
    const l = this.lines.get(key);
    if (l) l.setLatLngs(pts);
    else this.lines.set(key, L().polyline(pts, { color, weight: 3, dashArray: '6 8', opacity: 0.85 }).addTo(this.map));
  }

  drop(key) {
    this.markers.get(key)?.remove();
    this.markers.delete(key);
    this.lines.get(key)?.remove();
    this.lines.delete(key);
  }

  /** Remove markers/lines with this prefix that are not in `keep`. */
  prune(prefix, keep) {
    for (const k of [...this.markers.keys(), ...this.lines.keys()]) if (k.startsWith(prefix) && !keep.has(k)) this.drop(k);
  }

  fit(force = false) {
    if (this.fitted && !force) return;
    const pts = [...this.markers.values()].map((m) => m.getLatLng());
    if (pts.length > 1) this.map.fitBounds(L().latLngBounds(pts).pad(0.15), { maxZoom: 14 });
    else if (pts.length === 1) this.map.setView(pts[0], 13);
    this.fitted = true;
  }

  destroy() { this.map.remove(); }
}

export function legend(items) {
  return `<div class="map-legend">${items.map(([kind, label]) => `<span><span class="lm-dot lm-${kind}"></span>${label}</span>`).join('')}</div>`;
}
