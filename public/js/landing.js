// Home page: icons, live network stats, and old tracking links.
import { hydrateIcons } from './icons.js';
import { freshness } from '/shared/freshness.js';

// Family tracking links used to point at "/?track=…" – forward them.
if (new URLSearchParams(location.search).get('track')) location.replace(`/report${location.search}`);

hydrateIcons();

async function stats() {
  try {
    const [hospitals, config] = await Promise.all([
      fetch('/api/hospitals').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()),
    ]);
    const icu = hospitals.reduce((n, h) => n + (h.status?.beds?.icu?.free || 0), 0);
    const docs = hospitals.reduce((n, h) => n + (h.status?.onDuty?.length || 0), 0);
    const fresh = hospitals.filter((h) => freshness(h.status?.verifiedAt).level === 'fresh').length;
    document.getElementById('sHosp').textContent = hospitals.length;
    document.getElementById('sIcu').textContent = icu;
    document.getElementById('sDocs').textContent = docs;
    document.getElementById('sFresh').textContent = `${fresh}/${hospitals.length}`;
    if (config.dataMode === 'demo') {
      document.getElementById('statsNote').textContent = 'Live from the Sehat Setu network · DEMO MODE: hospital figures are simulated for the prototype.';
    }
  } catch {
    document.getElementById('statsNote').textContent = 'Network status unavailable offline – you can still report an emergency.';
  }
}
stats();

try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch { /* file:// */ }
