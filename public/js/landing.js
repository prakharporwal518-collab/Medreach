// Home page: navigation, live system status and live availability.
// Uses only PUBLIC data (hospital status and ambulance fleet) – no patient data.
import { hydrateIcons, esc, icon } from './icons.js';
import { freshness, freshnessLabel } from '/shared/freshness.js';
import { capLabel, SPECIALIST_CAPS, EQUIPMENT_CAPS } from '/shared/capabilities.js';
import { roadKm } from '/shared/predict.js';

// Family tracking links used to point at "/?track=…" – forward them.
if (new URLSearchParams(location.search).get('track')) location.replace(`/report${location.search}`);

hydrateIcons();

const $ = (s) => document.querySelector(s);
const TABS = ['ambulance', 'beds', 'doctors', 'blood', 'equipment'];
const state = { hospitals: [], ambulances: [], config: null, tab: 'beds', q: '', here: null, locNote: '', online: false };

// ---------------------------------------------------------------- header menu (phones)
const menuBtn = $('#menuBtn');
const nav = $('#hdNav');
const closeMenu = () => { nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); };
menuBtn.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
nav.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  closeMenu();
  if (a.getAttribute('href')?.startsWith('#')) {
    for (const x of nav.querySelectorAll('a')) x.removeAttribute('aria-current');
    a.setAttribute('aria-current', 'page');
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------------------------------------------------------------- tabs
function selectTab(tab) {
  if (!TABS.includes(tab)) return;
  state.tab = tab;
  for (const b of document.querySelectorAll('.av-tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  renderAvail();
}
// Every [data-tab] link or button on the page (service strip, cards, tabs) opens that view.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tab]');
  if (el) selectTab(el.dataset.tab);
});
// Arrow keys move between tabs.
$('.av-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const i = TABS.indexOf(state.tab) + (e.key === 'ArrowRight' ? 1 : -1);
  const next = TABS[(i + TABS.length) % TABS.length];
  selectTab(next);
  $(`.av-tabs [data-tab="${next}"]`).focus();
});
// Header links "Hospitals" / "Ambulances" open the matching view.
function fromHash() {
  if (location.hash === '#hospitals') selectTab('beds');
  if (location.hash === '#ambulances') selectTab('ambulance');
}
window.addEventListener('hashchange', fromHash);

$('#avSearch').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderAvail(); });
$('#avNear').addEventListener('click', () => {
  const btn = $('#avNear');
  if (state.here) { state.here = null; btn.innerHTML = `${icon('pin', 'sm')} Nearest first`; renderAvail(); return; }
  if (!('geolocation' in navigator)) { state.locNote = 'Location is not available on this device.'; renderAvail(); return; }
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition((p) => {
    state.here = { lat: p.coords.latitude, lng: p.coords.longitude };
    state.locNote = '';
    btn.disabled = false;
    btn.innerHTML = `${icon('check', 'sm')} Sorted by distance`;
    renderAvail();
  }, () => {
    btn.disabled = false;
    state.locNote = 'Location permission was denied – showing hospitals in the usual order.';
    renderAvail();
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
});

// ---------------------------------------------------------------- helpers
const freeBeds = (h) => Object.values(h.status?.beds || {}).reduce((n, b) => n + (b.free || 0), 0);
const erTag = (h) => {
  const s = h.status?.erStatus;
  return s === 'diverting' ? '<span class="tag bad">ER diverting</span>'
    : s === 'busy' ? '<span class="tag warn">ER busy</span>'
      : '<span class="tag ok">ER open</span>';
};
const km = (h) => (state.here && Number.isFinite(h.lat) ? roadKm(state.here, h) : null);
const fresh = (h) => { const l = freshnessLabel(freshness(h.status?.verifiedAt)); return `<p class="av-fresh">${l.icon} ${esc(l.text)}</p>`; };
const head = (h, tag) => `
  <div class="av-head"><h3>${esc(h.name)}</h3>${tag}</div>
  <p class="area">${esc(h.area || '')}${km(h) !== null ? ` · ~${km(h).toFixed(1)} km` : ''}</p>`;
const row = (label, value) => `<div class="av-row"><span>${label}</span><b>${value}</b></div>`;
const matches = (...fields) => !state.q || fields.some((f) => String(f || '').toLowerCase().includes(state.q));
const sortHospitals = (list, by) => [...list].sort((a, b) => (state.here ? km(a) - km(b) : by(b) - by(a)));
const empty = (text) => `<p class="av-empty">${esc(text)}</p>`;

// ---------------------------------------------------------------- views
const VIEWS = {
  ambulance() {
    const list = state.ambulances.filter((a) => matches(a.id, a.type, a.base));
    const free = state.ambulances.filter((a) => a.available).length;
    const TYPE = { ALS: 'Advanced Life Support', BLS: 'Basic Life Support', JANANI: 'Janani Express (mother & newborn)' };
    return {
      summary: `${free} of ${state.ambulances.length} ambulances free right now`,
      note: state.config?.dataMode === 'demo'
        ? 'Call 108 to request an ambulance. In this prototype the fleet and dispatch are simulated.'
        : 'Call 108 to request an ambulance.',
      html: list.map((a) => `
        <article class="av-card">
          <div class="av-head"><h3>${icon('ambulance', 'sm')} ${esc(a.id)}</h3>${a.available ? '<span class="tag ok">Available</span>' : '<span class="tag warn">On a call</span>'}</div>
          ${row('Type', esc(TYPE[a.type] || a.type))}
          ${row('Base', esc(a.base))}
        </article>`).join('') || empty('No ambulance matches your search.'),
    };
  },
  beds() {
    const list = sortHospitals(state.hospitals.filter((h) => matches(h.name, h.area)), freeBeds);
    const total = state.hospitals.reduce((n, h) => n + freeBeds(h), 0);
    const icu = state.hospitals.reduce((n, h) => n + (h.status?.beds?.icu?.free || 0), 0);
    return {
      summary: `${total} beds free across ${state.hospitals.length} hospitals · ${icu} ICU`,
      note: 'Reported by hospital staff. A bed is only confirmed when the hospital accepts your referral in the emergency flow.',
      html: list.map((h) => {
        const b = h.status?.beds || {};
        const line = (name, x) => (x?.total ? row(name, `${x.free} free / ${x.total}`) : '');
        return `
        <article class="av-card">
          ${head(h, erTag(h))}
          <div class="av-tags"><span class="tag">${h.ownership === 'govt' ? 'Government' : 'Private'}</span>${h.ayushman ? '<span class="tag ok">Ayushman (PM-JAY)</span>' : ''}</div>
          ${line('ICU', b.icu)}${line('Emergency', b.emergency)}${line('Labour', b.labour)}
          ${fresh(h)}
        </article>`;
      }).join('') || empty('No hospital matches your search.'),
    };
  },
  doctors() {
    const onDuty = (h) => (h.status?.onDuty || []).filter((c) => SPECIALIST_CAPS.has(c));
    const list = sortHospitals(state.hospitals.filter((h) => matches(h.name, h.area, ...onDuty(h).map((c) => capLabel(c)))), (h) => onDuty(h).length);
    const docs = state.hospitals.reduce((n, h) => n + onDuty(h).length, 0);
    return {
      summary: `${docs} specialists on duty across ${state.hospitals.length} hospitals`,
      note: 'The duty roster is kept up to date by each hospital’s emergency desk.',
      html: list.map((h) => {
        const on = onDuty(h);
        const off = (h.capabilities || []).filter((c) => SPECIALIST_CAPS.has(c) && !on.includes(c));
        return `
        <article class="av-card">
          ${head(h, erTag(h))}
          ${row('ER doctors on shift', h.status?.erDoctors ?? '–')}
          <div class="av-tags">${on.map((c) => `<span class="tag ok">${esc(capLabel(c))}</span>`).join('') || '<span class="tag">No specialist on duty</span>'}</div>
          ${off.length ? `<div class="av-tags">${off.map((c) => `<span class="tag">${esc(capLabel(c))} · off duty</span>`).join('')}</div>` : ''}
          ${fresh(h)}
        </article>`;
      }).join('') || empty('No hospital matches your search.'),
    };
  },
  blood() {
    const withBank = state.hospitals.filter((h) => (h.capabilities || []).includes('blood_bank'));
    const list = sortHospitals(withBank.filter((h) => matches(h.name, h.area)), (h) => (h.status?.erStatus === 'open' ? 1 : 0));
    return {
      summary: `${withBank.length} hospitals with a blood bank on site`,
      note: 'Stock by blood group is not reported yet – call the hospital’s blood bank to confirm units before travelling.',
      html: list.map((h) => `
        <article class="av-card">
          ${head(h, erTag(h))}
          <div class="av-tags"><span class="tag ok">${icon('drop', 'sm')} Blood bank on site</span>${h.ayushman ? '<span class="tag">Ayushman (PM-JAY)</span>' : ''}</div>
          ${row('Emergency beds free', `${h.status?.beds?.emergency?.free ?? 0}`)}
          ${fresh(h)}
        </article>`).join('') || empty('No hospital matches your search.'),
    };
  },
  equipment() {
    const equip = (h) => (h.capabilities || []).filter((c) => EQUIPMENT_CAPS.has(c));
    const list = sortHospitals(state.hospitals.filter((h) => matches(h.name, h.area, ...equip(h).map((c) => capLabel(c)))), (h) => h.status?.ventilatorsFree || 0);
    const vents = state.hospitals.reduce((n, h) => n + (h.status?.ventilatorsFree || 0), 0);
    const down = state.hospitals.reduce((n, h) => n + (h.status?.equipmentDown || []).length, 0);
    return {
      summary: `${vents} ventilators free · ${down} machine${down === 1 ? '' : 's'} reported down`,
      note: 'Machines reported down are excluded when Medreach matches a hospital in an emergency.',
      html: list.map((h) => {
        const isDown = (c) => (h.status?.equipmentDown || []).includes(c);
        return `
        <article class="av-card">
          ${head(h, erTag(h))}
          ${row('Ventilators free', h.status?.ventilatorsFree ?? 0)}
          <div class="av-tags">${equip(h).map((c) => `<span class="tag ${isDown(c) ? 'bad' : 'ok'}">${esc(capLabel(c))}${isDown(c) ? ' · down' : ''}</span>`).join('') || '<span class="tag">No major equipment listed</span>'}</div>
          ${fresh(h)}
        </article>`;
      }).join('') || empty('No hospital matches your search.'),
    };
  },
};

function renderAvail() {
  const body = $('#avBody');
  $('#avNear').hidden = state.tab === 'ambulance';
  if (!state.online && !state.hospitals.length) {
    body.innerHTML = empty('Live availability needs a network connection. In an emergency you can still report it, or call 108.');
    $('#avSummary').textContent = '';
    return;
  }
  const v = VIEWS[state.tab]();
  $('#avSummary').textContent = v.summary;
  body.innerHTML = v.html;
  $('#avNote').textContent = [state.locNote, v.note].filter(Boolean).join(' ');
}

function renderStatus() {
  const freeAmb = state.ambulances.filter((a) => a.available).length;
  $('#stHosp').textContent = state.hospitals.length || '–';
  $('#stAmb').textContent = state.ambulances.length ? `${freeAmb} / ${state.ambulances.length}` : '–';
  $('#stBeds').textContent = state.hospitals.length ? state.hospitals.reduce((n, h) => n + freeBeds(h), 0) : '–';
  $('#stDocs').textContent = state.hospitals.length
    ? state.hospitals.reduce((n, h) => n + (h.status?.onDuty || []).filter((c) => SPECIALIST_CAPS.has(c)).length, 0) : '–';
  const st = $('#sysState');
  st.classList.toggle('down', !state.online);
  st.lastElementChild.textContent = state.online ? 'All services operational' : 'Offline – you can still report an emergency';
  $('#stNote').textContent = state.config?.dataMode === 'demo'
    ? 'DEMO MODE: hospital figures and the ambulance fleet are simulated for the prototype.' : '';
}

// ---------------------------------------------------------------- data
async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function load() {
  try {
    const [hospitals, ambulances, config] = await Promise.all([getJSON('/api/hospitals'), getJSON('/api/ambulances'), getJSON('/api/config')]);
    Object.assign(state, { hospitals, ambulances, config, online: navigator.onLine !== false });
  } catch {
    state.online = false;
  }
  renderStatus();
  renderAvail();
}

async function refreshAmbulances() {
  if (document.hidden) return;
  try { state.ambulances = await getJSON('/api/ambulances'); renderStatus(); if (state.tab === 'ambulance') renderAvail(); } catch { /* keep the last list */ }
}

// Hospital figures change live (staff updates on the hospital dashboard).
function liveUpdates() {
  if (!('EventSource' in window)) return;
  const es = new EventSource('/api/stream/hospitals');
  es.addEventListener('open', () => { $('#avLive').hidden = false; });
  es.addEventListener('error', () => { $('#avLive').hidden = true; });
  es.addEventListener('status', (e) => {
    try {
      const d = JSON.parse(e.data);
      const h = state.hospitals.find((x) => x.id === d.id);
      if (!h) return;
      h.status = d.status;
      renderStatus();
      if (state.tab !== 'ambulance') renderAvail();
    } catch { /* ignore malformed events */ }
  });
}

window.addEventListener('online', load);
window.addEventListener('offline', () => { state.online = false; renderStatus(); });

await load();
fromHash();
liveUpdates();
setInterval(refreshAmbulances, 30000);

try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch { /* file:// */ }
