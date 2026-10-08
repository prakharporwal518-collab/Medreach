// Medreach – citizen dashboard.
// Reads public hospital status from the API and the citizen's OWN data from
// this device only (profile, health records, contacts, cases). A citizen can
// follow only the cases raised from this device, through the read-only
// tracking token (status, hospital and ETA – never another person's data).
import { icon, esc, initials, greeting, hydrateIcons } from './icons.js';
import * as citizen from './citizen-store.js';
import * as api from './api.js';
import { LiveMap, statusKind, legend } from './livemap.js';
import { roadKm } from '/shared/predict.js';
import { freshness, freshnessLabel, ago } from '/shared/freshness.js';
import { capLabel, SPECIALIST_CAPS } from '/shared/capabilities.js';

const $ = (s, r = document) => r.querySelector(s);
const me = citizen.current();
if (!me) location.replace('/login?role=citizen&next=/citizen');

const DEMO = { lat: 23.2355, lng: 77.4005, label: 'Bhopal, MP' };
const state = {
  view: 'home',
  hospitals: [],
  config: { dataMode: 'demo' },
  loc: (() => { try { return JSON.parse(sessionStorage.getItem('sehat.loc')) || DEMO; } catch { return DEMO; } })(),
  track: new Map(), // caseId -> trackView (or { gone: true })
  trackES: new Map(), // caseId -> live tracking stream (active cases only)
  hosES: null, // live hospital-status stream
  eta0: {}, // first ETA seen per case, to estimate how far along the vehicle is
  caseES: new Map(), // caseId -> owner stream (real ambulance position; needs this tab's case token)
  vpos: new Map(), // caseId -> { lat, lng } live ambulance position
  openCases: new Set(),
  map: null,
  filter: 'all',
  q: '',
};

// ---------------------------------------------------------------- helpers
const minsAgo = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const when = (iso) => ago(minsAgo(iso));
const bedsFree = (h) => Object.values(h.status?.beds || {}).reduce((n, b) => n + (b.free || 0), 0);
const erPill = (h) => {
  const s = h.status?.erStatus;
  return s === 'diverting' ? '<span class="pill red">Full</span>' : s === 'busy' ? '<span class="pill amber">Busy</span>' : '<span class="pill green">Open</span>';
};
function nearby(limitKm = 200) {
  return state.hospitals
    .map((h) => ({ h, km: Math.round(roadKm(state.loc, h) * 10) / 10 }))
    .filter((x) => x.km <= limitKm)
    .sort((a, b) => a.km - b.km);
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}
function statusPill(tv) {
  if (!tv) return '<span class="pill gray">Checking…</span>';
  if (tv.gone) return '<span class="pill gray">Closed</span>';
  return {
    new: '<span class="pill blue">In Progress</span>', requested: '<span class="pill blue">In Progress</span>',
    declined: '<span class="pill amber">Finding hospital</span>', timeout: '<span class="pill amber">Finding hospital</span>',
    accepted: '<span class="pill green">Accepted</span>', enroute: '<span class="pill violet">On the way</span>',
    arrived: '<span class="pill green">Completed</span>',
  }[tv.status] || '<span class="pill gray">–</span>';
}
const cases = () => citizen.profile()?.cases || [];
const activeCases = () => cases().filter((c) => { const t = state.track.get(c.id); return t && !t.gone && !['arrived'].includes(t.status); });

async function refreshTracking() {
  await Promise.all(cases().slice(0, 12).map(async (c) => {
    try { state.track.set(c.id, await api.getTrack(c.id, c.trackToken)); } catch { state.track.set(c.id, { gone: true }); }
  }));
  renderBadges();
  syncTrackStreams();
}

function renderBadges() {
  const n = activeCases().length;
  $('#casesCount').textContent = n;
  $('#casesCount').classList.toggle('hidden', !n);
  $('#bellCount').textContent = n;
  $('#bellCount').classList.toggle('hidden', !n);
}

function destroyMap() { if (state.map) { state.map.destroy(); state.map = null; } }

const statusText = (h) => ({ open: 'Open', busy: 'Busy', full: 'Full – diverting' }[statusKind(h)]);
function hospitalPopup(h) {
  const km = Math.round(roadKm(state.loc, h) * 10) / 10;
  const icu = h.status?.beds?.icu;
  const fl = freshnessLabel(freshness(h.status?.verifiedAt));
  return `<b>${esc(h.name)}</b><br>${statusText(h)} · ${km} km<br>ICU ${icu?.total ? `${icu.free}/${icu.total}` : '–'} · ${bedsFree(h)} beds reported<br><small>${fl.icon} ${esc(fl.text)}</small><br><a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}">Directions →</a>`;
}
function drawHospitalMarker(h, force = false) {
  if (!state.map || (!force && !state.map.markers.has(`h:${h.id}`))) return;
  const icu = h.status?.beds?.icu;
  state.map.set(`h:${h.id}`, h, statusKind(h), { text: icu?.total ? String(icu.free) : '', popup: hospitalPopup(h) });
}

// Where are my patient, my hospital and my vehicle right now? The tracking
// link is status-only, so the vehicle position is estimated from its ETA.
function casePositions(c, tv) {
  const patient = tv.location;
  const hospital = tv.hospital;
  let vehicle = null;
  const t = tv.transport;
  if (t && patient && t.position && (t.mode === 'own' || t.phase)) {
    const amb = t.mode === 'ambulance';
    const where = t.phase === 'to_hospital' || !amb ? `To ${esc(hospital?.name || 'hospital')}` : t.phase === 'at_patient' ? 'With the patient' : 'Coming to you';
    const who = amb ? `Ambulance ${esc(t.ambulance || t.incident?.service || '')}${t.simulated ? ' (simulated)' : ''}` : t.gps ? 'Own vehicle · live GPS' : 'Own vehicle · simulated drive';
    return { patient, hospital, vehicle: { pos: t.position, kind: amb ? 'ambulance' : 'car', path: t.path, nextPath: t.nextPath, toPatient: amb && t.phase === 'to_patient', label: `<b>${who}</b><br>${where} · ~${t.etaMin} min${t.onRoad ? '<br><small>following the road route</small>' : ''}` } };
  }
  const live = state.vpos.get(c.id);
  if (t && patient && live && t.mode === 'ambulance') {
    const where = t.phase === 'to_hospital' ? `To ${esc(hospital?.name || 'hospital')}` : t.phase === 'at_patient' ? 'With the patient' : 'Coming to you';
    vehicle = { pos: live, kind: 'ambulance', label: `<b>Ambulance ${esc(t.ambulance || t.incident?.service || '')}${t.simulated ? ' (simulated)' : ''}</b><br>${where} · ~${t.etaMin} min<br><small>live position</small>` };
  } else if (t && patient) {
    const kind = t.mode === 'ambulance' ? 'ambulance' : 'car';
    const who = t.mode === 'ambulance' ? `Ambulance ${esc(t.ambulance || t.incident?.service || '')}${t.simulated ? ' (simulated)' : ''}` : 'Own vehicle';
    if (t.mode === 'ambulance' && ['requested', 'failed'].includes(t.phase)) {
      vehicle = null; // control room hasn't assigned a unit (or couldn't be reached)
    } else if (t.mode === 'ambulance' && t.phase !== 'to_hospital') {
      vehicle = { pos: patient, kind, label: `<b>${who}</b><br>${t.phase === 'at_patient' ? 'With the patient' : `Coming to you · ~${t.etaMin} min`}` };
    } else if (hospital && Number.isFinite(t.etaMin)) {
      state.eta0[c.id] ??= Math.max(t.etaMin, 1);
      const f = Math.max(0, Math.min(1, 1 - t.etaMin / state.eta0[c.id]));
      vehicle = { pos: { lat: patient.lat + (hospital.lat - patient.lat) * f, lng: patient.lng + (hospital.lng - patient.lng) * f }, kind, label: `<b>${who}</b><br>To ${esc(hospital.name)} · ETA ${t.etaMin} min<br><small>estimated position</small>` };
    }
  }
  return { patient, hospital, vehicle };
}

function drawCaseMarkers() {
  if (!state.map) return;
  const keep = new Set();
  for (const c of cases()) {
    const tv = state.track.get(c.id);
    if (!tv || tv.gone || tv.status === 'arrived') continue;
    const { patient, hospital, vehicle } = casePositions(c, tv);
    if (patient) { state.map.set(`c:p:${c.id}`, patient, 'patient', { text: '!', popup: `<b>${esc(c.label)}</b><br>Case ${esc(c.id)}`, z: 600 }); keep.add(`c:p:${c.id}`); }
    if (hospital) {
      state.map.set(`c:d:${c.id}`, hospital, 'dest', { text: 'H', popup: `<b>${esc(hospital.name)}</b><br>Accepted your referral${tv.bay ? ` · bay ${esc(tv.bay)}` : ''}`, z: 700 });
      if (vehicle?.toPatient) {
        state.map.route(`c:r:${c.id}`, vehicle.path, vehicle.pos, patient, '#f59e0b'); keep.add(`c:r:${c.id}`);
        state.map.route(`c:l:${c.id}`, vehicle.nextPath, patient, hospital, '#0f9488');
      } else state.map.route(`c:l:${c.id}`, vehicle?.path, vehicle?.pos || patient, hospital, '#0f9488');
      keep.add(`c:d:${c.id}`); keep.add(`c:l:${c.id}`);
    }
    if (vehicle) { state.map.set(`c:v:${c.id}`, vehicle.pos, vehicle.kind, { text: vehicle.kind === 'ambulance' ? '🚑' : '🚗', popup: vehicle.label, z: 900 }); keep.add(`c:v:${c.id}`); }
  }
  state.map.prune('c:', keep);
}

function drawMap(el, list) {
  destroyMap();
  if (!window.L || !el) return;
  state.map = new LiveMap(el, state.loc, 12);
  state.map.set('me', state.loc, 'me', { popup: '<b>You are here</b>', z: 500 });
  for (const { h } of list) drawHospitalMarker(h, true);
  drawCaseMarkers();
  state.map.fit();
}

const MAP_LEGEND = legend([['me', 'You'], ['open', 'Open'], ['busy', 'Busy'], ['full', 'Full'], ['patient', 'Your case'], ['ambulance', 'Ambulance'], ['dest', 'Accepted hospital']]);
const liveHead = (title) => `<div class="panel-head"><h3>${title} <span class="live-badge">LIVE</span></h3><span class="small muted liveTime"></span></div>`;
const mapNote = '<p class="small muted" style="margin:.35rem 0 0">Numbers on pins = ICU beds free. Pins change colour the moment a hospital updates its status.</p>';

// ---------------------------------------------------------------- live updates
function stampLive() {
  const t = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  for (const el of document.querySelectorAll('.liveTime')) el.textContent = t;
}

function startHospitalStream() {
  if (state.hosES) return;
  try {
    state.hosES = api.streamHospitals();
    state.hosES.addEventListener('status', (e) => {
      const { id, status } = JSON.parse(e.data);
      const h = state.hospitals.find((x) => x.id === id);
      if (!h) return;
      h.status = status;
      drawHospitalMarker(h);
      stampLive();
    });
  } catch { /* live updates are a bonus */ }
}

function syncTrackStreams() {
  for (const c of cases()) {
    const tv = state.track.get(c.id);
    const active = tv && !tv.gone && tv.status !== 'arrived';
    if (active && !state.trackES.has(c.id)) {
      try {
        const es = api.streamTrack(c.id, c.trackToken);
        es.addEventListener('case', (e) => onTrack(c.id, JSON.parse(e.data)));
        state.trackES.set(c.id, es);
      } catch { /* fall back to polling */ }
    } else if (!active && state.trackES.has(c.id)) {
      state.trackES.get(c.id).close();
      state.trackES.delete(c.id);
    }
    // Real ambulance position, only in the tab that raised the case.
    const tok = active && tv.transport?.mode === 'ambulance' && !state.caseES.has(c.id) ? api.savedCaseToken(c.id) : null;
    if (tok) {
      try {
        const es = api.streamCase(c.id, tok);
        es.addEventListener('ambulance', (e) => {
          const a = JSON.parse(e.data);
          if (a.position) { state.vpos.set(c.id, a.position); drawCaseMarkers(); }
        });
        es.onerror = () => { if (es.readyState === 2) state.caseES.delete(c.id); };
        state.caseES.set(c.id, es);
      } catch { /* estimated position is used instead */ }
    } else if (!active && state.caseES.has(c.id)) {
      state.caseES.get(c.id).close();
      state.caseES.delete(c.id);
      state.vpos.delete(c.id);
    }
  }
}

function onTrack(id, tv) {
  state.track.set(id, tv);
  updateLiveViews();
  syncTrackStreams();
}

// Refresh the parts of the page that change, without redrawing the map.
function updateLiveViews() {
  renderBadges();
  drawCaseMarkers();
  const al = $('#activityList');
  if (al) al.innerHTML = activityItems(4);
  const cp = $('#casesPanel');
  if (cp) cp.innerHTML = casesListHtml();
  stampLive();
}

// ---------------------------------------------------------------- views
function hospitalRow({ h, km }, compact = false) {
  const f = freshness(h.status?.verifiedAt);
  const fl = freshnessLabel(f);
  if (compact) {
    return `
    <div class="h-compact">
      <b>${esc(h.name)} ${erPill(h)}</b>
      <div class="stat-box">Beds<b>${bedsFree(h)}</b></div>
      <small>${km} km · 24×7 Emergency${h.ayushman ? ' · Ayushman ✓' : ''}</small>
      <span class="fresh">${fl.icon} ${esc(fl.text)}</span>
    </div>`;
  }
  return `
    <div class="list-row">
      <span class="l-ico">${icon('hospital')}</span>
      <div class="l-main">
        <b>${esc(h.name)} ${erPill(h)}</b>
        <small>${km} km · 24×7 Emergency${h.ayushman ? ' · Ayushman ✓' : ''}${compact ? '' : ` · ${esc(h.area)}`}</small>
        <div class="fresh">${fl.icon} ${esc(fl.text)}</div>
      </div>
      <div class="stat-box">Beds Available<b>${bedsFree(h)}</b></div>
      <a class="b sm ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}" aria-label="Directions to ${esc(h.name)}">${icon('right', 'sm')}</a>
    </div>`;
}

function activityItems(limit = 4) {
  const out = [];
  for (const c of cases()) {
    const tv = state.track.get(c.id);
    const last = tv?.timeline?.at(-1);
    let title = 'Emergency case submitted';
    let ic = 'siren';
    let tint = 'var(--red-soft);color:var(--red)';
    if (tv?.status === 'accepted') { title = `Hospital bed confirmed – ${tv.hospital?.name || ''}`; ic = 'bed'; tint = 'var(--violet-soft);color:var(--violet)'; }
    if (tv?.status === 'enroute') { title = tv.transport?.mode === 'ambulance' ? `Ambulance assigned – ${tv.transport.ambulance || ''}` : 'On the way to hospital'; ic = 'ambulance'; tint = 'var(--green-soft);color:var(--green)'; }
    if (tv?.status === 'arrived') { title = `Reached ${tv.hospital?.name || 'hospital'}`; ic = 'check'; tint = 'var(--green-soft);color:var(--green)'; }
    out.push(`
      <div class="list-row link" data-open-case="${esc(c.id)}">
        <span class="l-ico" style="background:${tint}">${icon(ic)}</span>
        <div class="l-main"><b>${esc(title)}</b><small>${esc(c.label)} · Case ${esc(c.id)} · ${when(last?.at || c.createdAt)}</small></div>
        ${statusPill(tv)}
      </div>`);
    if (out.length >= limit) break;
  }
  return out.join('') || `<div class="empty-state">No activity yet. Your emergency cases will appear here.<br><button class="b sm danger" data-go="emergency" style="margin-top:.6rem">Report emergency</button></div>`;
}

function completeness() {
  const p = citizen.profile();
  const checks = [Boolean(p.health?.bloodGroup), Boolean(p.health?.age), Boolean((p.health?.allergies || '').length || (p.health?.conditions || '').length), (p.contacts || []).length > 0, Boolean(me.email)];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function viewHome() {
  const near = nearby(25);
  const hour = new Date();
  const icuFree = near.reduce((n, x) => n + (x.h.status?.beds?.icu?.free || 0), 0);
  const beds = near.reduce((n, x) => n + bedsFree(x.h), 0);
  const docs = near.reduce((n, x) => n + (x.h.status?.onDuty?.length || 0), 0);
  const vents = near.reduce((n, x) => n + (x.h.status?.ventilatorsFree || 0), 0);
  const bloodBanks = near.filter((x) => x.h.capabilities.includes('blood_bank')).length;
  const pct = completeness();
  return `
    <div class="row spread page-head">
      <div><h1>${greeting()}, ${esc(me.name.split(' ')[0])} 👋</h1><p>Stay prepared. Help is just a few clicks away.</p></div>
      <span class="pill gray">${icon('calendar', 'sm')} ${hour.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · ${hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>

    <div class="cols home-top">
      <div style="display:flex;flex-direction:column;gap:1rem">
        <div class="hero-card">
          <span class="h-ico">${icon('shield')}</span>
          <div class="grow"><b>In case of emergency, report immediately</b><p class="small muted" style="margin:.2rem 0 .6rem">Get connected to a hospital that can treat you now, and an ambulance.</p>
            <div class="row"><button class="b teal" data-go="emergency">${icon('mic', 'sm')} Tap &amp; speak</button><button class="b danger" data-go="alone">🆘 I'm alone</button></div></div>
        </div>
        <button class="action red" data-go="emergency"><span class="a-ico">${icon('mic', 'lg')}</span><span><b>Report Emergency</b><small>Speak or type – get a hospital to accept you</small></span><span class="chev">${icon('right')}</span></button>
        <button class="action blue" data-go="hospitals"><span class="a-ico">${icon('hospital', 'lg')}</span><span><b>Find Nearby Hospitals</b><small>Check beds, facilities &amp; directions</small></span><span class="chev">${icon('right')}</span></button>
        <button class="action green" data-go="ambulance"><span class="a-ico">${icon('ambulance', 'lg')}</span><span><b>Request Ambulance</b><small>108 &amp; ambulance request</small></span><span class="chev">${icon('right')}</span></button>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Quick Access</h3></div>
        <div class="list">
          <div class="list-row link" data-go="cases"><span class="l-ico">${icon('file')}</span><div class="l-main"><b>My Cases</b><small>View your reported cases</small></div>${icon('right', 'sm')}</div>
          <div class="list-row link" data-go="records"><span class="l-ico">${icon('records')}</span><div class="l-main"><b>Health Records</b><small>Blood group, allergies, conditions</small></div>${icon('right', 'sm')}</div>
          <div class="list-row link" data-go="contacts"><span class="l-ico">${icon('users')}</span><div class="l-main"><b>Emergency Contacts</b><small>Save and manage contacts</small></div>${icon('right', 'sm')}</div>
          <div class="list-row link" data-go="help"><span class="l-ico">${icon('help')}</span><div class="l-main"><b>Help &amp; Support</b><small>How Medreach works</small></div>${icon('right', 'sm')}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>Nearby Hospitals</h3><button class="link" data-go="hospitals">View all ${icon('arrow', 'sm')}</button></div>
        <div class="list">${near.slice(0, 4).map((x) => hospitalRow(x, true)).join('') || '<p class="empty-state">No hospitals found nearby.</p>'}</div>
      </div>
    </div>

    <div class="cols c4">
      <div class="res-tile"><span class="r-ico" style="background:var(--red-soft);color:var(--red)">${icon('ambulance', 'lg')}</span><b>Ambulance</b><span class="pill red">108 · 24×7 free</span></div>
      <div class="res-tile"><span class="r-ico" style="background:var(--primary-soft);color:var(--primary)">${icon('bed', 'lg')}</span><b>Hospital Beds Nearby</b><span class="pill blue">${beds} reported · ${icuFree} ICU</span></div>
      <div class="res-tile"><span class="r-ico" style="background:var(--violet-soft);color:var(--violet)">${icon('stethoscope', 'lg')}</span><b>Doctors On Call</b><span class="pill violet">${docs} specialists on duty</span></div>
      <div class="res-tile"><span class="r-ico" style="background:var(--green-soft);color:var(--green)">${icon('drop', 'lg')}</span><b>Other Resources</b><span class="pill green">${vents} ventilators · ${bloodBanks} blood banks</span></div>
    </div>

    <div class="cols c3">
      <div class="panel">
        <div class="panel-head"><h3>Recent Activity</h3><button class="link" data-go="cases">View all ${icon('arrow', 'sm')}</button></div>
        <div class="list" id="activityList">${activityItems(4)}</div>
      </div>
      <div class="panel">
        ${liveHead('Live Emergency Map')}
        <div class="map-box" id="homeMap"></div>
        ${MAP_LEGEND}
      </div>
      <div style="display:flex;flex-direction:column;gap:1rem">
        <div class="panel">
          <h3>Need help?</h3>
          <p class="small muted">Learn how Medreach works, or call 108 for life-threatening emergencies.</p>
          <div class="row"><button class="b" data-go="help">${icon('help', 'sm')} Help &amp; Support</button><a class="b danger" href="tel:108">${icon('phone', 'sm')} 108</a></div>
        </div>
        <div class="panel" style="background:var(--primary-soft)">
          <div class="row" style="align-items:flex-start;flex-wrap:nowrap"><span class="l-ico" style="background:#fff;color:var(--red);width:42px;height:42px;border-radius:12px;display:grid;place-items:center">${icon('records')}</span>
          <div class="grow"><b>Stay prepared</b><p class="small muted" style="margin:.1rem 0 .5rem">Keep your emergency contacts and medical details updated. Profile ${pct}% complete.</p>
          <div class="bar"><i class="blue" style="width:${pct}%"></i></div>
          <button class="b sm soft" data-go="records" style="margin-top:.6rem">Update health records</button></div></div>
        </div>
      </div>
    </div>`;
}

function casesListHtml() {
  const list = cases();
  return `
      <div class="panel-head"><h3>${list.length} case${list.length === 1 ? '' : 's'}</h3><button class="link" id="refreshCases">${icon('refresh', 'sm')} Refresh</button></div>
      ${list.length ? list.map((c) => {
        const tv = state.track.get(c.id);
        return `
          <details class="faq" data-case="${esc(c.id)}" ${state.openCases.has(c.id) ? 'open' : ''}>
            <summary class="row spread"><span class="row"><span style="font-size:1.3rem">${esc(c.icon || '🚑')}</span><span><b>${esc(c.label)}</b><br><small class="muted">Case ${esc(c.id)} · ${when(c.createdAt)} · <span class="sev-${esc(c.severity)}">${esc(c.severity || '')}</span></small></span></span>${statusPill(tv)}</summary>
            ${tv && !tv.gone ? `
              <div class="cols c2" style="margin-top:.7rem">
                <div>
                  ${tv.hospital ? `<p>${icon('hospital', 'sm')} <b>${esc(tv.hospital.name)}</b> · ${esc(tv.hospital.area)}${tv.bay ? ` · Bay ${esc(tv.bay)}` : ''}</p>` : '<p class="muted">Hospital not confirmed yet.</p>'}
                  ${tv.transport ? `<p>${icon('ambulance', 'sm')} ${tv.transport.mode === 'ambulance' ? `Ambulance ${esc(tv.transport.ambulance || tv.transport.incident?.service || '')}${tv.transport.simulated ? ' (simulated)' : ''}${tv.transport.incident?.id ? ` · incident ${esc(tv.transport.incident.id)}` : ''}` : 'Own vehicle'}${tv.transport.etaMin !== undefined ? ` · ETA ${tv.transport.etaMin} min` : ''}</p>` : ''}
                  <a class="b sm" href="/report?track=${encodeURIComponent(c.id)}&t=${encodeURIComponent(c.trackToken)}">${icon('eye', 'sm')} Open live tracking</a>
                </div>
                <ul class="small" style="margin:0;padding-left:1.1rem">${tv.timeline.slice(-6).reverse().map((e) => `<li><span class="muted">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> ${esc(e.text)}</li>`).join('')}</ul>
              </div>` : `<p class="small muted" style="margin-top:.6rem">${tv?.gone ? 'This case is closed or no longer available on the server (details are deleted after the retention period).' : 'Loading…'}</p>`}
          </details>`;
      }).join('') : `<div class="empty-state">No cases yet.<br><button class="b danger" data-go="emergency" style="margin-top:.7rem">${icon('siren', 'sm')} Report an emergency</button></div>`}`;
}

function viewCases() {
  return `
    <div class="page-head"><h1>My Cases</h1><p>Emergencies raised from this device. Only this device can see them.</p></div>
    <div class="panel">
      ${liveHead('Live case map')}
      <div class="map-box tall" id="casesMap"></div>
      ${MAP_LEGEND}
      <p class="small muted" style="margin:.35rem 0 0">Your location, the hospital that accepted you and your ambulance / vehicle – updated live while a case is active.</p>
    </div>
    <div class="panel" id="casesPanel">${casesListHtml()}</div>`;
}

const FILTERS = [
  ['all', 'All'], ['govt', 'Government'], ['ayushman', 'Ayushman'], ['icu', 'ICU bed free'],
  ['cardiology', 'Cardiologist'], ['trauma', 'Trauma'], ['obstetrics', 'Maternity'], ['pediatrics', 'Children'],
];
function filtered() {
  const q = state.q.trim().toLowerCase();
  return nearby().filter(({ h }) => {
    if (q && !`${h.name} ${h.area}`.toLowerCase().includes(q)) return false;
    switch (state.filter) {
      case 'govt': return h.ownership === 'govt';
      case 'ayushman': return h.ayushman;
      case 'icu': return (h.status?.beds?.icu?.free || 0) > 0;
      case 'all': return true;
      default: return h.capabilities.includes(state.filter) && (!SPECIALIST_CAPS.has(state.filter) || h.status?.onDuty?.includes(state.filter));
    }
  });
}

function viewHospitals() {
  const list = filtered();
  return `
    <div class="page-head"><h1>Nearby Hospitals</h1><p>Reported by each hospital's authorised staff. Reported capacity is not a guarantee: in an emergency, <a href="#emergency">report it</a> so a hospital accepts you before you travel.</p></div>
    <div class="panel">
      <div class="row" style="margin-bottom:.8rem">
        <span class="input grow" style="max-width:360px">${icon('search', 'sm')}<input id="hq" placeholder="Search hospital or area" value="${esc(state.q)}"></span>
        ${FILTERS.map(([k, l]) => `<button class="chip-t" data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join('')}
      </div>
      <div class="map-box" id="hospMap" style="height:320px"></div>
      ${MAP_LEGEND}${mapNote}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>${list.length} hospital${list.length === 1 ? '' : 's'}</h3><span class="small muted">sorted by distance</span></div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>Hospital</th><th>Distance</th><th>Emergency</th><th>ICU free</th><th>ER beds</th><th>Specialists on duty</th><th>Verified</th><th></th></tr></thead>
        <tbody>${list.map(({ h, km }) => {
          const fl = freshnessLabel(freshness(h.status?.verifiedAt));
          const b = h.status?.beds || {};
          return `<tr>
            <td><b>${esc(h.name)}</b><br><small class="muted">${esc(h.area)} · ${h.ownership === 'govt' ? 'Govt' : 'Private'}${h.ayushman ? ' · Ayushman ✓' : ''}</small></td>
            <td>${km} km</td><td>${erPill(h)}</td>
            <td>${b.icu?.total ? `${b.icu.free}/${b.icu.total}` : '–'}</td>
            <td>${b.emergency?.total ? `${b.emergency.free}/${b.emergency.total}` : '–'}</td>
            <td class="small">${(h.status?.onDuty || []).map((c) => esc(capLabel(c))).join(', ') || '–'}</td>
            <td class="small">${fl.icon} ${esc(fl.text)}</td>
            <td><a class="b sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}">${icon('nav', 'sm')} Directions</a></td>
          </tr>`;
        }).join('')}</tbody></table></div>
    </div>`;
}

function viewAmbulance() {
  return `
    <div class="page-head"><h1>Ambulance</h1><p>Get an ambulance the fastest way.</p></div>
    <div class="cols c21">
      <div class="panel">
        <div class="row" style="flex-wrap:nowrap;align-items:center;gap:1.2rem">
          <img src="/img/ambulance.svg" alt="" style="width:220px;max-width:40%">
          <div><h2>Life-threatening emergency?</h2><p class="muted">Call 108 – free, 24×7 government ambulance service. Janani Express is available for pregnancy.</p>
          <div class="row"><a class="b danger lg" href="tel:108">${icon('phone')} Call 108 now</a><button class="b lg" data-go="emergency">${icon('siren')} Request through Medreach</button></div></div>
        </div>
      </div>
      <div class="panel">
        <h3>How an ambulance request works</h3>
        <ol class="small" style="padding-left:1.1rem;line-height:1.8">
          <li>Report the emergency (voice or text)</li>
          <li>A suitable hospital accepts you first</li>
          <li>Choose <b>Request ambulance</b></li>
          <li>Track the ambulance live; your family gets a link</li>
        </ol>
        <p class="note-box small">Prototype: ambulance dispatch is <b>simulated</b>. In deployment the request is handed to the authorised 108 control room – Medreach does not control 108 itself.</p>
      </div>
    </div>
    <div class="panel">
      ${liveHead('Live ambulance map')}
      <div class="map-box tall" id="ambMap"></div>
      ${MAP_LEGEND}
      <p class="small muted" style="margin:.35rem 0 0">${activeCases().some((c) => state.track.get(c.id)?.transport?.mode === 'ambulance') ? 'Your ambulance is shown live (estimated position from its ETA).' : 'No ambulance on its way for you right now – nearby hospitals are shown. Once you request one, it appears here live.'}</p>
    </div>`;
}

function viewRecords() {
  const h = citizen.profile().health || {};
  const opt = (v, list) => list.map((x) => `<option ${v === x ? 'selected' : ''}>${x}</option>`).join('');
  return `
    <div class="page-head"><h1>Health Records</h1><p>Kept only on this device. Shared with a hospital only when you raise an emergency <b>and</b> tick consent.</p></div>
    <div class="cols c21">
      <form class="panel" id="recForm">
        <div class="grid-2">
          <label class="field"><span>Blood group</span><span class="input"><select name="bloodGroup"><option value="">–</option>${opt(h.bloodGroup, ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])}</select></span></label>
          <label class="field"><span>Age</span><span class="input"><input name="age" inputmode="numeric" value="${esc(h.age ?? '')}"></span></label>
          <label class="field"><span>Gender</span><span class="input"><select name="gender"><option value="">–</option>${opt(h.gender, ['Female', 'Male', 'Other'])}</select></span></label>
          <label class="field"><span>ABHA number</span><span class="input"><input name="abhaId" value="${esc(h.abhaId ?? '')}" placeholder="91-XXXX-XXXX-XXXX"></span></label>
          <label class="field"><span>Ayushman card ID</span><span class="input"><input name="ayushmanId" value="${esc(h.ayushmanId ?? '')}"></span></label>
          <label class="field"><span>Known conditions</span><span class="input"><input name="conditions" value="${esc([].concat(h.conditions || []).join(', '))}" placeholder="e.g. diabetes, hypertension"></span></label>
        </div>
        <label class="field"><span>Allergies</span><span class="input"><input name="allergies" value="${esc([].concat(h.allergies || []).join(', '))}" placeholder="e.g. penicillin"></span></label>
        <label class="field"><span>Regular medicines</span><span class="input"><input name="medicines" value="${esc([].concat(h.medicines || []).join(', '))}" placeholder="e.g. metformin 500 mg"></span></label>
        <div class="row"><button class="b primary" type="submit">${icon('check', 'sm')} Save records</button>
          <label class="b soft" style="cursor:pointer">${icon('scan', 'sm')} Scan health card<input type="file" accept="image/*" id="recScan" hidden></label>
          <span class="small muted" id="scanStatus"></span></div>
      </form>
      <div class="panel">
        <h3>${icon('lock', 'sm')} Your privacy</h3>
        <ul class="small" style="padding-left:1.1rem;line-height:1.8">
          <li>Stored on this phone only – not on our server</li>
          <li>Pre-filled in an emergency, sent only with your consent</li>
          <li>Hospitals see ID numbers masked (••••1203)</li>
          <li>Card scans are read on the phone; the image is never uploaded</li>
        </ul>
      </div>
    </div>`;
}

function viewContacts() {
  const list = citizen.profile().contacts || [];
  return `
    <div class="page-head"><h1>Emergency Contacts</h1><p>Your first contact is notified with a live tracking link when you raise an emergency (status only, no medical details).</p></div>
    <div class="cols c21">
      <div class="panel">
        <div class="panel-head"><h3>${list.length} contact${list.length === 1 ? '' : 's'}</h3></div>
        <div class="list">${list.map((c, i) => `
          <div class="list-row"><span class="avatar" style="width:40px;height:40px">${esc(initials(c.name))}</span>
            <div class="l-main"><b>${esc(c.name)} ${i === 0 ? '<span class="pill green">Primary · used by I\'m alone</span>' : ''}</b><small>${esc(c.relation || 'Contact')} · ••••••${esc(String(c.phone).slice(-4))}</small></div>
            ${i ? `<button class="b sm" data-primary="${i}">Make primary</button>` : ''}
            <button class="b sm ghost" data-remove="${i}" aria-label="Remove ${esc(c.name)}">${icon('trash', 'sm')}</button>
          </div>`).join('') || '<p class="empty-state">No contacts yet – add a family member or neighbour.</p>'}</div>
      </div>
      <form class="panel" id="contactForm">
        <h3>Add contact</h3>
        <label class="field"><span>Name <b>*</b></span><span class="input"><input name="name" required></span></label>
        <label class="field"><span>Relation</span><span class="input"><input name="relation" placeholder="e.g. Son, Neighbour"></span></label>
        <label class="field"><span>Mobile <b>*</b></span><span class="input"><input name="phone" inputmode="tel" required></span></label>
        <button class="b primary block" type="submit">${icon('plus', 'sm')} Add contact</button>
      </form>
    </div>`;
}

function viewProfile() {
  const lang = (() => { try { return JSON.parse(localStorage.getItem('sehat.lang')); } catch { return null; } })() || 'en';
  return `
    <div class="page-head"><h1>Profile</h1><p>Your citizen account on this device.</p></div>
    <div class="cols c21">
      <form class="panel" id="profileForm">
        <div class="row" style="margin-bottom:1rem"><span class="avatar" style="width:64px;height:64px;font-size:1.3rem">${esc(initials(me.name))}</span><div><h2 style="margin:0">${esc(me.name)}</h2><span class="muted small">Citizen · member since ${new Date(me.createdAt).toLocaleDateString()}</span><br><span class="pill green">${icon('shield', 'sm')} Verified with ${esc(me.verifiedWith || 'Aadhaar OTP')}</span></div></div>
        <div class="grid-2">
          <label class="field"><span>Full name (from Aadhaar)</span><span class="input"><input value="${esc(me.name)}" disabled></span></label>
          <label class="field"><span>Email</span><span class="input"><input name="email" type="email" value="${esc(me.email || '')}"></span></label>
          <label class="field"><span>Aadhaar</span><span class="input"><input value="${esc(me.maskedAadhaar || '')}" disabled></span></label>
          <label class="field"><span>Aadhaar-linked mobile</span><span class="input"><input value="${esc(me.maskedMobile || '')}" disabled></span></label>
          <label class="field"><span>App language</span><span class="input"><select name="lang"><option value="en" ${lang === 'en' ? 'selected' : ''}>English</option><option value="hi" ${lang === 'hi' ? 'selected' : ''}>हिंदी</option></select></span></label>
        </div>
        <button class="b primary" type="submit">Save profile</button>
      </form>
      <div class="panel">
        <h3>${icon('lock', 'sm')} Privacy &amp; data</h3>
        <p class="small muted">Your Aadhaar number is never stored: this device keeps only <b>${esc(me.maskedAadhaar || 'XXXX XXXX ····')}</b> and a signed sign-in token.</p>
        <p class="small muted">Your citizen portal is completely separate from the hospital staff portal. Hospitals never see this profile; they only see what you share, with consent, when you raise an emergency.</p>
        <button class="b" id="signOut2">${icon('logout', 'sm')} Sign out</button>
        <button class="b danger" id="deleteAll" style="margin-top:.6rem">${icon('trash', 'sm')} Delete all my data from this device</button>
      </div>
    </div>`;
}

function viewHelp() {
  const faq = [
    ['Do I need to log in during an emergency?', 'No. Tap “Report Emergency” on the home page – it works without an account. Logging in only pre-fills your health details and contacts.'],
    ['How does Medreach choose a hospital?', 'AI understands your description and works out what care is needed. A transparent rule-based engine then picks hospitals that have that service live now, using figures verified by hospital staff. The hospital must accept before you travel.'],
    ['Is the bed count guaranteed?', 'No – it is “reported capacity” with the time it was verified. Only an accepted referral with a receiving bay is a confirmed destination.'],
    ['Can hospitals see my health records?', 'Only if you tick consent when raising an emergency, and only the hospital your referral goes to. ID numbers are masked.'],
    ['What does “I’m alone” do?', 'One tap shares your location, notifies your primary contact, requests a hospital and then an ambulance automatically.'],
    ['Does Medreach send the 108 ambulance?', 'In this prototype the ambulance is simulated. In deployment the request is handed to the authorised 108 control room. You can always call 108 directly.'],
  ];
  return `
    <div class="page-head"><h1>Help &amp; Support</h1><p>Answers to common questions.</p></div>
    <div class="cols c21">
      <div class="panel">${faq.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p class="small muted" style="margin-top:.4rem">${esc(a)}</p></details>`).join('')}</div>
      <div class="panel">
        <h3>Emergency numbers</h3>
        <div class="list">
          <a class="list-row link" href="tel:108"><span class="l-ico" style="background:var(--red-soft);color:var(--red)">${icon('ambulance')}</span><div class="l-main"><b>108</b><small>Ambulance – free, 24×7</small></div></a>
          <a class="list-row link" href="tel:112"><span class="l-ico">${icon('phone')}</span><div class="l-main"><b>112</b><small>National emergency number</small></div></a>
        </div>
        <a class="b block" href="/#privacy" style="margin-top:.8rem">${icon('shield', 'sm')} How we protect your data</a>
      </div>
    </div>`;
}

// The emergency app (voice → AI → hospital → acceptance → ambulance) runs
// inside the dashboard, so the citizen never leaves their portal.
function viewEmergency() {
  const hash = state.alone ? '#alone' : '';
  return `
    <div class="row spread page-head">
      <div><h1>${icon('mic', 'lg')} Emergency App</h1><p>Tap the red mic and speak in Hindi or English – or type. AI understands, finds a hospital that can treat you now and gets it to accept you. Your saved health details are pre-filled (shared only if you tick consent).</p></div>
      <div class="row"><a class="b" href="/report${hash}" target="_blank" rel="noopener">${icon('arrow', 'sm')} Open full screen</a><a class="b danger" href="tel:108">${icon('phone', 'sm')} 108</a></div>
    </div>
    <div class="app-frame"><iframe id="appFrame" title="Medreach emergency app" src="/report?embed=1${hash}" allow="geolocation; microphone; camera"></iframe></div>`;
}

const VIEWS = { emergency: viewEmergency, home: viewHome, cases: viewCases, hospitals: viewHospitals, ambulance: viewAmbulance, records: viewRecords, contacts: viewContacts, profile: viewProfile, help: viewHelp };

function render() {
  destroyMap();
  $('#view').innerHTML = VIEWS[state.view]();
  for (const b of document.querySelectorAll('.nav-item[data-view]')) {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  bindView();
}

function go(view) {
  state.alone = view === 'alone';
  if (state.alone) view = 'emergency';
  if (!VIEWS[view]) view = 'home';
  state.view = view;
  history.replaceState(null, '', `#${view}`);
  $('#side').classList.remove('open');
  render();
  window.scrollTo({ top: 0 });
}

function bindView() {
  if (state.view === 'home') drawMap($('#homeMap'), nearby(25).slice(0, 8));
  if (state.view === 'cases') drawMap($('#casesMap'), nearby(25).slice(0, 6));
  if (state.view === 'ambulance') drawMap($('#ambMap'), nearby(25).slice(0, 10));
  if (['home', 'cases', 'ambulance', 'hospitals'].includes(state.view)) stampLive();
  if (state.view === 'hospitals') {
    drawMap($('#hospMap'), filtered().slice(0, 16));
    $('#hq').oninput = (e) => { state.q = e.target.value; clearTimeout(bindView.t); bindView.t = setTimeout(() => { render(); const i = $('#hq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => { state.filter = b.dataset.filter; render(); };
  }
  if (state.view === 'records') {
    $('#recForm').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
      citizen.saveProfile({ health: { ...f, age: f.age ? Number(f.age) || undefined : undefined, conditions: list(f.conditions), allergies: list(f.allergies), medicines: list(f.medicines) } });
      toast('Health records saved on this device');
    };
    $('#recScan').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('#scanStatus').textContent = 'Reading card on your phone…';
      try {
        const [{ fileToDataUrl }, { scanHealthDocument }] = await Promise.all([import('./vision.js'), import('./ocr.js')]);
        const { fields } = await scanHealthDocument(await fileToDataUrl(file, 1600), (p) => { $('#scanStatus').textContent = `Reading… ${Math.round(p * 100)}%`; });
        const cur = citizen.profile().health || {};
        const merged = { ...cur };
        for (const k of ['bloodGroup', 'age', 'gender', 'abhaId', 'ayushmanId']) if (fields[k]) merged[k] = fields[k];
        for (const k of ['conditions', 'allergies', 'medicines']) if (fields[k]?.length) merged[k] = fields[k];
        citizen.saveProfile({ health: merged });
        render();
        toast(`Found ${fields.fieldsFound} details – please check and save`);
      } catch (err) { $('#scanStatus').textContent = err.message; }
    };
  }
  if (state.view === 'contacts') {
    $('#contactForm').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (citizen.normalisePhone(f.phone).length !== 10) { toast('Enter a valid 10-digit mobile number'); return; }
      citizen.saveProfile({ contacts: [...(citizen.profile().contacts || []), { name: f.name.trim(), relation: f.relation.trim(), phone: citizen.normalisePhone(f.phone) }] });
      render();
      toast('Contact saved');
    };
    for (const b of document.querySelectorAll('[data-remove]')) b.onclick = () => { const c = [...citizen.profile().contacts]; c.splice(Number(b.dataset.remove), 1); citizen.saveProfile({ contacts: c }); render(); };
    for (const b of document.querySelectorAll('[data-primary]')) b.onclick = () => { const c = [...citizen.profile().contacts]; const [x] = c.splice(Number(b.dataset.primary), 1); citizen.saveProfile({ contacts: [x, ...c] }); render(); };
  }
  if (state.view === 'profile') {
    $('#profileForm').onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      Object.assign(me, citizen.updateAccount({ email: f.email }));
      try { localStorage.setItem('sehat.lang', JSON.stringify(f.lang)); } catch { /* ignore */ }
      renderUser();
      toast('Profile saved');
    };
    $('#signOut2').onclick = signOut;
    $('#deleteAll').onclick = () => {
      if (!confirm('Delete your account, health records, contacts and case list from this device? This cannot be undone.')) return;
      citizen.deleteEverything();
      location.replace('/');
    };
  }
}

function renderUser() {
  $('#userName').textContent = me.name;
  $('#avatar').textContent = initials(me.name);
}

function signOut() {
  citizen.signOut();
  location.replace('/login?role=citizen');
}

function renderBell() {
  const items = [];
  for (const c of cases()) {
    const tv = state.track.get(c.id);
    for (const e of (tv?.timeline || []).slice(-2).reverse()) items.push({ at: e.at, text: e.text, id: c.id });
  }
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  $('#bellMenu').innerHTML = `<p class="note">Updates on your cases</p>${items.slice(0, 6).map((i) => `<button data-open-case="${esc(i.id)}">${icon('bell', 'sm')}<span><b class="small">${esc(i.text)}</b><br><small class="muted">${when(i.at)}</small></span></button>`).join('') || '<p class="note">No notifications yet.</p>'}`;
}

// ---------------------------------------------------------------- boot
async function boot() {
  if (!me) return;
  hydrateIcons();
  renderUser();
  $('#locLabel').textContent = state.loc.label || 'Your location';
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  for (const b of document.querySelectorAll('.nav-item[data-view]')) b.onclick = () => go(b.dataset.view);
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); $('#userMenu').classList.add('hidden'); go(g.dataset.go); return; }
    if (e.target.closest('#refreshCases')) { refreshTracking().then(updateLiveViews); return; }
    const oc = e.target.closest('[data-open-case]');
    if (oc) { $('#bellMenu').classList.add('hidden'); state.openCases.add(oc.dataset.openCase); go('cases'); return; }
    if (!e.target.closest('#userBtn, #userMenu')) $('#userMenu').classList.add('hidden');
    if (!e.target.closest('#bellBtn, #bellMenu')) $('#bellMenu').classList.add('hidden');
  });
  $('#userBtn').onclick = () => $('#userMenu').classList.toggle('hidden');
  document.addEventListener('toggle', (e) => {
    const id = e.target.dataset?.case;
    if (id) { if (e.target.open) state.openCases.add(id); else state.openCases.delete(id); }
  }, true);
  $('#bellBtn').onclick = () => { renderBell(); $('#bellMenu').classList.toggle('hidden'); };
  $('#logoutBtn').onclick = signOut;
  $('#locBtn').onclick = () => {
    if (!('geolocation' in navigator)) return toast('Location not available');
    navigator.geolocation.getCurrentPosition((p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (roadKm(pos, DEMO) > 160) { toast('You are outside the covered region – showing Bhopal (demo)'); return; }
      state.loc = { ...pos, label: 'Your location' };
      try { sessionStorage.setItem('sehat.loc', JSON.stringify(state.loc)); } catch { /* ignore */ }
      $('#locLabel').textContent = state.loc.label;
      if (state.view !== 'emergency') render(); // don't reload a running emergency
    }, () => toast('Location permission denied – showing Bhopal (demo)'));
  };

  const [hospitals, config] = await Promise.all([api.hospitals(), api.getConfig()]);
  state.hospitals = hospitals;
  state.config = config;
  if (config.dataMode !== 'live') $('#demoStrip').classList.remove('hidden');
  const start = location.hash.slice(1);
  if (start === 'welcome') toast(`Welcome, ${me.name.split(' ')[0]}! Add your health records and an emergency contact to be ready.`);
  go(VIEWS[start] || start === 'alone' ? start : 'home');
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if ((VIEWS[v] || v === 'alone') && v !== state.view) go(v); });
  // A case raised inside the embedded emergency app updates My Cases right away.
  window.addEventListener('storage', async (e) => { if (e.key?.startsWith('medreach.citizen.profile.')) { await refreshTracking(); updateLiveViews(); } });
  startHospitalStream();
  await refreshTracking();
  updateLiveViews();
  // Fallback polling in case a live stream drops.
  setInterval(async () => { if (cases().length) { await refreshTracking(); updateLiveViews(); } }, 20000);
}
boot();
