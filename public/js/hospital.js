// Medreach – hospital staff dashboard (authorised staff only).
//
//   Session: Hospital ID + Staff ID + OTP (server) → bound to ONE hospital, kept per tab
//   Roles:   Nodal Officer · Emergency Desk · Resource Manager · State Admin (read-only)
//   Privacy: staff see only referrals addressed to their hospital; patient identity
//            only with family consent, IDs masked – enforced by the server.
import { icon, esc, initials, hydrateIcons } from './icons.js';
import { capLabel, checkCapability, SPECIALIST_CAPS, EQUIPMENT_CAPS } from '/shared/capabilities.js';
import { freshness, freshnessLabel, ago } from '/shared/freshness.js';
import { ROLES } from '/shared/roles.js';
import { roadKm } from '/shared/predict.js';
import { LiveMap, statusKind, legend } from './livemap.js';

const $ = (s, r = document) => r.querySelector(s);
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('sehat.staff')); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('sehat.staff', JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { sessionStorage.removeItem('sehat.staff'); } catch { /* ignore */ } },
};

const state = {
  auth: null, hospital: null, hospitals: [], cases: new Map(), amb: new Map(), es: null,
  config: { dataMode: 'demo' }, forecast: [], audit: [], view: 'dashboard', caseTab: 'pending',
  sound: true, map: null, modalMap: null, pubES: null, lastEvent: null,
};
const canDo = (p) => Boolean(state.auth?.permissions?.includes(p));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.auth ? { Authorization: `Bearer ${state.auth.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401 && state.auth) { logout(); throw new Error('Session expired – please sign in again'); }
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4000);
}

function beep() {
  if (!state.sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.2);
    });
  } catch { /* audio blocked until user interacts */ }
}

// ---------------------------------------------------------------- auth
async function demoLogin(hospitalId, role = 'ED01') {
  if (state.auth?.staff.hospitalId === hospitalId) return true;
  if (state.auth) await logout({ stay: true });
  const staffId = hospitalId === 'MP-STATE' ? 'MP-ADMIN-01' : `${hospitalId.toUpperCase()}-${role}`;
  const otp = await api('/api/auth/otp', { method: 'POST', body: { hospitalId, staffId } });
  if (!otp.demoOtp) return false;
  const out = await api('/api/auth/verify', { method: 'POST', body: { hospitalId, staffId, otp: otp.demoOtp } });
  state.auth = out;
  session.set(out);
  await enter();
  return true;
}

async function logout({ stay = false } = {}) {
  const token = state.auth?.token;
  state.auth = null;
  session.clear();
  state.es?.close();
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  if (!stay) showGate();
}
// Used by the single-file demo to sign the console in as the receiving hospital's desk.
window.sehatConsole = { demoLogin, logout: () => logout({ stay: false }) };

function showGate() {
  $('#app').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  if (state.config.dataMode === 'demo') {
    $('#demoGate').classList.remove('hidden');
    $('#gateHospital').innerHTML = [...state.hospitals.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`), '<option value="MP-STATE">State Health Control Room (admin)</option>'].join('');
    const roles = () => ($('#gateHospital').value === 'MP-STATE'
      ? [['ADMIN', 'State Health Admin']]
      : [['ED01', 'Emergency Desk'], ['RM01', 'Resource Manager'], ['NO01', 'Nodal Officer']]);
    const draw = () => { $('#gateRoles').innerHTML = roles().map(([k, l]) => `<button class="chip-t" data-role="${k}">${l}</button>`).join(''); };
    $('#gateHospital').onchange = draw;
    draw();
    $('#gateRoles').onclick = async (e) => {
      const b = e.target.closest('[data-role]');
      if (!b) return;
      try { await demoLogin($('#gateHospital').value, b.dataset.role); } catch (err) { toast(err.message); }
    };
  }
}

async function enter() {
  const { staff } = state.auth;
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userName').textContent = staff.name;
  $('#userRole').textContent = staff.roleLabel;
  $('#avatar').textContent = initials(staff.name);
  $('#sessionNote').innerHTML = `Signed in as <b>${esc(staff.staffId)}</b> · session ends ${new Date(state.auth.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('#navAudit').classList.toggle('hidden', !canDo('audit.view'));
  const admin = staff.role === 'admin';
  $('#adminPick').classList.toggle('hidden', !admin);
  $('#hospPill').classList.toggle('hidden', admin);
  if (admin) {
    $('#adminHospital').innerHTML = state.hospitals.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join('');
    $('#adminHospital').onchange = (e) => load(e.target.value);
  }
  await load(admin ? ($('#adminHospital').value || state.hospitals[0].id) : staff.hospitalId);
}

// ---------------------------------------------------------------- data
async function load(id) {
  const data = await api(`/api/hospitals/${id}/dashboard`);
  state.hospital = data.hospital;
  state.cases = new Map(data.cases.map((c) => [c.id, c]));
  state.forecast = data.forecast;
  state.amb.clear();
  $('#hospName').textContent = state.hospital.name;
  await loadAudit();
  connect();
  go(location.hash.slice(1) || state.view);
}

async function loadAudit() {
  if (!canDo('audit.view')) { state.audit = []; return; }
  try { state.audit = await api(`/api/hospitals/${state.hospital.id}/audit`); } catch { state.audit = []; }
}

async function patchStatus(patch) {
  try {
    state.hospital = await api(`/api/hospitals/${state.hospital.id}/status`, { method: 'PATCH', body: patch });
    await loadAudit();
    render();
    toast(Object.keys(patch).length ? 'Status updated · citizens see it immediately' : 'Figures confirmed as current');
  } catch (err) { toast(err.message); }
}

async function respond(id, accept) {
  const body = accept
    ? { accept: true, bay: $(`#bay-${id}`)?.value.trim() || $('#mBay')?.value.trim() || '' }
    : { accept: false, reason: prompt('Reason for declining (shared with the family):', 'No bed available') || 'Unable to admit' };
  try {
    const c = await api(`/api/hospitals/${state.hospital.id}/cases/${id}/respond`, { method: 'POST', body });
    state.cases.set(c.id, c);
    $('#caseModal').open && $('#caseModal').close();
    await loadAudit();
    render();
    toast(accept ? `Referral ${c.id} accepted – bay ${c.bay}` : `Referral ${c.id} declined`);
  } catch (err) { toast(err.message); }
}

function connect() {
  state.es?.close();
  const es = new EventSource(`/api/stream/hospital/${state.hospital.id}?token=${encodeURIComponent(state.auth.token)}`);
  state.es = es;
  const live = (ok) => {
    $('#liveDot').className = `dot ${ok ? 'green' : 'amber'}`;
    $('#liveText').textContent = ok ? 'Hospital Online' : 'Reconnecting…';
  };
  es.onopen = () => live(true);
  es.onerror = () => live(false);
  const touch = () => { state.lastEvent = new Date(); $('#lastUpdated').textContent = `Last updated ${state.lastEvent.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; };
  touch();
  es.addEventListener('request', (e) => {
    const c = JSON.parse(e.data);
    state.cases.set(c.id, c);
    touch();
    beep();
    toast(`🚨 New ${c.triage.severity} referral: ${c.triage.label} · ETA ${c.etaMin ?? '?'} min`);
    if (state.sound && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(`New ${c.triage.severity} referral. ${c.triage.label}. E T A ${c.etaMin} minutes.`));
    softRender();
  });
  es.addEventListener('case', (e) => { const c = JSON.parse(e.data); state.cases.set(c.id, c); touch(); softRender(); });
  es.addEventListener('ambulance', (e) => { const a = JSON.parse(e.data); state.amb.set(a.caseId, a); touch(); updateLive(); });
  es.addEventListener('position', (e) => {
    const p = JSON.parse(e.data);
    const c = state.cases.get(p.caseId);
    if (c?.transport) { c.transport.etaMin = p.etaMin; c.transport.position = { lat: p.lat, lng: p.lng }; touch(); updateLive(); }
  });
  es.addEventListener('status', (e) => { state.hospital.status = JSON.parse(e.data).status; touch(); softRender(); });
  es.addEventListener('audit', async () => { await loadAudit(); softRender(); });

  // Public status of neighbouring hospitals, for the live map.
  state.pubES?.close();
  try {
    state.pubES = new EventSource('/api/stream/hospitals');
    state.pubES.addEventListener('status', (e) => {
      const { id, status } = JSON.parse(e.data);
      const h = state.hospitals.find((x) => x.id === id);
      if (!h || id === state.hospital.id) return;
      h.status = status;
      if (state.map?.markers.has(`h:${id}`)) drawNeighbour(h);
    });
  } catch { /* optional */ }
}

// Ambulance / vehicle movement: move markers and update ETA cells in place.
function updateLive() {
  drawIncoming(state.map);
  drawIncoming(state.modalMap, state.modalCase);
  for (const el of document.querySelectorAll('[data-eta]')) {
    const c = state.cases.get(el.dataset.eta);
    if (c) el.textContent = `${eta(c) ?? '–'} min`;
  }
  for (const el of document.querySelectorAll('[data-tp]')) {
    const c = state.cases.get(el.dataset.tp);
    if (c) el.textContent = transportText(c);
  }
}

// Don't wipe what staff are typing (e.g. a bay number) when live updates arrive.
function softRender() {
  renderBadges();
  const a = document.activeElement;
  if (a && $('#view').contains(a) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return;
  clearTimeout(softRender.t);
  softRender.t = setTimeout(render, 150);
}

// ---------------------------------------------------------------- view helpers
const list = () => [...state.cases.values()].filter((c) => c.hospitalId === state.hospital.id)
  .sort((a, b) => Date.parse(b.requests.at(-1)?.at || b.createdAt) - Date.parse(a.requests.at(-1)?.at || a.createdAt));
const pending = () => list().filter((c) => c.status === 'requested');
const active = () => list().filter((c) => ['accepted', 'enroute'].includes(c.status));

function prio(sev) {
  return sev === 'critical' ? '<span class="pill red">Critical</span>' : sev === 'serious' ? '<span class="pill amber">High</span>' : '<span class="pill blue">Medium</span>';
}
function statusPill(c) {
  return {
    requested: '<span class="pill amber">Awaiting response</span>', accepted: '<span class="pill green">Accepted</span>',
    enroute: '<span class="pill blue">On the way</span>', arrived: '<span class="pill green">Arrived · handed over</span>',
    declined: '<span class="pill gray">Declined</span>', timeout: '<span class="pill gray">Timed out</span>',
  }[c.status] || `<span class="pill gray">${esc(c.status)}</span>`;
}
function patientName(c) {
  const p = c.patient || {};
  if (p.name) return esc(p.name);
  return c.consent?.patientDetails ? 'Not provided' : '<span class="muted">🔒 Not shared</span>';
}
function patientLine(c) {
  const p = c.patient || {};
  const bits = [p.name, p.age ? `${p.age}y` : c.triage.patient?.age ? `${c.triage.patient.age}y` : null, p.gender, p.bloodGroup ? `Blood ${p.bloodGroup}` : null].filter(Boolean);
  return bits.length ? bits.map(esc).join(' · ') : c.consent?.patientDetails ? 'Details not available' : '🔒 Family did not consent to share patient details';
}
const reqTime = (c) => new Date(c.requests.at(-1)?.at || c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const eta = (c) => state.amb.get(c.id)?.etaMin ?? c.transport?.etaMin ?? c.etaMin;

function bedStats() {
  const b = state.hospital.status.beds;
  const total = Object.values(b).reduce((n, x) => n + x.total, 0);
  const free = Object.values(b).reduce((n, x) => n + x.free, 0);
  return { b, total, free };
}

function verifiedBanner() {
  const s = state.hospital.status;
  const f = freshness(s.verifiedAt);
  const l = freshnessLabel(f);
  const by = s.source === 'dashboard' && s.verifiedBy ? `${esc(s.verifiedBy.roleLabel)}${s.verifiedBy.name ? ` (${esc(s.verifiedBy.name)})` : ''}` : 'Simulated demo seed';
  const when = s.verifiedAt ? new Date(s.verifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  return `
    <div class="panel" style="padding:.8rem 1rem;border-left:4px solid var(--${f.level === 'fresh' ? 'green' : f.level === 'aging' ? 'amber' : 'red'})">
      <div class="row spread">
        <div class="small"><b>${l.icon} ${esc(l.text)}</b> · Updated by: ${by} · Time: ${when} · Source: ${s.source === 'dashboard' ? 'Hospital Emergency Dashboard' : 'Simulated demo data'}
          <br><span class="muted">Citizens see this freshness. After 60 min without confirmation the app shows “availability unverified”.</span></div>
        <div class="row">
          <button class="b sm teal" data-act="verify" ${canDo('status.verify') ? '' : 'disabled'}>${icon('check', 'sm')} Confirm figures are current</button>
          <button class="b sm" data-go="beds">${icon('bed', 'sm')} Update beds</button>
        </div>
      </div>
    </div>`;
}

function kpis() {
  const { b, total, free } = bedStats();
  const s = state.hospital.status;
  const tile = (cls, ic, label, value, sub) => `<div class="kpi ${cls}"><span class="kpi-ico">${icon(ic, 'lg')}</span><div><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div></div>`;
  return `<div class="cols c5">
    ${tile('red', 'bed', 'Total Beds', total, `${total - free} occupied | ${free} available`)}
    ${tile('blue', 'activity', 'ICU Beds', b.icu.total, `${b.icu.total - b.icu.free} occupied | ${b.icu.free} available`)}
    ${tile('green', 'wind', 'Ventilators', s.ventilatorsFree ?? 0, 'free right now')}
    ${tile('violet', 'siren', 'Emergency Beds', b.emergency.total, `${b.emergency.total - b.emergency.free} occupied | ${b.emergency.free} available`)}
    ${tile('amber', 'file', 'Referrals Today', list().length, `${pending().length} awaiting response`)}
  </div>`;
}

function casesTable(rows) {
  if (!rows.length) return `<div class="empty-state">No referrals yet. When a citizen requests this hospital, it appears here instantly.</div>`;
  return `<div class="table-wrap"><table class="t">
    <thead><tr><th>Time</th><th>Patient</th><th>Issue</th><th>Priority</th><th>ETA</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows.map((c) => `<tr>
      <td>${reqTime(c)}</td><td>${patientName(c)}</td><td>${esc(c.triage.icon)} ${esc(c.triage.label)}</td><td>${prio(c.triage.severity)}</td>
      <td data-eta="${esc(c.id)}">${eta(c) ?? '–'} min</td><td>${statusPill(c)}</td>
      <td><button class="b sm ${c.status === 'requested' ? 'primary' : ''}" data-view-case="${esc(c.id)}">${c.status === 'requested' ? 'Review' : 'View'}</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function resourceStatus() {
  const s = state.hospital.status;
  const row = (ic, label, free, total, cls) => `
    <div class="list-row"><span class="l-ico" style="background:var(--${cls}-soft);color:var(--${cls === 'primary' ? 'primary' : cls})">${icon(ic)}</span>
      <div class="l-main"><b>${label}</b><small>${total !== null ? `${total - free} in use of ${total}` : 'reported by staff'}</small></div>
      <span class="pill ${free > 0 ? 'green' : 'red'}">${free}${total !== null ? ` / ${total}` : ''} free</span></div>`;
  return `
    <div class="list">
      ${row('activity', 'ICU beds', s.beds.icu.free, s.beds.icu.total, 'primary')}
      ${row('siren', 'Emergency beds', s.beds.emergency.free, s.beds.emergency.total, 'red')}
      ${s.beds.labour.total ? row('users', 'Labour beds', s.beds.labour.free, s.beds.labour.total, 'violet') : ''}
      ${state.hospital.capabilities.includes('ventilator') ? row('wind', 'Ventilators', s.ventilatorsFree ?? 0, null, 'green') : ''}
      <div class="list-row"><span class="l-ico" style="background:var(--amber-soft);color:var(--amber)">${icon('clock')}</span><div class="l-main"><b>Patients waiting in ER</b><small>ER status: ${esc(s.erStatus)}</small></div><span class="pill ${s.erStatus === 'open' ? 'green' : s.erStatus === 'busy' ? 'amber' : 'red'}">${s.erQueue} waiting</span></div>
    </div>`;
}

function bedBars() {
  const b = state.hospital.status.beds;
  const bar = (label, x) => {
    if (!x.total) return '';
    const used = x.total - x.free;
    const pct = Math.round((used / x.total) * 100);
    return `<div class="bar-row"><span>${label}</span><div class="bar"><i class="${pct >= 90 ? 'red' : pct >= 70 ? 'amber' : ''}" style="width:${pct}%"></i></div><span class="small">${used} / ${x.total}</span></div>`;
  };
  return `${bar('ICU', b.icu)}${bar('Emergency', b.emergency)}${bar('Labour', b.labour)}<p class="small muted" style="margin-top:.6rem">Occupied / total · green &lt; 70% · amber 70–90% · red ≥ 90%</p>`;
}

function recentActivity(limit = 6) {
  const items = [];
  if (state.audit.length) {
    for (const r of state.audit.slice(0, limit)) items.push({ at: r.at, title: `${r.action.replace('.', ' · ')}${r.result ? ` – ${r.result}` : ''}`, who: r.name || r.staffId || 'system' });
  } else {
    for (const c of list()) for (const e of c.timeline.slice(-2)) items.push({ at: e.at, title: e.text, who: c.id });
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  return items.slice(0, limit).map((i) => `
    <div class="list-row"><span class="l-ico">${icon('activity')}</span><div class="l-main"><b class="small">${esc(i.title)}</b><small>${esc(i.who)} · ${new Date(i.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div></div>`).join('')
    || '<div class="empty-state">No activity yet.</div>';
}

function forecastChart() {
  const f = state.forecast;
  if (!f.length) return '';
  const max = Math.max(...f.map((x) => x.expected), 1);
  const peak = f.reduce((a, b) => (b.expected > a.expected ? b : a));
  return `
    <div class="chart" role="img" aria-label="Predicted emergency arrivals for the next 8 hours">${f.map((x) => `
      <div class="col"><span class="tip">${String(x.hour).padStart(2, '0')}:00 · ${x.expected} expected arrivals</span>
        <div class="barv" style="height:${Math.max(3, (x.expected / max) * 100)}%">${x === peak || x === f[0] ? `<span class="val">${x.expected}</span>` : ''}</div></div>`).join('')}</div>
    <div class="chart-x">${f.map((x) => `<span>${String(x.hour).padStart(2, '0')}h</span>`).join('')}</div>
    <details class="small" style="margin-top:.5rem"><summary>Table view</summary><table class="t"><tr><th>Hour</th><th>Expected arrivals</th></tr>${f.map((x) => `<tr><td>${String(x.hour).padStart(2, '0')}:00</td><td>${x.expected}</td></tr>`).join('')}</table></details>`;
}

// ---------------------------------------------------------------- views
function viewDashboard() {
  const now = new Date();
  const s = state.auth.staff;
  return `
    <div class="row spread page-head">
      <div><h1>Welcome, ${esc(s.name)}</h1><p>Here's what's happening at ${esc(state.hospital.name)} today · ${esc(s.roleLabel)}</p></div>
      <div style="text-align:right"><b>${now.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</b><br><span class="muted">${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    </div>
    ${verifiedBanner()}
    ${kpis()}
    <div class="cols c21">
      <div class="panel">
        <div class="panel-head"><h3>${icon('siren', 'sm')} Emergency Cases ${pending().length ? `<span class="pill red">${pending().length} new</span>` : ''}</h3><button class="link" data-go="cases">View all ${icon('arrow', 'sm')}</button></div>
        ${casesTable(list().slice(0, 6))}
        <p class="lock-note" style="margin-top:.7rem">${icon('lock', 'sm')} Patient identity is visible only if the family consented; ABHA / Ayushman numbers are masked. You only see referrals sent to this hospital.</p>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Live Resource Status</h3><button class="link" data-go="beds">Manage ${icon('arrow', 'sm')}</button></div>
        ${resourceStatus()}
      </div>
    </div>
    <div class="cols c3">
      <div class="panel"><div class="panel-head"><h3>Bed Availability</h3><button class="link" data-go="beds">View all ${icon('arrow', 'sm')}</button></div>${bedBars()}
        <div class="panel-head" style="margin-top:1rem"><h3>Quick Actions</h3></div>
        <div class="cols c2" style="gap:.5rem">
          <button class="b sm" data-go="beds">${icon('bed', 'sm')} Update bed status</button>
          <button class="b sm" data-go="staff">${icon('stethoscope', 'sm')} Doctors on duty</button>
          <button class="b sm" data-go="resources">${icon('box', 'sm')} Equipment</button>
          <button class="b sm" data-go="reports">${icon('chart', 'sm')} View reports</button>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Live Map <span class="live-badge">LIVE</span></h3><button class="link" data-go="queue">Queue ${icon('arrow', 'sm')}</button></div><div class="map-box" id="hMap"></div>
        ${MAP_LEGEND}</div>
      <div class="panel"><div class="panel-head"><h3>Recent Activity</h3>${canDo('audit.view') ? `<button class="link" data-go="audit">Audit log ${icon('arrow', 'sm')}</button>` : ''}</div><div class="list">${recentActivity()}</div></div>
    </div>`;
}

function caseCard(c) {
  const tr = c.triage;
  const p = c.patient || {};
  const respondOk = canDo('referral.respond');
  const amb = state.amb.get(c.id);
  return `
    <div class="panel" style="border-left:5px solid var(--${tr.severity === 'critical' ? 'red' : tr.severity === 'serious' ? 'amber' : 'primary'})">
      <div class="row spread"><div class="row"><span style="font-size:1.4rem">${esc(tr.icon)}</span><b>${esc(tr.label)}</b>${prio(tr.severity)}${statusPill(c)}</div><span class="small muted">${esc(c.id)} · ${reqTime(c)}</span></div>
      <p class="small" style="margin:.5rem 0">${patientLine(c)}${p.abhaId ? ` · ABHA ${esc(p.abhaId)}` : ''}${p.ayushmanId ? ` · Ayushman ${esc(p.ayushmanId)}` : ''}${c.alone ? ' · <b class="sev-critical">🆘 patient is ALONE</b>' : ''}</p>
      ${p.allergies?.length ? `<p class="small sev-critical"><b>Allergies:</b> ${p.allergies.map(esc).join(', ')}</p>` : ''}
      <div class="row small"><span class="pill gray">ETA ${eta(c) ?? '?'} min</span><span class="pill gray">${esc((c.bedType || 'er').toUpperCase())} bed</span>
        <span class="pill gray">${c.transport ? (c.transport.mode === 'ambulance' ? `🚑 ${esc(c.transport.ambulance.id)} (simulated)${amb ? ` · ${esc(amb.phase.replace('_', ' '))}` : ''}` : '🚗 own vehicle') : 'transport: deciding'}</span>
        ${c.handover ? `<span class="pill violet">note: ${c.handover.engine === 'claude' ? 'Claude AI' : 'template'}</span>` : ''}</div>
      ${c.handover ? `<pre class="sbar">${esc(c.handover.text)}</pre>` : ''}
      <p class="small muted">Needs: ${tr.required.map((x) => esc(capLabel(x))).join(', ')}</p>
      ${c.status === 'requested' ? `
        <div class="row">
          <span class="input grow" style="max-width:280px">${icon('bed', 'sm')}<input id="bay-${esc(c.id)}" placeholder="Receiving bay, e.g. Resus-02" ${respondOk ? '' : 'disabled'}></span>
          <button class="b primary" data-accept="${esc(c.id)}" ${respondOk ? '' : 'disabled'}>${icon('check', 'sm')} Accept referral</button>
          <button class="b" data-decline="${esc(c.id)}" ${respondOk ? '' : 'disabled'}>Decline</button>
        </div>${respondOk ? '' : '<p class="small muted">Your role cannot respond to referrals.</p>'}`
      : c.acceptedBy ? `<p class="small">Accepted by <b>${esc(c.acceptedBy.roleLabel)}</b>${c.acceptedBy.name && c.acceptedBy.role !== 'simulated' ? ` (${esc(c.acceptedBy.name)})` : ''} · bay <b>${esc(c.bay)}</b></p>` : ''}
    </div>`;
}

function viewCases() {
  const tabs = [['pending', `Awaiting response (${pending().length})`], ['active', `Accepted & on the way (${active().length})`], ['all', `All (${list().length})`]];
  const rows = state.caseTab === 'pending' ? pending() : state.caseTab === 'active' ? active() : list();
  return `
    <div class="page-head"><h1>Emergency Cases</h1><p>Referral requests sent to ${esc(state.hospital.name)} – with the AI pre-arrival (SBAR) note.</p></div>
    <div class="panel"><div class="panel-head"><h3>Where the patients are <span class="live-badge">LIVE</span></h3></div>
      <div class="map-box" id="cMap"></div>${MAP_LEGEND}</div>
    <div class="row">${tabs.map(([k, l]) => `<button class="chip-t" data-tab="${k}" aria-pressed="${state.caseTab === k}">${l}</button>`).join('')}</div>
    ${rows.length ? rows.map(caseCard).join('') : '<div class="panel empty-state">Nothing here right now.</div>'}
    <p class="lock-note">${icon('lock', 'sm')} Hospital-specific access: a referral disappears from this list if the family's request moves to another hospital.</p>`;
}

function viewQueue() {
  const rows = active();
  const done = list().filter((c) => c.status === 'arrived');
  return `
    <div class="page-head"><h1>Patient Queue</h1><p>Accepted patients on their way, with live ETA.</p></div>
    <div class="panel"><div class="panel-head"><h3>Live map · incoming patients <span class="live-badge">LIVE</span></h3></div>
      <div class="map-box tall" id="qMap"></div>${MAP_LEGEND}
      <p class="small muted" style="margin:.35rem 0 0">Ambulances move live on the map. Patient pick-up points are rounded to about 100 m for privacy.</p></div>
    <div class="panel"><div class="panel-head"><h3>On the way (${rows.length})</h3></div>
      ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Case</th><th>Patient</th><th>Issue</th><th>Priority</th><th>Bay</th><th>Transport</th><th>ETA</th></tr></thead><tbody>
        ${rows.map((c) => `<tr><td>${esc(c.id)}</td><td>${patientName(c)}</td><td>${esc(c.triage.label)}</td><td>${prio(c.triage.severity)}</td><td><b>${esc(c.bay || '–')}</b></td>
          <td data-tp="${esc(c.id)}">${esc(transportText(c))}</td><td><b data-eta="${esc(c.id)}">${eta(c) ?? '–'} min</b></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">No patients on the way.</div>'}
    </div>
    <div class="panel"><div class="panel-head"><h3>Arrived & handed over (${done.length})</h3></div>${casesTable(done)}</div>`;
}

function counter(key, label, value, max, ok) {
  return `<div class="counter"><div class="label">${label}</div><div class="row spread"><span class="value">${value}${max !== undefined ? `<span class="small muted"> / ${max}</span>` : ''}</span>
    <span class="stepper-btns"><button data-k="${key}" data-d="-1" aria-label="decrease ${label}" ${ok ? '' : 'disabled'}>−</button><button data-k="${key}" data-d="1" aria-label="increase ${label}" ${ok ? '' : 'disabled'}>+</button></span></div></div>`;
}

function viewBeds() {
  const s = state.hospital.status;
  const bedsOk = canDo('status.beds');
  return `
    <div class="page-head"><h1>Bed Management</h1><p>These exact numbers are what citizens and the matching engine see.</p></div>
    ${verifiedBanner()}
    <div class="cols c21">
      <div class="panel">
        <div class="panel-head"><h3>Beds free now</h3>${bedsOk ? '' : '<span class="pill gray">Read-only for your role</span>'}</div>
        <div class="cols c3" style="gap:.7rem">
          ${Object.entries(s.beds).filter(([, b]) => b.total > 0).map(([t, b]) => counter(`bed:${t}`, `${t.toUpperCase()} beds free`, b.free, b.total, bedsOk)).join('')}
          ${counter('erQueue', 'Patients waiting in ER', s.erQueue, undefined, canDo('status.er'))}
          ${state.hospital.capabilities.includes('ventilator') ? counter('ventilatorsFree', 'Ventilators free', s.ventilatorsFree ?? 0, undefined, canDo('status.equipment')) : ''}
        </div>
      </div>
      <div class="panel">
        <h3>Emergency department</h3>
        <label class="field"><span>Status</span><span class="input"><select id="erStatus" ${canDo('status.er') ? '' : 'disabled'}>
          <option value="open" ${s.erStatus === 'open' ? 'selected' : ''}>🟢 Open – accepting</option>
          <option value="busy" ${s.erStatus === 'busy' ? 'selected' : ''}>🟠 Busy – accepting critical only</option>
          <option value="diverting" ${s.erStatus === 'diverting' ? 'selected' : ''}>🔴 Diverting – full</option></select></span></label>
        <p class="small muted">“Diverting” removes this hospital from citizens' options immediately.</p>
        <div class="panel-head" style="margin-top:1rem"><h3>Occupancy</h3></div>${bedBars()}
      </div>
    </div>`;
}

function viewStaff() {
  const s = state.hospital.status;
  const ok = canDo('status.duty');
  const specialists = state.hospital.capabilities.filter((c) => SPECIALIST_CAPS.has(c));
  return `
    <div class="page-head"><h1>Doctors &amp; Staff</h1><p>Specialists on duty decide which emergencies this hospital can receive right now.</p></div>
    <div class="cols c21">
      <div class="panel">
        <div class="panel-head"><h3>Specialists on duty now</h3>${ok ? '' : '<span class="pill gray">Read-only for your role</span>'}</div>
        <div class="row">${specialists.map((c) => `<button class="chip-t" data-duty="${c}" aria-pressed="${s.onDuty.includes(c)}" ${ok ? '' : 'disabled'}>${s.onDuty.includes(c) ? '✓' : '✗'} ${esc(capLabel(c))}</button>`).join('') || '<span class="muted">No specialist services registered.</span>'}</div>
        <p class="small muted" style="margin-top:.8rem">Turning a specialist off stops routing of patients who need them (e.g. no cardiologist → no heart-attack referrals).</p>
      </div>
      <div class="panel">
        <h3>Staff roles &amp; permissions</h3>
        <table class="t">${Object.entries(ROLES).map(([k, r]) => `<tr><td><b>${esc(r.label)}</b>${k === state.auth.staff.role ? ' <span class="pill blue">you</span>' : ''}</td><td class="small muted">${r.can.map((x) => esc(x)).join(', ')}</td></tr>`).join('')}</table>
      </div>
    </div>`;
}

function viewResources() {
  const s = state.hospital.status;
  const ok = canDo('status.equipment');
  const equipment = state.hospital.capabilities.filter((c) => EQUIPMENT_CAPS.has(c) && c !== 'ventilator');
  return `
    <div class="page-head"><h1>Resources</h1><p>Equipment and services – what this hospital can treat right now.</p></div>
    <div class="cols c2">
      <div class="panel">
        <div class="panel-head"><h3>Equipment working</h3>${ok ? '' : '<span class="pill gray">Read-only for your role</span>'}</div>
        <div class="row">${equipment.map((c) => { const up = !s.equipmentDown.includes(c); return `<button class="chip-t" data-equip="${c}" aria-pressed="${up}" ${ok ? '' : 'disabled'}>${up ? '✓' : '⚠️'} ${esc(capLabel(c))}</button>`; }).join('') || '<span class="muted">No equipment registered.</span>'}</div>
        <p class="small muted" style="margin-top:.8rem">Marking a machine down (e.g. CT scan) stops routing of patients who need it.</p>
      </div>
      <div class="panel">
        <h3>Service capability (live)</h3>
        <div class="row">${state.hospital.capabilities.map((c) => { const k = checkCapability(state.hospital, c); return `<span class="pill ${k.live ? 'green' : 'amber'}">${k.live ? '✓' : '⏸'} ${esc(capLabel(c))}</span>`; }).join('')}</div>
      </div>
    </div>`;
}

function viewReports() {
  const all = list();
  const count = (st) => all.filter((c) => c.status === st).length;
  const crit = all.filter((c) => c.triage.severity === 'critical').length;
  return `
    <div class="page-head"><h1>Reports</h1><p>Referral statistics and predicted demand.</p></div>
    <div class="cols c4">
      <div class="kpi blue"><span class="kpi-ico">${icon('file', 'lg')}</span><div><div class="label">Referrals received</div><div class="value">${all.length}</div></div></div>
      <div class="kpi green"><span class="kpi-ico">${icon('check', 'lg')}</span><div><div class="label">Accepted / arrived</div><div class="value">${count('accepted') + count('enroute') + count('arrived')}</div></div></div>
      <div class="kpi amber"><span class="kpi-ico">${icon('clock', 'lg')}</span><div><div class="label">Awaiting response</div><div class="value">${count('requested')}</div></div></div>
      <div class="kpi red"><span class="kpi-ico">${icon('siren', 'lg')}</span><div><div class="label">Critical cases</div><div class="value">${crit}</div></div></div>
    </div>
    <div class="cols c2">
      <div class="panel"><div class="panel-head"><h3>Predicted ER arrivals · next 8 hours</h3></div><p class="small muted">Poisson model on the hour-of-day pattern – plan staffing ahead.</p>${forecastChart()}</div>
      <div class="panel"><div class="panel-head"><h3>Cases by priority</h3></div>
        ${['critical', 'serious', 'moderate'].map((sv) => { const n = all.filter((c) => c.triage.severity === sv).length; const pct = all.length ? Math.round((n / all.length) * 100) : 0; return `<div class="bar-row"><span>${sv === 'serious' ? 'High' : sv === 'critical' ? 'Critical' : 'Medium'}</span><div class="bar"><i class="${sv === 'critical' ? 'red' : sv === 'serious' ? 'amber' : 'blue'}" style="width:${pct}%"></i></div><span class="small">${n}</span></div>`; }).join('')}
      </div>
    </div>`;
}

function viewAudit() {
  if (!canDo('audit.view')) return '<div class="panel empty-state">🔒 Only the Nodal Officer and State Admin can view the audit log.</div>';
  return `
    <div class="page-head"><h1>Audit Log</h1><p>Who did what, when – logins, status changes, referral decisions and denied access attempts.</p></div>
    <div class="panel"><div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th>Who</th><th>Role</th><th>Action</th><th>Details</th></tr></thead><tbody>
      ${state.audit.slice(0, 150).map((r) => `<tr><td class="small">${new Date(r.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' })}</td><td>${esc(r.name || r.staffId || 'system')}</td><td class="small muted">${esc(r.roleLabel || '')}</td><td><span class="pill ${/denied|failed/.test(r.action) ? 'red' : /accepted|success|verified/.test(r.action) ? 'green' : 'gray'}">${esc(r.action)}</span></td><td class="small">${esc(r.result || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No entries yet.</td></tr>'}
    </tbody></table></div></div>`;
}

function viewProfile() {
  const s = state.auth.staff;
  return `
    <div class="page-head"><h1>Profile</h1><p>Your staff identity and what you are allowed to do.</p></div>
    <div class="cols c2">
      <div class="panel">
        <div class="row" style="margin-bottom:1rem"><span class="avatar" style="width:64px;height:64px;font-size:1.3rem">${esc(initials(s.name))}</span><div><h2 style="margin:0">${esc(s.name)}</h2><span class="pill blue">${esc(s.roleLabel)}</span></div></div>
        <table class="t">
          <tr><td class="muted">Staff ID</td><td><b>${esc(s.staffId)}</b></td></tr>
          <tr><td class="muted">Hospital</td><td>${esc(s.hospitalId === 'MP-STATE' ? 'State Health Control Room' : state.hospital.name)}</td></tr>
          <tr><td class="muted">Session expires</td><td>${new Date(state.auth.expiresAt).toLocaleString()}</td></tr>
        </table>
      </div>
      <div class="panel"><h3>Your permissions</h3><div class="row">${(state.auth.permissions || []).map((p) => `<span class="pill green">✓ ${esc(p)}</span>`).join('')}</div>
        <p class="small muted" style="margin-top:.8rem">Permissions are enforced by the server. Actions outside your role are refused and recorded in the audit log.</p></div>
    </div>`;
}

function viewSettings() {
  return `
    <div class="page-head"><h1>Settings</h1><p>Console preferences for this device.</p></div>
    <div class="cols c2">
      <div class="panel">
        <h3>Alerts</h3>
        <label class="row"><input type="checkbox" id="soundToggle" ${state.sound ? 'checked' : ''}> Sound &amp; voice alert for new referrals</label>
        <p class="small muted">Browsers need one click on the page before sounds can play.</p>
      </div>
      <div class="panel">
        <h3>Session &amp; privacy</h3>
        <p class="small muted">Your session is kept only in this browser tab and ends when you log out or close the tab. Citizen accounts on this device are completely separate and invisible to this portal.</p>
        <button class="b danger" id="logout2">${icon('logout', 'sm')} Log out</button>
      </div>
    </div>`;
}

const VIEWS = { dashboard: viewDashboard, cases: viewCases, queue: viewQueue, beds: viewBeds, staff: viewStaff, resources: viewResources, reports: viewReports, audit: viewAudit, profile: viewProfile, settings: viewSettings };

function renderBadges() {
  const n = pending().length;
  for (const el of [$('#pendingCount'), $('#bellCount')]) { el.textContent = n; el.classList.toggle('hidden', !n); }
}

function render() {
  if (!state.hospital) return;
  if (state.map) { state.map.destroy(); state.map = null; }
  $('#view').innerHTML = VIEWS[state.view]();
  for (const b of document.querySelectorAll('.nav-item[data-view]')) {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  renderBadges();
  if (state.view === 'dashboard') drawMap('#hMap');
  if (state.view === 'queue') drawMap('#qMap');
  if (state.view === 'cases') drawMap('#cMap');
  if (state.view === 'beds') $('#erStatus').onchange = (e) => patchStatus({ erStatus: e.target.value });
  if (state.view === 'settings') {
    $('#soundToggle').onchange = (e) => { state.sound = e.target.checked; };
    $('#logout2').onclick = () => logout();
  }
}

const MAP_LEGEND = legend([['self', 'This hospital'], ['open', 'Open'], ['busy', 'Busy'], ['full', 'Full'], ['patient', 'Patient pick-up'], ['ambulance', 'Ambulance'], ['car', 'Own vehicle']]);

function transportText(c) {
  if (!c.transport) return 'deciding';
  if (c.transport.mode !== 'ambulance') return '🚗 own vehicle';
  const a = state.amb.get(c.id);
  return `🚑 ${c.transport.ambulance.id}${a ? ` · ${a.phase.replace('_', ' ')}` : ''}`;
}

function drawNeighbour(h) {
  const icu = h.status?.beds?.icu;
  state.map?.set(`h:${h.id}`, h, statusKind(h), {
    text: icu?.total ? String(icu.free) : '',
    popup: `<b>${esc(h.name)}</b><br>${esc(h.status?.erStatus || '')} · ICU ${icu?.total ? `${icu.free}/${icu.total}` : '–'}`,
  });
}

// Patients heading here: pick-up point, live vehicle position and route line.
function drawIncoming(lm, only = null) {
  if (!lm) return;
  const keep = new Set();
  for (const c of [...pending(), ...active()]) {
    if (only && c.id !== only) continue;
    const name = c.patient?.name ? esc(c.patient.name) : 'Patient';
    if (c.location) {
      lm.set(`c:p:${c.id}`, c.location, 'patient', { text: '!', popup: `<b>${name}</b> · ${esc(c.triage.label)}<br>${esc(c.id)} · ${esc(c.status)}`, z: 600 });
      keep.add(`c:p:${c.id}`);
    }
    const a = state.amb.get(c.id);
    const vpos = a?.position || c.transport?.position;
    if (vpos) {
      const amb = c.transport?.mode === 'ambulance';
      lm.set(`c:v:${c.id}`, vpos, amb ? 'ambulance' : 'car', { text: amb ? '🚑' : '🚗', popup: `<b>${esc(transportText(c))}</b><br>${esc(c.triage.label)} · ETA ${eta(c) ?? '?'} min`, z: 900 });
      lm.line(`c:l:${c.id}`, vpos, state.hospital, '#e11d48');
      keep.add(`c:v:${c.id}`); keep.add(`c:l:${c.id}`);
    } else if (c.location) {
      lm.line(`c:l:${c.id}`, c.location, state.hospital, '#7c3aed');
      keep.add(`c:l:${c.id}`);
    }
  }
  lm.prune('c:', keep);
}

function drawMap(sel) {
  const el = $(sel);
  if (!el || !window.L) return;
  const h = state.hospital;
  state.map = new LiveMap(el, h, 11);
  state.map.set('self', h, 'self', { text: 'H', popup: `<b>${esc(h.name)}</b><br>This hospital`, z: 800 });
  for (const o of state.hospitals.filter((x) => x.id !== h.id).map((x) => ({ x, km: roadKm(h, x) })).sort((a, b) => a.km - b.km).slice(0, 6)) drawNeighbour(o.x);
  drawIncoming(state.map);
  state.map.fit();
}

function go(view) {
  state.view = VIEWS[view] ? view : 'dashboard';
  try { history.replaceState(null, '', `#${state.view}`); } catch { /* embedded demo */ }
  $('#side').classList.remove('open');
  render();
}

function openCase(id) {
  const c = state.cases.get(id);
  if (!c) return;
  $('#mTitle').textContent = `${c.triage.icon} ${c.triage.label} · ${c.id}`;
  $('#mBody').innerHTML = `${caseCard(c).replace(`id="bay-${esc(c.id)}"`, 'id="mBay"')}
    <div class="panel-head" style="margin-top:.8rem"><h3>Patient location <span class="live-badge">LIVE</span></h3></div>
    <div class="map-box" id="mMap" style="height:230px"></div>
    <p class="small muted" style="margin:.35rem 0 0">Pick-up point rounded to about 100 m for privacy.</p>`;
  $('#caseModal').showModal();
  state.modalCase = c.id;
  state.modalMap?.destroy();
  if (window.L && c.location) {
    state.modalMap = new LiveMap($('#mMap'), c.location, 12);
    state.modalMap.set('self', state.hospital, 'self', { text: 'H', popup: esc(state.hospital.name) });
    drawIncoming(state.modalMap, c.id);
    state.modalMap.fit();
  }
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const t = e.target;
  const g = t.closest('[data-go]');
  if (g) { $('#userMenu').classList.add('hidden'); go(g.dataset.go); return; }
  const v = t.closest('[data-view-case]');
  if (v) { openCase(v.dataset.viewCase); return; }
  const acc = t.closest('[data-accept]');
  if (acc && !acc.disabled) { respond(acc.dataset.accept, true); return; }
  const dec = t.closest('[data-decline]');
  if (dec && !dec.disabled) { respond(dec.dataset.decline, false); return; }
  const tab = t.closest('[data-tab]');
  if (tab) { state.caseTab = tab.dataset.tab; render(); return; }
  const act = t.closest('[data-act="verify"]');
  if (act && !act.disabled) { patchStatus({}); return; }
  const k = t.closest('[data-k]');
  if (k && !k.disabled) {
    const s = state.hospital.status;
    const d = Number(k.dataset.d);
    if (k.dataset.k.startsWith('bed:')) { const type = k.dataset.k.slice(4); patchStatus({ beds: { [type]: { free: s.beds[type].free + d } } }); } else patchStatus({ [k.dataset.k]: s[k.dataset.k] + d });
    return;
  }
  const duty = t.closest('[data-duty]');
  if (duty && !duty.disabled) { const c = duty.dataset.duty; const s = state.hospital.status; patchStatus({ onDuty: s.onDuty.includes(c) ? s.onDuty.filter((x) => x !== c) : [...s.onDuty, c] }); return; }
  const eq = t.closest('[data-equip]');
  if (eq && !eq.disabled) { const c = eq.dataset.equip; const s = state.hospital.status; patchStatus({ equipmentDown: s.equipmentDown.includes(c) ? s.equipmentDown.filter((x) => x !== c) : [...s.equipmentDown, c] }); return; }
  if (t.closest('[data-close]')) { t.closest('dialog').close(); return; }
  if (!t.closest('#userBtn, #userMenu')) $('#userMenu').classList.add('hidden');
});

async function boot() {
  hydrateIcons();
  $('#caseModal').addEventListener('close', () => { state.modalMap?.destroy(); state.modalMap = null; state.modalCase = null; });
  for (const b of document.querySelectorAll('.nav-item[data-view]')) b.onclick = () => go(b.dataset.view);
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  $('#userBtn').onclick = () => $('#userMenu').classList.toggle('hidden');
  $('#bellBtn').onclick = () => { state.caseTab = 'pending'; go('cases'); };
  $('#logoutBtn').onclick = () => logout();
  $('#logoutSide').onclick = () => logout();
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (state.hospital && VIEWS[v] && v !== state.view) go(v); });
  const tick = () => { $('#clock').textContent = new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  tick();
  setInterval(tick, 30000);
  // Freshness labels age every minute even without events.
  setInterval(() => { if (state.hospital && ['dashboard', 'beds'].includes(state.view)) softRender(); }, 60000);

  const [config, hospitals] = await Promise.all([api('/api/config'), api('/api/hospitals')]);
  state.config = config;
  state.hospitals = hospitals;
  if (config.dataMode === 'demo') $('#demoStrip').classList.remove('hidden');

  const saved = session.get();
  if (saved?.token) {
    state.auth = saved;
    try {
      await api('/api/auth/me');
      await enter();
      return;
    } catch { state.auth = null; session.clear(); }
  }
  showGate();
}
boot();
