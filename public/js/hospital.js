// Sehat Setu – hospital emergency console (authorised staff only).
//
//   Login: Hospital ID + Staff ID + OTP  →  session bound to that hospital
//   Roles: Nodal Officer · Emergency Desk · Resource Manager · State Admin
//   Every change is stamped "updated by <role> at <time>" and audit-logged.

import { capLabel, SPECIALIST_CAPS, EQUIPMENT_CAPS } from '/shared/capabilities.js';
import { freshness, freshnessLabel } from '/shared/freshness.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('sehat.staff')); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('sehat.staff', JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { sessionStorage.removeItem('sehat.staff'); } catch { /* ignore */ } },
};

const state = { auth: null, hospital: null, hospitals: [], cases: new Map(), es: null, amb: new Map(), config: null };
const canDo = (p) => Boolean(state.auth?.permissions?.includes(p));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.auth ? { Authorization: `Bearer ${state.auth.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401 && state.auth) { logout(); throw new Error('Session expired – please log in again'); }
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

// ------------------------------------------------------------ alerts
function beep() {
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

// ------------------------------------------------------------ login
async function showQuickLogin() {
  if (state.config?.dataMode !== 'demo') return;
  const hid = $('#hospitalId').value;
  try {
    const staff = await api(`/api/auth/demo-staff?hospitalId=${encodeURIComponent(hid)}`);
    const list = staff.filter((s) => s.hospitalId === hid);
    $('#quickList').innerHTML = list.map((s) =>
      `<button type="button" class="chip" data-staff="${esc(s.staffId)}">${esc(s.roleLabel)} · ${esc(s.staffId)}</button>`).join('');
    $('#quickLogin').classList.toggle('hidden', !list.length);
  } catch { /* optional helper */ }
}

async function requestOtp(e) {
  e?.preventDefault();
  $('#loginError').textContent = '';
  try {
    const out = await api('/api/auth/otp', { method: 'POST', body: { hospitalId: $('#hospitalId').value, staffId: $('#staffId').value } });
    $('#otpForm').classList.remove('hidden');
    $('#otpSent').textContent = `OTP sent to registered mobile ${out.maskedMobile}. Valid 5 minutes.`;
    const demo = $('#otpDemo');
    demo.classList.toggle('hidden', !out.demoOtp);
    if (out.demoOtp) demo.innerHTML = `Demo only (no SMS gateway): your OTP is <b>${esc(out.demoOtp)}</b>`;
    $('#otp').focus();
    return out;
  } catch (err) { $('#loginError').textContent = err.message; return null; }
}

async function verifyOtp(e, code) {
  e?.preventDefault();
  $('#loginError').textContent = '';
  try {
    const out = await api('/api/auth/verify', { method: 'POST', body: { hospitalId: $('#hospitalId').value, staffId: $('#staffId').value, otp: code ?? $('#otp').value } });
    state.auth = out;
    session.set(out);
    await enterConsole();
  } catch (err) { $('#loginError').textContent = err.message; }
}

async function logout() {
  const token = state.auth?.token;
  state.auth = null;
  session.clear();
  state.es?.close();
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  $('#consoleView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#whoami').classList.add('hidden');
  $('#conn').classList.add('hidden');
  $('#otpForm').classList.add('hidden');
  $('#otp').value = '';
}

/** Used by the single-file demo: log in as a hospital's staff member in one call. */
async function demoLogin(hospitalId, role = 'ED01') {
  if (state.auth?.staff.hospitalId === hospitalId) return true;
  if (state.auth) await logout();
  $('#hospitalId').value = hospitalId;
  $('#staffId').value = `${hospitalId.toUpperCase()}-${role}`;
  const out = await requestOtp();
  if (!out?.demoOtp) return false;
  $('#otp').value = out.demoOtp;
  await verifyOtp(null, out.demoOtp);
  return Boolean(state.auth);
}
window.sehatConsole = { demoLogin, logout };

async function enterConsole() {
  const { staff } = state.auth;
  $('#loginView').classList.add('hidden');
  $('#consoleView').classList.remove('hidden');
  $('#whoami').classList.remove('hidden');
  $('#whoami').innerHTML = `👤 <b>${esc(staff.name)}</b> <span class="role">${esc(staff.roleLabel)}</span> <span class="muted">${esc(staff.staffId)}</span> <button class="btn ghost" id="logoutBtn" type="button" style="min-height:32px;padding:.2rem .6rem">Log out</button>`;
  $('#logoutBtn').onclick = logout;
  $('#conn').classList.remove('hidden');
  const admin = staff.role === 'admin';
  $('#adminHospital').classList.toggle('hidden', !admin);
  if (admin) {
    $('#adminHospital').innerHTML = state.hospitals.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join('');
    $('#adminHospital').onchange = (e) => load(e.target.value);
  }
  await load(admin ? state.hospitals[0].id : staff.hospitalId);
}

// ------------------------------------------------------------ status panel
function verifiedLine() {
  const s = state.hospital.status;
  const f = freshness(s.verifiedAt);
  const l = freshnessLabel(f);
  const by = s.source === 'dashboard' && s.verifiedBy
    ? `${esc(s.verifiedBy.roleLabel)}${s.verifiedBy.name ? ` (${esc(s.verifiedBy.name)})` : ''}`
    : 'Simulated demo seed';
  const when = s.verifiedAt ? new Date(s.verifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  $('#verifiedLine').innerHTML = `${l.icon} <b>${esc(l.text)}</b><br>Updated by: ${by} · Time: ${when}<br>Data source: ${s.source === 'dashboard' ? 'Hospital Emergency Dashboard' : 'Simulated demo data'}`;
}

function renderStatus() {
  const h = state.hospital;
  const s = h.status;
  $('#hospitalTitle').textContent = `🏥 ${h.name}`;
  $('#erStatus').value = s.erStatus;
  $('#erStatus').disabled = !canDo('status.er');
  $('#verifyBtn').disabled = !canDo('status.verify');
  verifiedLine();
  const bedsOk = canDo('status.beds');
  const bedRows = Object.entries(s.beds).filter(([, b]) => b.total > 0);
  const counters = [
    ...bedRows.map(([type, b]) => ({ key: `bed:${type}`, label: `${type.toUpperCase()} beds free`, value: b.free, max: b.total, ok: bedsOk })),
    { key: 'erQueue', label: 'Patients waiting in ER', value: s.erQueue, ok: canDo('status.er') },
    ...(h.capabilities.includes('ventilator') ? [{ key: 'ventilatorsFree', label: 'Ventilators free', value: s.ventilatorsFree, ok: canDo('status.equipment') }] : []),
  ];
  $('#beds').innerHTML = counters.map((c) => `
    <div class="stat">
      <div class="label">${c.label}</div>
      <div class="row spread">
        <span class="value">${c.value}${c.max !== undefined ? `<span class="small muted">/${c.max}</span>` : ''}</span>
        <span class="stepper-btns"><button data-k="${c.key}" data-d="-1" aria-label="decrease" ${c.ok ? '' : 'disabled'}>−</button><button data-k="${c.key}" data-d="1" aria-label="increase" ${c.ok ? '' : 'disabled'}>+</button></span>
      </div>
    </div>`).join('');

  const dutyOk = canDo('status.duty');
  const specialists = h.capabilities.filter((c) => SPECIALIST_CAPS.has(c));
  $('#onDuty').innerHTML = specialists.map((c) =>
    `<button class="chip" data-duty="${c}" aria-pressed="${s.onDuty.includes(c)}" ${dutyOk ? '' : 'disabled'}>${s.onDuty.includes(c) ? '✓' : '✗'} ${esc(capLabel(c))}</button>`).join('') || '<span class="muted small">—</span>';
  const equipOk = canDo('status.equipment');
  const equipment = h.capabilities.filter((c) => EQUIPMENT_CAPS.has(c) && c !== 'ventilator');
  $('#equipment').innerHTML = equipment.map((c) => {
    const ok = !s.equipmentDown.includes(c);
    return `<button class="chip" data-equip="${c}" aria-pressed="${ok}" ${equipOk ? '' : 'disabled'}>${ok ? '✓' : '⚠️'} ${esc(capLabel(c))}</button>`;
  }).join('') || '<span class="muted small">—</span>';
}

async function patchStatus(patch) {
  try {
    state.hospital = await api(`/api/hospitals/${state.hospital.id}/status`, { method: 'PATCH', body: patch });
    renderStatus();
    loadAudit();
  } catch (err) { alert(err.message); }
}

function onStatusClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const s = state.hospital.status;
  if (b.id === 'verifyBtn') { patchStatus({}); return; }
  if (b.dataset.k) {
    const d = Number(b.dataset.d);
    if (b.dataset.k.startsWith('bed:')) {
      const type = b.dataset.k.slice(4);
      patchStatus({ beds: { [type]: { free: s.beds[type].free + d } } });
    } else {
      patchStatus({ [b.dataset.k]: s[b.dataset.k] + d });
    }
  } else if (b.dataset.duty) {
    const c = b.dataset.duty;
    patchStatus({ onDuty: s.onDuty.includes(c) ? s.onDuty.filter((x) => x !== c) : [...s.onDuty, c] });
  } else if (b.dataset.equip) {
    const c = b.dataset.equip;
    patchStatus({ equipmentDown: s.equipmentDown.includes(c) ? s.equipmentDown.filter((x) => x !== c) : [...s.equipmentDown, c] });
  }
}

// ------------------------------------------------------------ forecast chart (single series)
function renderForecast(forecast) {
  const max = Math.max(...forecast.map((f) => f.expected), 1);
  const peak = forecast.reduce((a, b) => (b.expected > a.expected ? b : a));
  $('#forecast').innerHTML = forecast.map((f) => `
    <div class="col">
      <span class="tip">${String(f.hour).padStart(2, '0')}:00 · ${f.expected} expected arrivals</span>
      <div class="bar" style="height:${Math.max(3, (f.expected / max) * 100)}%">${f === peak || f === forecast[0] ? `<span class="val">${f.expected}</span>` : ''}</div>
    </div>`).join('');
  $('#forecastX').innerHTML = forecast.map((f) => `<span>${String(f.hour).padStart(2, '0')}h</span>`).join('');
  $('#forecastTable').innerHTML = `<tr><th align="left">Hour</th><th align="right">Expected arrivals</th></tr>${forecast.map((f) => `<tr><td>${String(f.hour).padStart(2, '0')}:00</td><td align="right">${f.expected}</td></tr>`).join('')}`;
}

// ------------------------------------------------------------ referrals
function patientLine(c) {
  const p = c.patient || {};
  const bits = [p.name, p.age ? `${p.age}y` : c.triage.patient?.age ? `${c.triage.patient.age}y` : null, p.gender, p.bloodGroup ? `🩸 ${p.bloodGroup}` : null].filter(Boolean);
  return bits.length ? bits.map(esc).join(' · ') : c.consent?.patientDetails ? 'Details not available' : '🔒 Family did not consent to share patient details';
}

function caseCard(c, pending) {
  const tr = c.triage;
  const p = c.patient || {};
  const amb = state.amb.get(c.id);
  const eta = amb?.etaMin ?? c.transport?.etaMin ?? c.etaMin;
  const respond = canDo('referral.respond');
  return `
    <div class="card tight ${pending ? `incoming ${tr.severity}` : ''}" style="margin-top:.75rem">
      <div class="row spread">
        <div class="row"><span style="font-size:1.4rem">${tr.icon}</span><b>${esc(tr.label)}</b> <span class="sev ${tr.severity}">${tr.severity.toUpperCase()}</span></div>
        <span class="small muted">${esc(c.id)}</span>
      </div>
      <p class="small" style="margin:.35rem 0">${patientLine(c)}${p.abhaId ? ` · ABHA ${esc(p.abhaId)}` : ''}${p.ayushmanId ? ` · Ayushman ${esc(p.ayushmanId)}` : ''}${c.alone ? ' · <b class="redflag">🆘 patient is ALONE</b>' : ''}</p>
      ${p.allergies?.length ? `<p class="small redflag">Allergies: ${p.allergies.map(esc).join(', ')}</p>` : ''}
      <div class="row small">
        <span class="badge">ETA ${eta ?? '?'} min</span>
        <span class="badge">${esc((c.bedType || 'er').toUpperCase())} bed</span>
        <span class="badge">${c.transport ? (c.transport.mode === 'ambulance' ? `🚑 ${esc(c.transport.ambulance.id)} (simulated)${amb ? ` · ${esc(amb.phase.replace('_', ' '))}` : ''}` : '🚗 own vehicle') : 'transport: deciding'}</span>
        ${c.handover ? `<span class="badge">note: ${c.handover.engine === 'claude' ? '🧠 Claude' : 'template'}</span>` : ''}
      </div>
      ${c.handover ? `<pre class="sbar">${esc(c.handover.text)}</pre>` : ''}
      ${c.vision?.description ? `<p class="small">📷 ${esc(c.vision.description)}</p>` : ''}
      <p class="small muted">Needs: ${tr.required.map((x) => esc(capLabel(x))).join(', ')}</p>
      ${pending ? `
        <div class="row">
          <input id="bay-${c.id}" placeholder="Receiving bay, e.g. Resus-02" style="flex:1;min-width:140px;padding:.5rem;border-radius:10px;border:1px solid var(--line);background:var(--surface)" ${respond ? '' : 'disabled'}>
          <button class="btn primary" data-accept="${c.id}" ${respond ? '' : 'disabled'}>✅ Accept referral</button>
          <button class="btn" data-decline="${c.id}" ${respond ? '' : 'disabled'}>✗ Decline</button>
        </div>
        ${respond ? '' : '<p class="small muted">Your role cannot respond to referrals.</p>'}`
    : c.status !== 'arrived' ? `<div class="row"><span class="small">Status: <b>${esc(c.status)}</b>${c.bay ? ` · bay ${esc(c.bay)}` : ''}${c.acceptedBy ? ` · accepted by ${esc(c.acceptedBy.roleLabel)}${c.acceptedBy.name && c.acceptedBy.role !== 'simulated' ? ` (${esc(c.acceptedBy.name)})` : ''}` : ''}</span></div>` : ''}
    </div>`;
}

function renderCases() {
  const list = [...state.cases.values()].filter((c) => c.hospitalId === state.hospital.id);
  const pending = list.filter((c) => c.status === 'requested');
  const active = list.filter((c) => ['accepted', 'enroute'].includes(c.status));
  const done = list.filter((c) => ['arrived', 'declined', 'timeout'].includes(c.status));
  $('#incoming').innerHTML = pending.length ? pending.map((c) => caseCard(c, true)).join('') : '<p class="empty">No pending requests. Open the <a href="/" target="_blank">citizen app</a> in another tab to create one.</p>';
  $('#active').innerHTML = active.length ? active.map((c) => caseCard(c, false)).join('') : '<p class="empty">None yet.</p>';
  $('#history').innerHTML = done.length ? done.slice(-8).reverse().map((c) =>
    `<p>${c.triage.icon} <b>${esc(c.id)}</b> – ${esc(c.triage.label)} · ${esc(c.status)}</p>`).join('') : '<p class="muted">—</p>';
}

async function onCaseClick(e) {
  const acc = e.target.closest('[data-accept]');
  const dec = e.target.closest('[data-decline]');
  if (!acc && !dec) return;
  const id = (acc || dec).dataset.accept || (acc || dec).dataset.decline;
  const body = acc
    ? { accept: true, bay: $(`#bay-${id}`)?.value.trim() }
    : { accept: false, reason: prompt('Reason for declining (shared with the family):', 'No bed available') || 'Unable to admit' };
  try {
    const c = await api(`/api/hospitals/${state.hospital.id}/cases/${id}/respond`, { method: 'POST', body });
    state.cases.set(c.id, c);
    renderCases();
    loadAudit();
  } catch (err) {
    alert(err.message);
  }
}

// ------------------------------------------------------------ audit log
async function loadAudit() {
  const show = canDo('audit.view');
  $('#auditCard').classList.toggle('hidden', !show);
  if (!show) return;
  try {
    const rows = await api(`/api/hospitals/${state.hospital.id}/audit`);
    $('#audit').innerHTML = `<tr><th>Time</th><th>Who</th><th>Action</th><th>Details</th></tr>${rows.slice(0, 60).map((r) => `
      <tr><td>${new Date(r.at).toLocaleTimeString()}</td><td>${esc(r.name || r.staffId || 'system')}${r.roleLabel ? `<br><span class="muted">${esc(r.roleLabel)}</span>` : ''}</td><td>${esc(r.action)}</td><td>${esc(r.result || '')}</td></tr>`).join('')}`;
  } catch { /* not allowed */ }
}

// ------------------------------------------------------------ live connection
function connect() {
  state.es?.close();
  const es = new EventSource(`/api/stream/hospital/${state.hospital.id}?token=${encodeURIComponent(state.auth.token)}`);
  state.es = es;
  es.onopen = () => { $('#conn').textContent = '● live'; $('#conn').style.color = 'var(--ok)'; };
  es.onerror = () => { $('#conn').textContent = '● reconnecting'; $('#conn').style.color = 'var(--serious)'; };
  es.addEventListener('request', (e) => {
    const c = JSON.parse(e.data);
    state.cases.set(c.id, c);
    renderCases();
    beep();
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(`New ${c.triage.severity} referral. ${c.triage.label}. E T A ${c.etaMin} minutes.`));
  });
  es.addEventListener('case', (e) => { const c = JSON.parse(e.data); state.cases.set(c.id, c); renderCases(); });
  es.addEventListener('ambulance', (e) => { const a = JSON.parse(e.data); state.amb.set(a.caseId, a); renderCases(); });
  es.addEventListener('position', (e) => {
    const p = JSON.parse(e.data);
    const c = state.cases.get(p.caseId);
    if (c?.transport) { c.transport.etaMin = p.etaMin; renderCases(); }
  });
  es.addEventListener('status', (e) => { state.hospital.status = JSON.parse(e.data).status; renderStatus(); });
  es.addEventListener('audit', () => loadAudit());
}

async function load(id) {
  const data = await api(`/api/hospitals/${id}/dashboard`);
  state.hospital = data.hospital;
  state.cases = new Map(data.cases.map((c) => [c.id, c]));
  state.amb.clear();
  renderStatus();
  renderForecast(data.forecast);
  renderCases();
  loadAudit();
  connect();
}

async function boot() {
  const [config, hospitals] = await Promise.all([api('/api/config'), api('/api/hospitals')]);
  state.config = config;
  state.hospitals = hospitals;
  if (config.dataMode === 'demo') $('#demoBanner').classList.remove('hidden');
  const params = new URLSearchParams(location.search);
  $('#hospitalId').innerHTML = [...hospitals.map((h) => `<option value="${h.id}">${esc(h.id)} – ${esc(h.name)}</option>`), '<option value="MP-STATE">MP-STATE – State Health Control Room</option>'].join('');
  if (params.get('id')) $('#hospitalId').value = params.get('id');
  $('#hospitalId').onchange = () => { $('#otpForm').classList.add('hidden'); showQuickLogin(); };
  $('#quickList').onclick = (e) => { const b = e.target.closest('[data-staff]'); if (b) { $('#staffId').value = b.dataset.staff; requestOtp(); } };
  $('#loginForm').onsubmit = requestOtp;
  $('#otpForm').onsubmit = verifyOtp;
  $('#erStatus').onchange = (e) => patchStatus({ erStatus: e.target.value });
  document.querySelector('aside').addEventListener('click', onStatusClick);
  $('#casesCol').addEventListener('click', onCaseClick);
  showQuickLogin();

  // Resume the session in this tab if still valid.
  const saved = session.get();
  if (saved?.token) {
    state.auth = saved;
    try { await api('/api/auth/me'); await enterConsole(); } catch { state.auth = null; session.clear(); }
  }
}

boot();
