// Medreach – citizen app. Each step below is one box of the flowchart:
//
//  0 🚨 Sudden emergency   – voice / text / quick chip (+ photo, + health card) · 🆘 I'm alone
//  1 🧠 AI understands     – AI/NLP extracts requirements (NOT a diagnosis)
//  2 📍 Location           – GPS (started in the background at app launch)
//  3 🏥 Suitable hospitals – deterministic engine: capability + verified status → ETA → explained options
//  4 🏥 Hospital confirms  – reported capacity ≠ referral accepted ≠ confirmed destination
//  5 🚑 Transport          – ambulance request (simulated in prototype) or own vehicle
//  6 🗺️ Navigation         – road route, turn-by-turn, voice, live tracking, family link
//  7 🏥 Confirmed hospital – handover done
//
// USP: Emergency → Understand → Match → Verify → Accept → Transport → Confirm

import { STRINGS, reasonText } from './i18n.js';
import * as api from './api.js';
import { listen, speak, stopSpeaking, isSpeaking, voiceInputSupported } from './voice.js';
import { fileToDataUrl, analysePhoto } from './vision.js';
import { scanHealthDocument } from './ocr.js';
import { createMap, marker, route, pointAlong, ARROWS } from './map.js';
import { EMERGENCIES, FOLLOW_UPS } from '/shared/triage.js';
import { capLabel, CAPABILITIES } from '/shared/capabilities.js';
import { haversineKm } from '/shared/predict.js';
import { freshness, freshnessLabel, ago } from '/shared/freshness.js';
import * as citizen from './citizen-store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  lang: store.get('sehat.lang') || (navigator.language?.startsWith('hi') ? 'hi' : 'en'),
  step: 0,
  text: '',
  usedVoice: false,
  hintType: null,
  answers: {},
  photo: null,
  vision: null,
  patient: {},
  consentDetails: false,
  contact: store.get('sehat.contact'),
  alone: false,
  aloneDone: new Set(),
  triage: null,
  location: null,
  locationNote: '',
  gps: null,
  match: null,
  selected: null,
  tried: [],
  caseData: null,
  trackToken: null,
  es: null,
  hosES: null,
  handled: new Set(),
  transportMode: null,
  config: null,
};

const t = () => STRINGS[state.lang];
const hName = (h) => (state.lang === 'hi' && h.nameHi ? h.nameHi : h.name);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ------------------------------------------------------------------ shell
function applyI18n() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const v = t()[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  }
  $('#describe').placeholder = t().describePh;
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  $('#privacyList').innerHTML = t().privacyPoints.map((p) => `<li>${esc(p)}</li>`).join('');
  renderChips();
  renderContact();
  renderStepper();
  renderAlonePanel();
}

function renderStepper() {
  $('#stepper').innerHTML = t().steps.map((_, i) =>
    `<li class="${i < state.step ? 'done' : i === state.step ? 'active' : ''}"></li>`).join('');
  $('#stepCaption').textContent = `${state.step + 1}/8 · ${t().steps[state.step]}`;
}

function go(step, { fromHistory = false } = {}) {
  if (state.step === 3 && step !== 3) { state.hosES?.close(); state.hosES = null; }
  const prev = state.step;
  state.step = step;
  document.querySelectorAll('.step').forEach((s) => s.classList.toggle('hidden', s.id !== `step-${step}`));
  renderStepper();
  renderBack();
  // The phone's own back button / gesture steps back through the first screens too.
  if (!fromHistory && step > prev && step <= 3) { try { history.pushState({ step }, ''); } catch { /* file:// */ } }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------ ← back / exit
const isEmbedded = () => document.body.classList.contains('embedded');
function renderBack() {
  const s = t();
  const lbl = $('#backLabel');
  if (!lbl) return;
  lbl.textContent = state.step >= 1 && state.step <= 3 ? s.back
    : state.step === 0 ? (isEmbedded() || citizen.current() ? s.backDashboard : s.backHome)
      : s.exitFlow;
}
function leaveEmergency() {
  if (isEmbedded()) { try { window.parent.location.hash = '#home'; return; } catch { /* cross-origin */ } }
  location.href = citizen.current() ? '/citizen' : '/';
}
function goBack() {
  if (state.step >= 1 && state.step <= 3) { go(state.step - 1, { fromHistory: true }); return; }
  if (state.step === 0 || !state.caseData || window.confirm(t().leaveConfirm)) leaveEmergency();
}
window.addEventListener('popstate', () => {
  if (state.step >= 1 && state.step <= 3) go(state.step - 1, { fromHistory: true });
});

function setOffline(off) { $('#offline').classList.toggle('hidden', !off); }
window.addEventListener('online', () => setOffline(false));
window.addEventListener('offline', () => setOffline(true));

// ------------------------------------------------------------------ 🆘 I'm alone mode
function aloneMark(key) {
  if (!state.alone) return;
  state.aloneDone.add(key);
  renderAlonePanel();
}

function renderAlonePanel() {
  const el = $('#alonePanel');
  if (!state.alone) { el.classList.add('hidden'); return; }
  const s = t();
  el.classList.remove('hidden');
  const items = [
    ['location', s.aloneSteps.location],
    ['contact', state.contact ? s.aloneSteps.contact(state.contact.name) : s.aloneSteps.noContact],
    ['requested', s.aloneSteps.requested],
    ['accepted', s.aloneSteps.accepted],
    ['transport', s.aloneSteps.transport],
  ];
  el.innerHTML = `
    <b>🆘 ${s.aloneBanner}</b>
    <ul class="alone-list">${items.map(([k, label]) => `<li class="${state.aloneDone.has(k) ? 'done' : ''}">${state.aloneDone.has(k) ? '✅' : '⏳'} ${esc(label)}</li>`).join('')}</ul>`;
}

function startAlone() {
  state.alone = true;
  state.aloneDone.clear();
  if (!state.text && !$('#describe').value.trim() && !state.hintType) state.hintType = 'general';
  renderAlonePanel();
  runTriage();
}

function renderContact() {
  const s = t();
  const c = state.contact;
  $('#contactBox').innerHTML = c
    ? `<p class="small">👤 ${esc(s.contactSaved(c.name))} (••••${esc(String(c.phone).slice(-4))}) <button class="linkish" id="editContact" type="button">${s.edit}</button></p>`
    : `<div class="row">
         <input id="cName" placeholder="${esc(s.contactName)}" class="inp grow">
         <input id="cPhone" placeholder="${esc(s.contactPhone)}" class="inp grow" inputmode="tel">
         <button class="btn" id="saveContact" type="button">${s.contactSave}</button>
       </div><p class="small muted">${s.contactNote}</p>`;
  $('#editContact')?.addEventListener('click', () => { state.contact = null; store.set('sehat.contact', null); renderContact(); });
  $('#saveContact')?.addEventListener('click', () => {
    const phone = $('#cPhone').value.replace(/[^\d+]/g, '');
    if (phone.length < 10) { $('#cPhone').focus(); return; }
    state.contact = { name: $('#cName').value.trim() || s.contactDefault, phone };
    store.set('sehat.contact', state.contact);
    renderContact();
  });
}

// ------------------------------------------------------------------ 📍 start GPS immediately (saves precious seconds)
function startGps() {
  if (!('geolocation' in navigator)) { state.gps = Promise.resolve({ error: 'unsupported' }); return; }
  state.gps = new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
        (e) => resolve({ error: e.code === 1 ? 'denied' : 'unavailable' }),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
      );
    } catch { resolve({ error: 'unavailable' }); }
  });
}

// ------------------------------------------------------------------ ① emergency input
function renderChips() {
  const types = Object.entries(EMERGENCIES).filter(([k]) => k !== 'general');
  $('#chips').innerHTML = types.map(([k, d]) =>
    `<button type="button" class="chip" data-type="${k}" aria-pressed="${state.hintType === k}">${d.icon} ${esc(d.label[state.lang])}</button>`).join('');
}

let stopListening = null;
function toggleMic() {
  if (stopListening) { stopListening(); return; }
  if (!voiceInputSupported) { alert(t().noVoice); $('#describe').focus(); return; }
  stopSpeaking();
  const base = $('#describe').value.trim();
  $('#micBtn').classList.add('listening');
  $('#micLabel').textContent = t().listening;
  stopListening = listen(state.lang, {
    onText: (txt) => { $('#describe').value = base ? `${base} ${txt}` : txt; state.usedVoice = true; },
    onEnd: () => {
      stopListening = null;
      $('#micBtn').classList.remove('listening');
      $('#micLabel').textContent = t().tapToSpeak;
      // Voice-first: when the person finishes speaking, go straight to understanding.
      if ($('#describe').value.trim()) runTriage();
    },
    onError: (err) => { if (err === 'not-allowed') alert(t().noVoice); },
  });
}

async function onPhoto(file) {
  if (!file) return;
  $('#photoResult').innerHTML = `<p>${t().visionRunning}</p>`;
  state.photo = await fileToDataUrl(file);
  state.vision = await analysePhoto(state.photo, state.lang);
  $('#photoAttach').classList.add('done');
  const tag = /^(claude|gemini)-vision$/.test(state.vision.engine) ? `${t().engineAi} (${state.vision.engine.startsWith('gemini') ? 'Gemini' : 'Claude'})` : t().heuristic;
  $('#photoResult').innerHTML = `
    <img class="thumb" src="${state.photo}" alt="">
    <p><b>${t().photoFindings}</b> <span class="engine-badge">${esc(tag)}</span><br>${esc(state.vision.description || state.vision.findings.join('; '))}</p>
    <p class="small muted">${t().photoPrivacy}</p>`;
  // The findings are passed to triage as evidence (not as a forced choice), so
  // "accident" in the description still wins over "blood in the photo".
}

async function onScan(file) {
  if (!file) return;
  $('#scanResult').innerHTML = `<p>${t().ocrRunning} <span id="ocrPct"></span></p>`;
  try {
    const dataUrl = await fileToDataUrl(file, 1600);
    const { fields } = await scanHealthDocument(dataUrl, (p) => { const el = $('#ocrPct'); if (el) el.textContent = `${Math.round(p * 100)}%`; });
    state.patient = { ...state.patient, ...fields };
    $('#scanAttach').classList.add('done');
    $('#scanResult').innerHTML = `<p>${fields.fieldsFound ? t().ocrDone(fields.fieldsFound) : t().ocrNone}</p>`;
  } catch (e) {
    $('#scanResult').innerHTML = `<p>${esc(e.message)} – ${t().ocrNone}</p>`;
  }
  fillPatientForm();
}

function fillPatientForm() {
  $('#patientForm').classList.remove('hidden');
  for (const input of document.querySelectorAll('#patientForm [data-field]')) {
    const v = state.patient[input.dataset.field];
    input.value = Array.isArray(v) ? v.join(', ') : v ?? '';
  }
}

function readPatientForm() {
  if ($('#patientForm').classList.contains('hidden')) return;
  for (const input of document.querySelectorAll('#patientForm [data-field]')) {
    const f = input.dataset.field;
    const v = input.value.trim();
    if (['conditions', 'allergies', 'medicines'].includes(f)) state.patient[f] = v ? v.split(/\s*,\s*/) : [];
    else if (f === 'age') state.patient.age = v ? Number(v) || undefined : undefined;
    else state.patient[f] = v || undefined;
  }
}

const hasPatientDetails = () => Object.entries(state.patient)
  .some(([k, v]) => k !== 'fieldsFound' && (Array.isArray(v) ? v.length : v !== undefined && v !== ''));

function selectChip(type) {
  state.hintType = state.hintType === type ? null : type;
  renderChips();
}

// ------------------------------------------------------------------ ② AI understands (requirements, not diagnosis)
async function runTriage() {
  state.text = $('#describe').value.trim();
  if (!state.text && !state.hintType) { $('#describe').focus(); return; }
  readPatientForm();
  go(1);
  $('#step-1').innerHTML = `<div class="card"><div class="spinner"></div><p style="text-align:center">${t().understanding}</p></div>`;
  let text = state.text;
  if (state.patient.age && !/\d+\s*(saal|years?|yrs?|साल|वर्ष)/i.test(text)) text += ` (${state.patient.age} years)`;
  try {
    state.triage = await api.triage({
      text, lang: state.lang, answers: state.answers, hintType: state.hintType,
      visionFindings: state.vision?.description ? `Photo shows: ${state.vision.description}` : '',
    });
    // A person alone who can't describe much is at least a serious emergency.
    if (state.alone && state.triage.severity === 'moderate') state.triage.severity = 'serious';
    if (state.triage.offline) setOffline(true);
    renderTriage();
    if (state.usedVoice && !state.alone) speak([state.triage.label, ...state.triage.firstAid], state.lang);
    if (state.alone) setTimeout(showLocation, 1200);
  } catch (e) {
    $('#step-1').innerHTML = `<div class="card"><p>${esc(e.message || t().genericError)}</p><button class="btn" id="backEdit">${t().notRight}</button></div>`;
    $('#backEdit').onclick = () => go(0);
  }
}

function renderTriage() {
  const tr = state.triage;
  const s = t();
  const qId = state.alone ? null : tr.followUps?.[0];
  const q = qId ? FOLLOW_UPS[qId] : null;
  const engine = ['claude', 'gemini'].includes(tr.engine) ? `${s.engineAi} (${tr.engine === 'gemini' ? 'Gemini' : 'Claude'})` : s.engineRules;
  const age = tr.patient?.isChild ? s.ageChild : tr.patient?.isElderly ? s.ageElderly : tr.patient?.age ? `${tr.patient.age}` : s.ageUnknown;
  const cpr = tr.redFlags?.includes('not_breathing');
  $('#step-1').innerHTML = `
    <div class="card">
      <div class="row spread">
        <span class="engine-badge">🧠 ${esc(engine)}</span>
        <span class="small muted">${s.confidence} ${Math.round(tr.confidence * 100)}%</span>
      </div>
      <p class="small muted" style="margin:.6rem 0 .1rem">${s.mayIndicate}</p>
      <div class="card-title"><span class="icon">${tr.icon}</span><h2 style="margin:0">${esc(tr.label)}</h2></div>
      <span class="sev ${tr.severity}">● ${s.severity[tr.severity]}</span>
      <div class="bar-meter" style="margin:.6rem 0" title="severity"><i style="width:${tr.severityScore}%;background:var(--${tr.severity})"></i></div>
      ${tr.redFlagLabels?.length ? `<p class="redflag">⚠️ ${s.redFlags}: ${tr.redFlagLabels.map(esc).join(', ')}</p>` : ''}
      <h3 class="small muted">${s.needs}</h3>
      <div class="cap-list">${tr.required.map((c) => `<span class="cap">${CAPABILITIES[c]?.icon || ''} ${esc(capLabel(c, state.lang))}</span>`).join('')}</div>
      <p class="small muted" style="margin-top:.6rem">ℹ️ ${s.notDiagnosis}</p>
      <details class="how">
        <summary>🔍 ${s.howDecided}</summary>
        <ol class="pipeline">
          <li><b>${s.pipe1}</b> <span class="muted">(${esc(engine)})</span></li>
          <li><b>${s.pipe2}</b>
            <table class="kv">
              <tr><td>${s.fieldType}</td><td>${esc(tr.label)}</td></tr>
              <tr><td>${s.fieldSeverity}</td><td>${s.severity[tr.severity]}</td></tr>
              <tr><td>${s.fieldFlags}</td><td>${tr.redFlagLabels?.length ? tr.redFlagLabels.map(esc).join(', ') : s.none}</td></tr>
              <tr><td>${s.fieldAge}</td><td>${esc(age)}</td></tr>
              <tr><td>${s.fieldCaps}</td><td>${tr.required.map((c) => esc(capLabel(c, state.lang))).join(', ')}</td></tr>
            </table>
          </li>
          <li><b>${s.pipe3}</b></li>
          <li><b>${s.pipe4}</b></li>
        </ol>
        <p class="small muted">${s.pipeNote}</p>
      </details>
    </div>

    ${q ? `
    <div class="card question">
      <h3>💬 ${s.askNext}</h3>
      <p>${esc(q.q[state.lang])}</p>
      <div class="chips">${q.options.map((o) => `<button class="chip" data-answer="${qId}" data-value="${o.value}">${esc(o.label[state.lang])}</button>`).join('')}</div>
    </div>` : !state.alone && tr.aiQuestion ? `<div class="card question"><h3>💬 ${s.askNext}</h3><p>${esc(tr.aiQuestion)}</p></div>` : ''}

    <details class="card safety" ${cpr || state.usedVoice ? 'open' : ''}>
      <summary><b>🩹 ${s.safetySteps}</b><br><span class="small muted">${s.safetySub}</span></summary>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" id="readBtn" type="button">${isSpeaking() ? s.stopReading : s.readAloud}</button></div>
      <ol class="firstaid">${tr.firstAid.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    </details>

    <div class="row" style="margin-top:1rem">
      <button class="btn ghost" id="editBtn" type="button">✏️ ${s.notRight}</button>
      <span class="grow"></span>
      <button class="btn primary lg" id="toLocBtn" type="button">🏥 ${s.continue}</button>
    </div>`;

  for (const b of document.querySelectorAll('[data-answer]')) {
    b.onclick = () => { state.answers[b.dataset.answer] = b.dataset.value; runTriage(); };
  }
  $('#readBtn').onclick = (e) => {
    e.preventDefault();
    if (isSpeaking()) { stopSpeaking(); $('#readBtn').textContent = s.readAloud; return; }
    $('#readBtn').textContent = s.stopReading;
    speak(tr.firstAid, state.lang).then(() => { const b = $('#readBtn'); if (b) b.textContent = s.readAloud; });
  };
  $('#editBtn').onclick = () => { stopSpeaking(); state.alone = false; renderAlonePanel(); go(0); };
  $('#toLocBtn').onclick = () => showLocation();
}

// ------------------------------------------------------------------ ③ location
let locMap = null;
let locMarker = null;

async function showLocation() {
  go(2);
  const s = t();
  $('#locStatus').textContent = s.locating;
  const demo = state.config?.demoLocation || { lat: 23.2355, lng: 77.4005 };
  if (!locMap) {
    locMap = createMap($('#locMap'), state.location || demo, 13);
    locMap.on('click', (e) => setLocation({ lat: e.latlng.lat, lng: e.latlng.lng }, 'manual'));
  } else {
    setTimeout(() => locMap.invalidateSize(), 50);
  }
  if (!state.location) {
    const g = await state.gps;
    if (g.error) { $('#locStatus').textContent = s.locDenied; setLocation(demo, 'demo'); }
    else if (haversineKm(g, demo) > 120) { $('#locStatus').textContent = s.farAway; setLocation(demo, 'demo'); }
    else setLocation(g, 'gps');
  } else {
    setLocation(state.location, state.locationNote);
  }
  aloneMark('location');
  if (state.alone) setTimeout(findHospitals, 900);
}

function setLocation(pos, source) {
  state.location = { lat: pos.lat, lng: pos.lng };
  state.locationNote = source;
  if (locMarker) locMarker.setLatLng([pos.lat, pos.lng]);
  else locMarker = marker(locMap, pos, '📍');
  locMap.setView([pos.lat, pos.lng], 14);
  if (source === 'gps') $('#locStatus').textContent = `GPS ✓ · ${t().accuracy} ±${pos.accuracy ?? '?'} m`;
  if (source === 'manual') $('#locStatus').textContent = '📍 ✓';
}

// ------------------------------------------------------------------ ④ find suitable hospitals
let hospMap = null;
let hospLayer = null;
let govtOnly = false;

async function findHospitals({ silent = false } = {}) {
  if (!silent) {
    go(3);
    $('#step-3').innerHTML = `<div class="card"><div class="spinner"></div><p style="text-align:center">${t().finding}</p></div>`;
  }
  const previous = state.selected?.hospital.id;
  state.match = await api.match({
    triage: state.triage, location: state.location, lang: state.lang, mode: 'ambulance', excludeIds: state.tried,
  });
  if (state.match.offline) setOffline(true);
  const all = [...state.match.options, ...(state.match.stabilise ? [state.match.stabilise] : [])];
  state.selected = (silent && all.find((o) => o.hospital.id === previous)) || state.match.options[0] || state.match.stabilise || null;
  renderHospitals();
  if (!silent) watchHospitalUpdates();
  if (state.alone && !silent && state.selected) setTimeout(() => requestHospital(state.selected), 1200);
}

// Live: when any hospital updates its dashboard, re-rank and tell the citizen.
function watchHospitalUpdates() {
  if (state.hosES || state.match?.offline) return;
  let timer = null;
  const changed = new Set();
  try {
    state.hosES = api.streamHospitals();
    state.hosES.addEventListener('status', (e) => {
      if (state.step !== 3) return;
      changed.add(JSON.parse(e.data).id);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const names = [...changed].map((id) => {
          const o = [...state.match.options, ...state.match.excluded].find((x) => x.hospital.id === id);
          return o ? hName(o.hospital) : id;
        });
        changed.clear();
        await findHospitals({ silent: true });
        const note = $('#liveNote');
        if (note) { note.textContent = `🔄 ${t().liveUpdated(names.join(', '))}`; note.classList.remove('hidden'); }
      }, 500);
    });
  } catch { /* live updates are a bonus */ }
}

function capChips(o) {
  return o.capChecks.map((c) => {
    const cls = c.live ? 'ok' : c.has ? 'off' : 'no';
    const mark = c.live ? '✓' : c.has ? '⏸' : '✗';
    return `<span class="cap ${cls}">${mark} ${esc(capLabel(c.cap, state.lang))}</span>`;
  }).join('');
}

function freshBadge(f) {
  const l = freshnessLabel(f, state.lang);
  return `<span class="badge fresh-${f.level}" title="${esc(l.text)}">${l.icon} ${esc(l.text)}</span>`;
}

function hospitalCard(o, extraClass = '') {
  const s = t();
  const h = o.hospital;
  const selected = state.selected?.hospital.id === h.id;
  const checklist = o.checklist || [];
  return `
    <article class="hosp ${extraClass}" data-id="${h.id}" aria-selected="${selected}" tabindex="0">
      <div class="row" style="gap:.3rem">
        ${o.recommended ? `<span class="badge rec">★ ${s.recommended}</span>` : ''}
        <span class="badge ${h.ownership === 'govt' ? 'govt' : ''}">${h.ownership === 'govt' ? s.govt : s.private}</span>
        ${h.ayushman ? `<span class="badge pmjay">${s.pmjay}</span>` : ''}
        ${freshBadge(o.freshness)}
      </div>
      <h3 style="margin-top:.35rem">${esc(hName(h))}</h3>
      <div class="meta">${esc(h.area)}</div>
      <div class="kpis">
        <div class="kpi"><b>${o.etaMin}</b><span>${s.min} ${s.eta}</span></div>
        <div class="kpi"><b>${o.bed.freeNow}</b><span>${o.bedType.toUpperCase()} ${s.reported}</span></div>
        <div class="kpi"><b>${o.capacityVerified ? `${Math.round(o.bed.probability * 100)}%` : '?'}</b><span>${s.bedProb}</span></div>
        <div class="kpi"><b>${o.erWaitMin}</b><span>${s.min} ${s.erWait}</span></div>
      </div>
      <h4 class="why">${s.whyThis}</h4>
      <ul class="checklist">${checklist.map((i) => `<li class="ck-${i.ok === true ? 'ok' : i.ok}">${i.icon} ${esc(i.text)}</li>`).join('')}</ul>
      <div class="cap-list" style="margin-top:.4rem">${capChips(o)}</div>
      <details class="score-details">
        <summary>${s.scoreLabel(o.score)} · <span class="linkish">${s.scoreWhat}</span></summary>
        <table class="kv">${(o.breakdown || []).map(([label, got, max]) => `<tr><td>${esc(label)}</td><td>${got}${max ? ` / ${max}` : ''}</td></tr>`).join('')}
          <tr><td><b>${s.total}</b></td><td><b>${o.score} / 100</b></td></tr></table>
        <p class="small muted">${s.scoreNote}</p>
      </details>
    </article>`;
}

function renderHospitals() {
  const s = t();
  const m = state.match;
  const options = govtOnly ? m.options.filter((o) => o.hospital.ownership === 'govt' || o.hospital.ayushman) : m.options;
  const excluded = m.excluded.slice(0, 8);
  const details = hasPatientDetails();
  $('#step-3').innerHTML = `
    <div class="card tight">
      <div class="row spread">
        <h2 style="margin:0">${s.hospitalsTitle}</h2>
        <label class="small row" style="gap:.3rem"><input type="checkbox" id="govtOnly" ${govtOnly ? 'checked' : ''}> ${s.govtOnly}</label>
      </div>
      <p class="small muted">${state.triage.icon} ${esc(state.triage.label)} · <span class="sev ${state.triage.severity}">${s.severity[state.triage.severity]}</span></p>
      <p class="small muted">${s.engineNote}</p>
      <p id="liveNote" class="small live-note hidden" role="status"></p>
      <div id="hospMap" class="map"></div>
    </div>
    ${m.stabilise ? `
      <div class="card stabilise" style="margin-top:1rem">
        <h3>⏱️ ${s.stabiliseTitle}</h3>
        <p class="small">${esc(s.stabiliseText(hName(m.stabilise.hospital), m.stabilise.etaMin))}</p>
        ${hospitalCard(m.stabilise)}
      </div>` : ''}
    <div style="margin-top:1rem" id="hospList">
      ${options.length ? options.slice(0, 5).map((o) => hospitalCard(o)).join('') : `<div class="card"><p>${s.noOptions}</p></div>`}
    </div>
    ${excluded.length ? `
    <details class="excluded card" style="margin-top:1rem">
      <summary>${s.excludedTitle(excluded.length)}</summary>
      <ul>${excluded.map((e) => `<li><b>${esc(hName(e.hospital))}</b> (${e.etaMin} ${s.min}) – ${e.excludedBecause.map((r) => esc(reasonText(r, state.lang, capLabel))).join(', ')}</li>`).join('')}</ul>
    </details>` : ''}
    <div class="card consent" style="margin-top:1rem">
      <h3>🔒 ${s.consentTitle}</h3>
      <p class="small">${s.consentLoc}</p>
      ${details ? `<label class="small row" style="align-items:flex-start;gap:.5rem"><input type="checkbox" id="consentDetails" ${state.consentDetails ? 'checked' : ''}> <span>${s.consentDetails}</span></label>` : ''}
    </div>
    <div style="position:sticky;bottom:1rem;margin-top:1rem">
      <button id="requestBtn" class="btn danger lg block" type="button" ${state.selected ? '' : 'disabled'}>🏥 ${s.requestAdmission}${state.selected ? ` – ${esc(hName(state.selected.hospital))}` : ''}</button>
    </div>`;

  if (hospMap) hospMap.remove();
  hospMap = createMap($('#hospMap'), state.location, 12);
  hospLayer = window.L.featureGroup().addTo(hospMap);
  marker(hospMap, state.location, '📍').addTo(hospLayer);
  for (const o of [...options.slice(0, 5), ...(m.stabilise ? [m.stabilise] : [])]) {
    marker(hospMap, o.hospital, o.recommended ? '🏥' : '🏨', `<b>${esc(hName(o.hospital))}</b><br>${o.etaMin} ${s.min}`).addTo(hospLayer);
  }
  if (hospLayer.getLayers().length > 1) hospMap.fitBounds(hospLayer.getBounds().pad(0.15));

  $('#govtOnly').onchange = (e) => { govtOnly = e.target.checked; renderHospitals(); };
  $('#consentDetails')?.addEventListener('change', (e) => { state.consentDetails = e.target.checked; });
  for (const card of document.querySelectorAll('.hosp')) {
    const pick = (e) => {
      if (e.target.closest('details')) return; // opening the score breakdown shouldn't re-select
      const id = card.dataset.id;
      state.selected = [...m.options, m.stabilise].find((o) => o && o.hospital.id === id);
      renderHospitals();
    };
    card.onclick = pick;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } };
  }
  $('#requestBtn').onclick = () => requestHospital(state.selected);
}

// ------------------------------------------------------------------ ⑤ hospital confirms acceptance
async function requestHospital(option) {
  if (!option) return;
  go(4);
  const s = t();
  state.selected = option;
  renderWaiting();
  try {
    if (!state.caseData) {
      readPatientForm();
      const consent = { patientDetails: Boolean(state.consentDetails && hasPatientDetails()) };
      state.caseData = await api.createCase({
        triage: state.triage, location: state.location, lang: state.lang,
        // Data minimisation: details only leave the phone with explicit consent.
        patient: consent.patientDetails ? state.patient : {},
        consent,
        contact: state.contact,
        alone: state.alone,
        vision: state.vision ? { engine: state.vision.engine, description: state.vision.description, findings: state.vision.findings } : null,
        text: state.text,
      });
      state.trackToken = state.caseData.trackToken;
      // Signed-in citizens can follow the case later from "My Cases" (read-only tracking token only).
      if (citizen.current()) {
        citizen.addCase({
          id: state.caseData.id, trackToken: state.trackToken, label: state.triage.label, icon: state.triage.icon,
          severity: state.triage.severity, createdAt: new Date().toISOString(),
        });
      }
      if (state.contact) aloneMark('contact');
      openStream(state.caseData.id);
    }
    const c = await api.requestAdmission(state.caseData.id, { hospitalId: option.hospital.id, option: stripOption(option) });
    aloneMark('requested');
    onCaseUpdate(c);
  } catch (e) {
    // Offline or server unreachable: we cannot get a confirmation, so help the
    // family act anyway – call 108 and go, clearly marked as NOT confirmed.
    const offline = !e.status || !navigator.onLine;
    if (offline && !state.caseData) saveOutbox(option);
    const contactPhone = state.contact ? String(state.contact.phone).replace(/[^\d+]/g, '') : '';
    $('#step-4').innerHTML = `
      <div class="card">
        <h2>📵 ${offline ? s.offlineTitle : s.genericError}</h2>
        ${offline && !state.caseData ? `<p class="offline-queued">⏳ ${s.offlineQueued}</p>` : `<p class="small">${esc(e.message)}</p>`}
        <p class="small redflag">${s.notConfirmedWarn}</p>
        <div class="row">
          <a class="btn danger" href="tel:108">📞 ${s.call108}</a>
          <a class="btn" href="sms:${contactPhone}?body=${encodeURIComponent(smsText())}">✉️ ${contactPhone ? s.offlineSmsContact : s.smsLocation}</a>
          <button class="btn primary" id="navAnyway">🗺️ ${s.navigate}</button>
        </div>
      </div>`;
    $('#navAnyway').onclick = () => { state.transportMode = 'own'; showNavigation(); };
  }
}

// ------------------------------------------------------------------ 📵 offline outbox
// A request made without network is kept on the phone and sent the moment the
// network returns (on this page), or offered again the next time the app opens.
const OUTBOX = 'medreach.outbox';
function saveOutbox(option) {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify({
      at: Date.now(), hospitalId: option.hospital.id, hospitalName: option.hospital.name, option: stripOption(option),
      payload: { triage: state.triage, location: state.location, lang: state.lang, patient: {}, consent: { patientDetails: false }, contact: state.contact, alone: state.alone, text: state.text },
    }));
  } catch { /* storage blocked */ }
}
const readOutbox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX)); } catch { return null; } };
const clearOutbox = () => { try { localStorage.removeItem(OUTBOX); } catch { /* ignore */ } };
window.addEventListener('online', () => {
  if (!readOutbox()) return;
  if (state.step === 4 && state.selected && !state.caseData) {
    const box = $('#step-4 .offline-queued');
    if (box) box.textContent = `📶 ${t().offlineSending}`;
    clearOutbox();
    requestHospital(state.selected);
  } else showOutboxBanner();
});
function showOutboxBanner() {
  const ob = readOutbox();
  const el = $('#outboxBanner');
  if (!el) return;
  if (!ob || Date.now() - ob.at > 6 * 60 * 60 * 1000) { if (ob) clearOutbox(); el.classList.add('hidden'); return; }
  const s = t();
  el.innerHTML = `<span>📵 ${esc(s.offlineResume(new Date(ob.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))} <b>${esc(ob.hospitalName)}</b></span>
    <span class="row"><button class="btn primary" id="obSend" type="button">${s.offlineSendNow}</button><button class="btn" id="obDrop" type="button">${s.offlineDiscard}</button></span>`;
  el.classList.remove('hidden');
  $('#obDrop').onclick = () => { clearOutbox(); el.classList.add('hidden'); };
  $('#obSend').onclick = async () => {
    try {
      const c = await api.createCase(ob.payload);
      await api.requestAdmission(c.id, { hospitalId: ob.hospitalId, option: ob.option });
      clearOutbox();
      if (citizen.current()) citizen.addCase({ id: c.id, trackToken: c.trackToken, label: ob.payload.triage?.label, icon: ob.payload.triage?.icon, severity: ob.payload.triage?.severity, createdAt: new Date().toISOString() });
      location.href = `/report?track=${encodeURIComponent(c.id)}&t=${encodeURIComponent(c.trackToken)}`;
    } catch (err) { el.querySelector('span').textContent = `📵 ${err.message || t().offlineTitle}`; }
  };
}

function stripOption(o) {
  // Only what the hospital needs to see.
  return { bedType: o.bedType, etaMin: o.etaMin, distanceKm: o.distanceKm, bed: o.bed, score: o.score };
}

function smsText() {
  const loc = state.location ? `https://maps.google.com/?q=${state.location.lat.toFixed(5)},${state.location.lng.toFixed(5)}` : '';
  return `EMERGENCY: ${state.triage?.label} (${state.triage?.severity}). Location: ${loc}`;
}

// Reported capacity → Referral status → Confirmed destination (never blurred together).
function ladder(c) {
  const s = t();
  const o = state.selected;
  const rc = c?.reportedCapacity;
  const f = freshness(rc?.verifiedAt ?? o.hospital.status?.verifiedAt);
  const fl = freshnessLabel(f, state.lang);
  const src = (rc?.source ?? o.hospital.status?.source) === 'dashboard' ? s.srcDashboard : s.srcSimulated;
  const by = rc?.verifiedBy?.roleLabel && rc.source === 'dashboard' ? ` · ${esc(rc.verifiedBy.roleLabel)}` : '';
  const req = c?.requests?.at(-1);
  const status = c?.status === 'requested' ? 'pending'
    : ['accepted', 'enroute', 'arrived'].includes(c?.status) ? 'accepted'
      : c?.status === 'declined' ? 'declined' : c?.status === 'timeout' ? 'timeout' : 'pending';
  const confirmed = status === 'accepted';
  const acc = c?.acceptedBy;
  return `
    <ol class="ladder">
      <li class="lad-${f.verified ? 'ok' : 'warn'}">
        <span class="lad-k">📊 ${s.ladderReported}</span>
        <span class="lad-v">${(rc?.bedType || o.bedType).toUpperCase()}: ${rc?.free ?? o.bed.freeNow} ${s.bedsReported}</span>
        <span class="lad-m">${fl.icon} ${esc(fl.text)} · ${esc(src)}${by}</span>
        <span class="lad-m">${s.capacityNote}</span>
      </li>
      <li class="lad-${status === 'accepted' ? 'ok' : status === 'pending' ? 'wait' : 'bad'}">
        <span class="lad-k">📨 ${s.ladderReferral}</span>
        <span class="lad-v">${s.refStatus[status]}</span>
        ${acc ? `<span class="lad-m">${s.by} ${esc(acc.roleLabel)}${acc.role !== 'simulated' && acc.name ? ` (${esc(acc.name)})` : ''} · ${time(c.acceptedAt)}</span>` : ''}
        ${!acc && req?.reason ? `<span class="lad-m">${esc(req.reason)}</span>` : ''}
      </li>
      <li class="lad-${confirmed ? 'ok' : 'wait'}">
        <span class="lad-k">📍 ${s.ladderDest}</span>
        <span class="lad-v">${confirmed ? `${esc(hName(o.hospital))}` : s.notYet}</span>
        ${confirmed && c.bay ? `<span class="lad-m">${s.receivingBay}: <b>${esc(c.bay)}</b></span>` : ''}
      </li>
    </ol>`;
}

function renderWaiting(note = '') {
  const s = t();
  const o = state.selected;
  $('#step-4').innerHTML = `
    <div class="card">
      <div class="spinner"></div>
      <h2 style="text-align:center">${s.waiting}</h2>
      <p style="text-align:center"><b>${esc(hName(o.hospital))}</b></p>
      <p class="small muted" style="text-align:center">${s.sentTo(esc(hName(o.hospital)))}</p>
      ${note ? `<p class="small" style="text-align:center;color:var(--serious)">${esc(note)}</p>` : ''}
    </div>
    <div class="card" id="ladderBox">${ladder(state.caseData)}</div>
    <div class="card"><ul class="timeline"></ul></div>`;
  renderTimeline();
}

function renderTimeline() {
  // Every step has its own timeline; update the one on the visible step.
  const el = $(`#step-${state.step} .timeline`);
  if (!el || !state.caseData) return;
  el.innerHTML = state.caseData.timeline.slice().reverse().map((e) =>
    `<li><time>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>${esc(e.text)}</li>`).join('');
  const lb = $(`#step-${state.step} #ladderBox`);
  if (lb) lb.innerHTML = ladder(state.caseData);
}

function openStream(id) {
  state.es?.close();
  state.es = api.streamCase(id);
  state.es.addEventListener('case', (e) => onCaseUpdate(JSON.parse(e.data)));
  state.es.addEventListener('ambulance', (e) => onAmbulance(JSON.parse(e.data)));
  state.es.addEventListener('vehicle', (e) => onVehicle(JSON.parse(e.data)));
}

async function onCaseUpdate(c) {
  state.caseData = { ...c, trackToken: state.trackToken };
  renderTimeline();
  const key = `${c.status}:${c.requests.length}`;
  if (state.handled.has(key)) return;
  const s = t();
  const current = c.requests.at(-1);
  if (c.status === 'accepted' && state.step === 4) {
    state.handled.add(key);
    aloneMark('accepted');
    $('#step-4').innerHTML = `
      <div class="card confirm-ok">
        <div class="big-check">✅</div>
        <h2 style="text-align:center">${s.accepted}</h2>
        <p style="text-align:center"><b>${esc(hName(state.selected.hospital))}</b><br>${esc(s.bayReady(c.bay))}</p>
      </div>
      <div class="card" id="ladderBox">${ladder(c)}</div>
      <div class="card"><ul class="timeline"></ul></div>`;
    renderTimeline();
    speak(`${s.accepted}. ${hName(state.selected.hospital)}. ${s.bayReady(c.bay)}`, state.lang);
    if (state.alone) {
      // Nobody to decide for them: request the ambulance automatically.
      setTimeout(async () => {
        state.transportMode = 'ambulance';
        try { state.caseData = { ...(await api.startTransport(c.id, 'ambulance')), trackToken: state.trackToken }; } catch { /* keep going */ }
        aloneMark('transport');
        showNavigation();
      }, 1500);
    } else {
      setTimeout(showTransport, 1800);
    }
  } else if ((c.status === 'declined' || c.status === 'timeout') && state.step === 4) {
    state.handled.add(key);
    // 🔁 Auto-escalate to the next best hospital – the family never has to start over.
    state.tried.push(current.hospitalId);
    const name = hName(state.selected.hospital);
    const note = c.status === 'declined' ? s.declined(name, current.reason || '-') : s.timedOut(name);
    const next = state.match.options.find((o) => !state.tried.includes(o.hospital.id));
    if (next) {
      state.selected = next;
      renderWaiting(note);
      api.requestAdmission(c.id, { hospitalId: next.hospital.id, option: stripOption(next) }).then(onCaseUpdate).catch(() => {});
    } else {
      findHospitals();
    }
  } else if (c.status === 'arrived' && state.step !== 7) {
    state.handled.add(key);
    showArrived();
  }
}

// ------------------------------------------------------------------ ⑥ transport
function showTransport() {
  go(5);
  const s = t();
  const tr = state.triage;
  const o = state.selected;
  // Ambulance is recommended when paramedic care on the way matters.
  const ambulanceBetter = tr.severity === 'critical' || ['trauma', 'pregnancy', 'snakebite', 'poisoning', 'collapse', 'drowning'].includes(tr.type) || tr.redFlags?.length;
  const ownEta = Math.round(o.etaMin * 1.15); // private vehicles don't get the siren advantage
  $('#step-5').innerHTML = `
    <div class="card">
      <h2>🚑 ${s.howTravel}</h2>
      <p class="small muted">${esc(hName(o.hospital))} · ${o.distanceKm} ${s.km}</p>
      <div class="choice-grid">
        <button class="choice ${ambulanceBetter ? 'rec' : ''}" data-mode="ambulance" type="button">
          <span class="emoji">🚑</span><b>${s.ambulance}</b>
          <span class="small">${tr.ambulanceType === 'JANANI' ? 'Janani Express' : tr.ambulanceType} · ${s.ownEta(o.etaMin)}</span>
          <span class="badge sim">${s.simulatedTag}</span>
          ${ambulanceBetter ? `<p class="small" style="color:var(--brand)">★ ${s.ambRec}</p>` : ''}
        </button>
        <button class="choice ${!ambulanceBetter ? 'rec' : ''}" data-mode="own" type="button">
          <span class="emoji">🚗</span><b>${s.ownVehicle}</b>
          <span class="small">${s.ownEta(ownEta)}</span>
          ${!ambulanceBetter ? `<p class="small" style="color:var(--brand)">★ ${s.ownRec}</p>` : ''}
        </button>
      </div>
      <p class="small muted" style="margin-top:.75rem">ℹ️ ${s.ambSimNote}</p>
      <a class="btn danger block" href="tel:108" style="margin-top:.5rem">📞 ${s.call108Direct}</a>
    </div>`;
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.onclick = async () => {
      state.transportMode = b.dataset.mode;
      b.disabled = true;
      try { state.caseData = { ...(await api.startTransport(state.caseData.id, state.transportMode)), trackToken: state.trackToken }; } catch { /* keep navigating */ }
      showNavigation();
    };
  }
}

// ------------------------------------------------------------------ ⑦ navigation
let navMap = null;
let ambMarker = null;
const routes = {};
let watchId = null;

function trackUrl() {
  if (!state.caseData || !state.trackToken) return '';
  const origin = /^https?:/.test(location.origin) ? location.origin : 'https://medreach.example';
  return `${origin}/report?track=${encodeURIComponent(state.caseData.id)}&t=${encodeURIComponent(state.trackToken)}`;
}

async function showNavigation() {
  go(6);
  const s = t();
  const h = state.selected.hospital;
  const tr = state.caseData?.transport;
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}&travelmode=driving`;
  const share = `🚑 Medreach: ${state.triage.label} – going to ${h.name}. ${s.liveStatus}: ${trackUrl() || gmaps}`;
  $('#step-6').innerHTML = `
    <div class="nav-banner" id="navBanner"><span class="arrow">⬆️</span><div><b id="navText">${esc(hName(h))}</b><span id="navSub" class="small"></span></div></div>
    <div class="card" style="margin-top:1rem">
      <div class="row spread">
        <div><span class="eta-big" id="etaBig">${tr?.etaMin ?? state.selected.etaMin}</span> ${s.min} <span class="muted small">${s.toHospital}</span></div>
        <span class="badge" id="ambBadge"></span>
      </div>
      <div id="navMap" class="map tall" style="margin-top:.5rem"></div>
      <p class="small muted hidden" id="routeNote">${s.routeFallback}</p>
      <div class="row" style="margin-top:.75rem">
        <button class="btn" id="voiceNavBtn" type="button">${s.voiceNav}</button>
        <a class="btn" href="${gmaps}" target="_blank" rel="noopener">🧭 ${s.openMaps}</a>
        <a class="btn" href="https://wa.me/${state.contact ? String(state.contact.phone).replace(/\D/g, '') : ''}?text=${encodeURIComponent(share)}" target="_blank" rel="noopener">👨‍👩‍👧 ${s.shareFamily}</a>
        ${state.caseData ? `<button class="btn ghost" id="previewTrack" type="button">👁 ${s.trackPreview}</button>` : ''}
      </div>
    </div>
    ${state.caseData ? `<div class="card" id="ladderBox">${ladder(state.caseData)}</div>` : `<div class="card"><p class="redflag small">${s.notConfirmedWarn}</p></div>`}
    <div class="card hidden" id="stepsCard"><ol class="steps-list" id="stepsList"></ol></div>
    <div class="card"><ul class="timeline"></ul></div>
    <button id="arrivedBtn" class="btn primary lg block" type="button" style="margin-top:1rem">✅ ${s.arrivedBtn}</button>`;
  renderTimeline();

  if (navMap) navMap.remove();
  navMap = createMap($('#navMap'), state.location, 13);
  const group = window.L.featureGroup().addTo(navMap);
  marker(navMap, state.location, '📍').addTo(group);
  marker(navMap, h, '🏥', esc(hName(h))).addTo(group);
  navMap.fitBounds(group.getBounds().pad(0.2));

  $('#voiceNavBtn').onclick = () => speak(routes.toHospital?.steps.length ? routes.toHospital.steps.slice(0, 4).map((x) => `${x.text}, ${x.distance}`) : [hName(h)], state.lang);
  $('#previewTrack')?.addEventListener('click', openTrackPreview);
  $('#arrivedBtn').onclick = async () => {
    if (state.caseData) { try { state.caseData = { ...(await api.markArrived(state.caseData.id)), trackToken: state.trackToken }; } catch { /* offline */ } }
    showArrived();
  };

  const main = await route(state.location, h, state.lang);
  routes.toHospital = main;
  window.L.polyline(main.coords, { color: '#0b7a75', weight: 6, opacity: 0.85 }).addTo(navMap);
  if (main.fallback) $('#routeNote')?.classList.remove('hidden');
  if (main.steps.length) {
    $('#stepsCard').classList.remove('hidden');
    $('#stepsList').innerHTML = main.steps.map((st) => `<li>${esc(st.text)} <span class="muted">· ${st.distance}</span></li>`).join('');
    showStep(main.steps[1] || main.steps[0]);
  }
  if (tr?.mode === 'ambulance') {
    routes.toPatient = await route(tr.from, state.location, state.lang);
    window.L.polyline(routes.toPatient.coords, { color: '#d62839', weight: 4, dashArray: '6 8' }).addTo(navMap);
    ambMarker = marker(navMap, tr.position, '🚑');
    onAmbulance(tr);
  } else {
    carMarker = marker(navMap, state.location, '🚗');
    if (tr) onVehicle(tr);
    followOwnVehicle();
  }
}

let carMarker = null;
// Own vehicle: the server drives it along the road route (demo) until the phone's
// GPS shows real movement; either way everyone sees the same position.
function onVehicle(tr) {
  if (!tr || tr.mode !== 'own' || state.step !== 6 || !tr.position) return;
  const s = t();
  if (Number.isFinite(tr.etaMin)) $('#etaBig').textContent = tr.etaMin;
  $('#ambBadge').textContent = `🚗 ${tr.gps ? s.vehicleGps : s.vehicleSim}`;
  carMarker?.setLatLng([tr.position.lat, tr.position.lng]);
}

function showStep(step) {
  if (!step) return;
  $('#navText').textContent = step.text;
  $('#navSub').textContent = ` · ${step.distance}`;
  $('#navBanner .arrow').textContent = ARROWS[step.modifier] || '⬆️';
}

function followOwnVehicle() {
  if (!('geolocation' in navigator) || state.locationNote !== 'gps') return;
  let last = 0;
  watchId = navigator.geolocation.watchPosition((p) => {
    const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (Date.now() - last < 10000) return; // share with the hospital every 10 s
    last = Date.now();
    const km = haversineKm(pos, state.selected.hospital) * 1.35;
    const etaMin = Math.max(1, Math.round((km / 25) * 60));
    $('#etaBig').textContent = etaMin;
    if (state.caseData) api.sendPosition(state.caseData.id, { ...pos, etaMin });
  }, () => {}, { enableHighAccuracy: true });
}

function onAmbulance(tr) {
  if (!tr || tr.mode !== 'ambulance' || state.step !== 6) return;
  const s = t();
  $('#etaBig').textContent = tr.etaMin;
  $('#ambBadge').textContent = `🚑 ${tr.ambulance.id} (${s.simulatedTag}) · ${s.ambPhase[tr.phase] || ''}`;
  if (!ambMarker) return;
  let pt = [tr.position.lat, tr.position.lng];
  // The server already moves the ambulance on real roads; otherwise follow our own route.
  if (!tr.onRoad && tr.phase === 'to_patient' && routes.toPatient && !routes.toPatient.fallback) pt = pointAlong(routes.toPatient.coords, tr.progress);
  if (!tr.onRoad && tr.phase === 'to_hospital' && routes.toHospital && !routes.toHospital.fallback) pt = pointAlong(routes.toHospital.coords, tr.progress);
  if (tr.phase === 'at_patient') pt = [state.location.lat, state.location.lng];
  ambMarker.setLatLng(pt);
  if (tr.phase === 'to_patient') $('#navSub').textContent = ` · ${s.ambOnWay(tr.ambulance.id, Math.max(0, tr.etaMin - (tr.etaToHospitalMin || 0) - 2))}`;
}

// ------------------------------------------------------------------ ⑧ confirmed hospital
function showArrived() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  stopSpeaking();
  go(7);
  const s = t();
  const h = state.selected.hospital;
  const c = state.caseData;
  $('#step-7').innerHTML = `
    <div class="card confirm-ok">
      <div class="big-check">🏥</div>
      <h2 style="text-align:center">${s.confirmedTitle}</h2>
      <p style="text-align:center"><b style="font-size:1.2rem">${esc(hName(h))}</b><br>${esc(h.area)}${c?.bay ? `<br>${s.receivingBay}: ${esc(c.bay)}` : ''}</p>
      <p class="small" style="text-align:center">${s.handedOver}</p>
      ${c ? `<p style="text-align:center">${s.caseId}: <b>${esc(c.id)}</b></p>` : ''}
      <p class="small muted" style="text-align:center">🔒 ${s.retentionNote}</p>
    </div>
    ${c ? `<div class="card" id="ladderBox">${ladder(c)}</div>` : ''}
    <div class="card"><ul class="timeline"></ul></div>
    <button class="btn block" id="newBtn" type="button" style="margin-top:1rem">${s.newEmergency}</button>`;
  renderTimeline();
  $('#newBtn').onclick = () => { state.es?.close(); location.reload(); };
}

// ------------------------------------------------------------------ 👨‍👩‍👧 trusted-contact tracking view (no medical details)
function trackHtml(d) {
  const s = t();
  const steps = [
    ['requested', s.trk.requested], ['accepted', s.trk.accepted], ['enroute', s.trk.enroute], ['arrived', s.trk.arrived],
  ];
  const order = ['new', 'requested', 'declined', 'timeout', 'accepted', 'enroute', 'arrived'];
  const reached = (k) => order.indexOf(d.status) >= order.indexOf(k) && !(k === 'accepted' && ['declined', 'timeout'].includes(d.status));
  return `
    <div class="card">
      <h2>👨‍👩‍👧 ${s.trackTitle}</h2>
      <p class="small muted">${s.caseId} ${esc(d.id)} · ${d.alone ? `🆘 ${s.aloneTag} · ` : ''}${esc(d.emergency || '')}</p>
      <ul class="alone-list">${steps.map(([k, label]) => `<li class="${reached(k) ? 'done' : ''}">${reached(k) ? '✅' : '⏳'} ${esc(label)}</li>`).join('')}</ul>
      ${d.hospital ? `<p>🏥 <b>${esc(d.hospital.name)}</b> · ${esc(d.hospital.area)}${d.bay ? ` · ${s.receivingBay} ${esc(d.bay)}` : ''}</p>
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${d.hospital.lat},${d.hospital.lng}">🧭 ${s.openMaps}</a>` : ''}
      ${d.transport?.etaMin !== undefined ? `<p>🚑 ${d.transport.mode === 'ambulance' ? `${esc(d.transport.ambulance)} (${s.simulatedTag})` : s.ownVehicle} · ${s.eta} ${d.transport.etaMin} ${s.min}</p>` : ''}
      <p class="small muted">🔒 ${s.trackNoMedical}</p>
    </div>
    <div class="card"><ul class="timeline">${d.timeline.slice().reverse().map((e) => `<li><time>${time(e.at)}</time>${esc(e.text)}</li>`).join('')}</ul></div>`;
}

async function openTrackPreview() {
  const dlg = $('#trackDialog');
  const body = $('#trackBody');
  const refresh = async () => { try { body.innerHTML = trackHtml(await api.getTrack(state.caseData.id, state.trackToken)); } catch (e) { body.textContent = e.message; } };
  await refresh();
  const timer = setInterval(refresh, 2000);
  dlg.addEventListener('close', () => clearInterval(timer), { once: true });
  dlg.showModal();
}

async function bootTrackPage(id, token) {
  document.querySelectorAll('.step, #stepper, #stepCaption').forEach((el) => el.classList.add('hidden'));
  const box = $('#trackPage');
  box.classList.remove('hidden');
  const render = (d) => { box.innerHTML = trackHtml(d); };
  try {
    render(await api.getTrack(id, token));
    const es = api.streamTrack(id, token);
    es.addEventListener('case', (e) => render(JSON.parse(e.data)));
  } catch (e) {
    box.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  // Embedded in the citizen dashboard: the dashboard already shows branding & navigation.
  if (new URLSearchParams(location.search).get('embed') === '1' || window.self !== window.top) document.body.classList.add('embedded');
  state.config = await api.getConfig();
  applyI18n();
  if (state.config.dataMode !== 'live') $('#demoBanner').classList.remove('hidden');
  if (state.config.offline || !navigator.onLine) setOffline(true);

  // Signed-in citizen: link to the dashboard and pre-fill saved health details and
  // primary contact (still shared with a hospital only if the consent box is ticked).
  const me = citizen.current();
  if (me) {
    $('#portalLink').textContent = `👤 ${me.name.split(' ')[0]} · Dashboard`;
    $('#portalLink').href = '/citizen';
    const prof = citizen.profile();
    const h = prof.health || {};
    if (Object.values(h).some((v) => (Array.isArray(v) ? v.length : v))) {
      state.patient = { name: me.name, ...h };
      fillPatientForm();
    }
    if (prof.contacts?.[0]) { state.contact = { name: prof.contacts[0].name, phone: prof.contacts[0].phone }; renderContact(); }
  }

  for (const b of document.querySelectorAll('[data-lang]')) {
    b.onclick = () => {
      state.lang = b.dataset.lang;
      store.set('sehat.lang', state.lang);
      applyI18n();
      renderBack();
      showOutboxBanner();
      if (state.step === 1 && state.triage) runTriage();
    };
  }
  $('#privacyBtn').onclick = () => $('#privacyDialog').showModal();
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => b.closest('dialog').close();

  const params = new URLSearchParams(location.search);
  if (params.get('track')) { $('#backBtn')?.closest('.flow-nav')?.classList.add('hidden'); bootTrackPage(params.get('track'), params.get('t') || ''); return; }
  $('#backBtn').onclick = goBack;
  renderBack();
  showOutboxBanner();

  startGps();
  api.hospitals(); // warm the offline cache
  $('#aloneBtn').onclick = startAlone;
  $('#micBtn').onclick = toggleMic;
  $('#chips').onclick = (e) => { const c = e.target.closest('[data-type]'); if (c) selectChip(c.dataset.type); };
  $('#photoInput').onchange = (e) => onPhoto(e.target.files[0]);
  $('#scanInput').onchange = (e) => onScan(e.target.files[0]);
  $('#helpBtn').onclick = runTriage;
  $('#describe').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runTriage(); });
  $('#demoLocBtn').onclick = () => { $('#locStatus').textContent = state.config.demoLocation?.label || ''; setLocation(state.config.demoLocation, 'demo'); };
  $('#confirmLocBtn').onclick = () => findHospitals();
  if (location.hash === '#alone') startAlone();

  try {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch { /* not available, e.g. when opened as a local file */ }
}

boot();
