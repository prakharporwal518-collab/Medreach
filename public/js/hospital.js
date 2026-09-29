// Sehat Setu – hospital emergency console.
// Receives real-time admission requests (with an AI SBAR pre-arrival note),
// lets the ER desk accept / decline in one tap, and keeps the live status
// (beds, specialists on duty, equipment) that the routing engine depends on.

import { capLabel, SPECIALIST_CAPS, EQUIPMENT_CAPS } from '/shared/capabilities.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { hospital: null, cases: new Map(), es: null, amb: new Map() };

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json();
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

// ------------------------------------------------------------ status panel
function renderStatus() {
  const h = state.hospital;
  const s = h.status;
  $('#erStatus').value = s.erStatus;
  $('#updated').textContent = s.updatedAt ? `updated ${new Date(s.updatedAt).toLocaleTimeString()}` : '';
  const bedRows = Object.entries(s.beds).filter(([, b]) => b.total > 0);
  const counters = [
    ...bedRows.map(([type, b]) => ({ key: `bed:${type}`, label: `${type.toUpperCase()} beds free`, value: b.free, max: b.total })),
    { key: 'erQueue', label: 'Patients waiting in ER', value: s.erQueue },
    ...(h.capabilities.includes('ventilator') ? [{ key: 'ventilatorsFree', label: 'Ventilators free', value: s.ventilatorsFree }] : []),
  ];
  $('#beds').innerHTML = counters.map((c) => `
    <div class="stat">
      <div class="label">${c.label}</div>
      <div class="row spread">
        <span class="value">${c.value}${c.max !== undefined ? `<span class="small muted">/${c.max}</span>` : ''}</span>
        <span class="stepper-btns"><button data-k="${c.key}" data-d="-1" aria-label="decrease">−</button><button data-k="${c.key}" data-d="1" aria-label="increase">+</button></span>
      </div>
    </div>`).join('');

  const specialists = h.capabilities.filter((c) => SPECIALIST_CAPS.has(c));
  $('#onDuty').innerHTML = specialists.map((c) =>
    `<button class="chip" data-duty="${c}" aria-pressed="${s.onDuty.includes(c)}">${s.onDuty.includes(c) ? '✓' : '✗'} ${esc(capLabel(c))}</button>`).join('') || '<span class="muted small">—</span>';
  const equipment = h.capabilities.filter((c) => EQUIPMENT_CAPS.has(c) && c !== 'ventilator');
  $('#equipment').innerHTML = equipment.map((c) => {
    const ok = !s.equipmentDown.includes(c);
    return `<button class="chip" data-equip="${c}" aria-pressed="${ok}">${ok ? '✓' : '⚠️'} ${esc(capLabel(c))}</button>`;
  }).join('') || '<span class="muted small">—</span>';
}

async function patchStatus(patch) {
  const h = await getJson(`/api/hospitals/${state.hospital.id}/status`, { method: 'PATCH', body: patch });
  state.hospital = h;
  renderStatus();
}

function onStatusClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const s = state.hospital.status;
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

// ------------------------------------------------------------ cases
function patientLine(c) {
  const p = c.patient || {};
  const bits = [p.name, p.age ? `${p.age}y` : c.triage.patient?.age ? `${c.triage.patient.age}y` : null, p.gender, p.bloodGroup ? `🩸 ${p.bloodGroup}` : null].filter(Boolean);
  return bits.length ? bits.map(esc).join(' · ') : 'Patient details not provided';
}

function caseCard(c, pending) {
  const tr = c.triage;
  const p = c.patient || {};
  const amb = state.amb.get(c.id);
  const eta = amb?.etaMin ?? c.transport?.etaMin ?? c.etaMin;
  return `
    <div class="card tight ${pending ? `incoming ${tr.severity}` : ''}" style="margin-top:.75rem">
      <div class="row spread">
        <div class="row"><span style="font-size:1.4rem">${tr.icon}</span><b>${esc(tr.label)}</b> <span class="sev ${tr.severity}">${tr.severity.toUpperCase()}</span></div>
        <span class="small muted">${esc(c.id)}</span>
      </div>
      <p class="small" style="margin:.35rem 0">${patientLine(c)}${p.abhaId ? ` · ABHA ${esc(p.abhaId)}` : ''}${p.ayushmanId ? ' · Ayushman ✓' : ''}</p>
      ${p.allergies?.length ? `<p class="small redflag">Allergies: ${p.allergies.map(esc).join(', ')}</p>` : ''}
      <div class="row small">
        <span class="badge">ETA ${eta ?? '?'} min</span>
        <span class="badge">${esc((c.bedType || 'er').toUpperCase())} bed</span>
        <span class="badge">${c.transport ? (c.transport.mode === 'ambulance' ? `🚑 ${esc(c.transport.ambulance.id)}${amb ? ` · ${esc(amb.phase.replace('_', ' '))}` : ''}` : '🚗 own vehicle') : 'transport: deciding'}</span>
        ${c.handover ? `<span class="badge">note: ${c.handover.engine === 'claude' ? '🧠 Claude' : 'template'}</span>` : ''}
      </div>
      ${c.handover ? `<pre class="sbar">${esc(c.handover.text)}</pre>` : ''}
      ${c.vision?.description ? `<p class="small">📷 ${esc(c.vision.description)}</p>` : ''}
      <p class="small muted">Needs: ${tr.required.map((x) => esc(capLabel(x))).join(', ')}</p>
      ${pending ? `
        <div class="row">
          <input id="bay-${c.id}" placeholder="Bay / bed (optional)" style="flex:1;min-width:140px;padding:.5rem;border-radius:10px;border:1px solid var(--line);background:var(--surface)">
          <button class="btn primary" data-accept="${c.id}">✅ Accept</button>
          <button class="btn" data-decline="${c.id}">✗ Decline</button>
        </div>` : c.status !== 'arrived' ? `<div class="row"><span class="small">Status: <b>${esc(c.status)}</b>${c.bay ? ` · ${esc(c.bay)}` : ''}</span></div>` : ''}
    </div>`;
}

function renderCases() {
  const list = [...state.cases.values()].filter((c) => c.hospitalId === state.hospital.id);
  const pending = list.filter((c) => c.status === 'requested');
  const active = list.filter((c) => ['accepted', 'enroute'].includes(c.status));
  const done = list.filter((c) => ['arrived', 'declined', 'timeout'].includes(c.status) || (c.hospitalId !== state.hospital.id));
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
    const c = await getJson(`/api/hospitals/${state.hospital.id}/cases/${id}/respond`, { method: 'POST', body });
    state.cases.set(c.id, c);
    renderCases();
  } catch (err) {
    alert(err.message);
  }
}

// ------------------------------------------------------------ live connection
function connect() {
  state.es?.close();
  const es = new EventSource(`/api/stream/hospital/${state.hospital.id}`);
  state.es = es;
  es.onopen = () => { $('#conn').textContent = '● live'; $('#conn').style.color = 'var(--ok)'; };
  es.onerror = () => { $('#conn').textContent = '● reconnecting'; $('#conn').style.color = 'var(--serious)'; };
  es.addEventListener('request', (e) => {
    const c = JSON.parse(e.data);
    state.cases.set(c.id, c);
    renderCases();
    beep();
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(`New ${c.triage.severity} patient. ${c.triage.label}. E T A ${c.etaMin} minutes.`));
  });
  es.addEventListener('case', (e) => { const c = JSON.parse(e.data); state.cases.set(c.id, c); renderCases(); });
  es.addEventListener('ambulance', (e) => { const a = JSON.parse(e.data); state.amb.set(a.caseId, a); renderCases(); });
  es.addEventListener('position', (e) => {
    const p = JSON.parse(e.data);
    const c = state.cases.get(p.caseId);
    if (c?.transport) { c.transport.etaMin = p.etaMin; renderCases(); }
  });
  es.addEventListener('status', (e) => { state.hospital.status = JSON.parse(e.data).status; renderStatus(); });
}

async function load(id) {
  const data = await getJson(`/api/hospitals/${id}/dashboard`);
  state.hospital = data.hospital;
  state.cases = new Map(data.cases.map((c) => [c.id, c]));
  state.amb.clear();
  renderStatus();
  renderForecast(data.forecast);
  renderCases();
  connect();
  try { history.replaceState(null, '', `/hospital?id=${id}`); } catch { /* e.g. embedded demo */ }
}

async function boot() {
  const hospitals = await getJson('/api/hospitals');
  const initial = new URLSearchParams(location.search).get('id') || hospitals[0].id;
  $('#hospitalSelect').innerHTML = hospitals.map((h) => `<option value="${h.id}" ${h.id === initial ? 'selected' : ''}>${esc(h.name)}</option>`).join('');
  $('#hospitalSelect').onchange = (e) => load(e.target.value);
  $('#erStatus').onchange = (e) => patchStatus({ erStatus: e.target.value });
  document.querySelector('aside').addEventListener('click', onStatusClick);
  document.querySelector('.console-grid > section').addEventListener('click', onCaseClick);
  await load(initial);
}

boot();
