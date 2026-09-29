// Sehat Setu – citizen app. Each step below is one box of the flowchart:
//
//  0 🚨 Sudden emergency   – voice / text / quick chip (+ photo, + health card)
//  1 🧠 AI understands     – type, severity, danger signs, first aid, follow-up question
//  2 📍 Location           – GPS (started in the background at app launch)
//  3 🏥 Suitable hospitals – capability + live status → distance + ETA → ranked options
//  4 🏥 Hospital confirms  – real-time accept/decline, auto-escalates to the next option
//  5 🚑 Transport          – 108 ambulance or own vehicle
//  6 🗺️ Navigation         – road route, turn-by-turn, voice, live ambulance tracking
//  7 🏥 Confirmed hospital – handover done

import { STRINGS, reasonText } from './i18n.js';
import * as api from './api.js';
import { listen, speak, stopSpeaking, isSpeaking, voiceInputSupported } from './voice.js';
import { fileToDataUrl, analysePhoto } from './vision.js';
import { scanHealthDocument } from './ocr.js';
import { createMap, marker, route, pointAlong, ARROWS } from './map.js';
import { EMERGENCIES, FOLLOW_UPS } from '/shared/triage.js';
import { capLabel, CAPABILITIES } from '/shared/capabilities.js';
import { haversineKm } from '/shared/predict.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function storedLang() {
  try { return localStorage.getItem('sehat.lang'); } catch { return null; }
}

const state = {
  lang: storedLang() || (navigator.language?.startsWith('hi') ? 'hi' : 'en'),
  step: 0,
  text: '',
  usedVoice: false,
  hintType: null,
  answers: {},
  photo: null,
  vision: null,
  patient: {},
  triage: null,
  location: null,
  locationNote: '',
  gps: null,
  match: null,
  selected: null,
  tried: [],
  caseData: null,
  es: null,
  handled: new Set(),
  transportMode: null,
  config: null,
};

const t = () => STRINGS[state.lang];
const hName = (h) => (state.lang === 'hi' && h.nameHi ? h.nameHi : h.name);

// ------------------------------------------------------------------ shell
function applyI18n() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const v = t()[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  }
  $('#describe').placeholder = t().describePh;
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  renderChips();
  renderStepper();
}

function renderStepper() {
  $('#stepper').innerHTML = t().steps.map((_, i) =>
    `<li class="${i < state.step ? 'done' : i === state.step ? 'active' : ''}"></li>`).join('');
  $('#stepCaption').textContent = `${state.step + 1}/8 · ${t().steps[state.step]}`;
}

function go(step) {
  state.step = step;
  document.querySelectorAll('.step').forEach((s) => s.classList.toggle('hidden', s.id !== `step-${step}`));
  renderStepper();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setOffline(off) { $('#offline').classList.toggle('hidden', !off); }
window.addEventListener('online', () => setOffline(false));
window.addEventListener('offline', () => setOffline(true));

// ------------------------------------------------------------------ 📍 start GPS immediately (saves precious seconds)
function startGps() {
  if (!('geolocation' in navigator)) { state.gps = Promise.resolve({ error: 'unsupported' }); return; }
  state.gps = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => resolve({ error: e.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
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
  const tag = state.vision.engine === 'claude-vision' ? t().engineAi : t().heuristic;
  $('#photoResult').innerHTML = `
    <img class="thumb" src="${state.photo}" alt="">
    <p><b>${t().photoFindings}</b> <span class="engine-badge">${esc(tag)}</span><br>${esc(state.vision.description || state.vision.findings.join('; '))}</p>`;
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

function selectChip(type) {
  state.hintType = state.hintType === type ? null : type;
  renderChips();
}

// ------------------------------------------------------------------ ② AI understands
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
    if (state.triage.offline) setOffline(true);
    renderTriage();
    if (state.usedVoice) speak([state.triage.label, ...state.triage.firstAid], state.lang);
  } catch (e) {
    $('#step-1').innerHTML = `<div class="card"><p>${esc(e.message || t().genericError)}</p><button class="btn" id="backEdit">${t().notRight}</button></div>`;
    $('#backEdit').onclick = () => go(0);
  }
}

function renderTriage() {
  const tr = state.triage;
  const s = t();
  const qId = tr.followUps?.[0];
  const q = qId ? FOLLOW_UPS[qId] : null;
  const engine = tr.engine === 'claude' ? s.engineAi : s.engineRules;
  $('#step-1').innerHTML = `
    <div class="card">
      <div class="row spread">
        <span class="engine-badge">🧠 ${esc(engine)}</span>
        <span class="small muted">${s.confidence} ${Math.round(tr.confidence * 100)}%</span>
      </div>
      <div class="card-title" style="margin-top:.5rem"><span class="icon">${tr.icon}</span><h2>${esc(tr.label)}</h2></div>
      <span class="sev ${tr.severity}">● ${s.severity[tr.severity]}</span>
      <div class="bar-meter" style="margin:.6rem 0" title="severity"><i style="width:${tr.severityScore}%;background:var(--${tr.severity})"></i></div>
      ${tr.redFlagLabels?.length ? `<p class="redflag">⚠️ ${s.redFlags}: ${tr.redFlagLabels.map(esc).join(', ')}</p>` : ''}
      <h3 class="small muted">${s.needs}</h3>
      <div class="cap-list">${tr.required.map((c) => `<span class="cap">${CAPABILITIES[c]?.icon || ''} ${esc(capLabel(c, state.lang))}</span>`).join('')}</div>
    </div>

    ${q ? `
    <div class="card question">
      <h3>💬 ${s.askNext}</h3>
      <p>${esc(q.q[state.lang])}</p>
      <div class="chips">${q.options.map((o) => `<button class="chip" data-answer="${qId}" data-value="${o.value}">${esc(o.label[state.lang])}</button>`).join('')}</div>
    </div>` : tr.aiQuestion ? `<div class="card question"><h3>💬 ${s.askNext}</h3><p>${esc(tr.aiQuestion)}</p><p class="small muted">${s.notRight}</p></div>` : ''}

    <div class="card">
      <div class="row spread">
        <h2 style="margin:0">🩹 ${s.doNow}</h2>
        <button class="btn ghost" id="readBtn" type="button">${isSpeaking() ? s.stopReading : s.readAloud}</button>
      </div>
      <ol class="firstaid">${tr.firstAid.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    </div>

    <div class="row" style="margin-top:1rem">
      <button class="btn ghost" id="editBtn" type="button">✏️ ${s.notRight}</button>
      <span class="grow"></span>
      <button class="btn primary lg" id="toLocBtn" type="button">🏥 ${s.continue}</button>
    </div>`;

  for (const b of document.querySelectorAll('[data-answer]')) {
    b.onclick = () => { state.answers[b.dataset.answer] = b.dataset.value; runTriage(); };
  }
  $('#readBtn').onclick = () => {
    if (isSpeaking()) { stopSpeaking(); $('#readBtn').textContent = s.readAloud; return; }
    $('#readBtn').textContent = s.stopReading;
    speak(tr.firstAid, state.lang).then(() => { const b = $('#readBtn'); if (b) b.textContent = s.readAloud; });
  };
  $('#editBtn').onclick = () => { stopSpeaking(); go(0); };
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
  if (state.location) { setLocation(state.location, state.locationNote); return; }
  const g = await state.gps;
  if (g.error) {
    $('#locStatus').textContent = s.locDenied;
    setLocation(demo, 'demo');
  } else if (haversineKm(g, demo) > 120) {
    $('#locStatus').textContent = s.farAway;
    setLocation(demo, 'demo');
  } else {
    setLocation(g, 'gps');
  }
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

async function findHospitals() {
  go(3);
  const s = t();
  $('#step-3').innerHTML = `<div class="card"><div class="spinner"></div><p style="text-align:center">${s.finding}</p></div>`;
  state.match = await api.match({
    triage: state.triage, location: state.location, lang: state.lang, mode: 'ambulance', excludeIds: state.tried,
  });
  if (state.match.offline) setOffline(true);
  state.selected = state.match.options[0] || state.match.stabilise || null;
  renderHospitals();
}

function capChips(o) {
  return o.capChecks.map((c) => {
    const cls = c.live ? 'ok' : c.has ? 'off' : 'no';
    const mark = c.live ? '✓' : c.has ? '⏸' : '✗';
    return `<span class="cap ${cls}">${mark} ${esc(capLabel(c.cap, state.lang))}</span>`;
  }).join('');
}

function hospitalCard(o, extraClass = '') {
  const s = t();
  const h = o.hospital;
  const selected = state.selected?.hospital.id === h.id;
  return `
    <article class="hosp ${extraClass}" data-id="${h.id}" aria-selected="${selected}" tabindex="0">
      <div class="top">
        <div>
          <div class="row" style="gap:.3rem">
            ${o.recommended ? `<span class="badge rec">★ ${s.recommended}</span>` : ''}
            <span class="badge ${h.ownership === 'govt' ? 'govt' : ''}">${h.ownership === 'govt' ? s.govt : s.private}</span>
            ${h.ayushman ? `<span class="badge pmjay">${s.pmjay}</span>` : ''}
          </div>
          <h3 style="margin-top:.3rem">${esc(hName(h))}</h3>
          <div class="meta">${esc(h.area)} · ER: ${esc(o.erStatus)}</div>
        </div>
        <div class="score">${o.score}<small>match</small></div>
      </div>
      <div class="kpis">
        <div class="kpi"><b>${o.etaMin}</b><span>${s.min} ${s.eta}</span></div>
        <div class="kpi"><b>${o.distanceKm}</b><span>${s.km}</span></div>
        <div class="kpi"><b>${Math.round(o.bed.probability * 100)}%</b><span>${o.bedType.toUpperCase()} ${s.bedProb}</span></div>
        <div class="kpi"><b>${o.erWaitMin}</b><span>${s.min} ${s.erWait}</span></div>
      </div>
      <div class="cap-list">${capChips(o)}</div>
      ${o.reasons ? `<ul class="reasons">${o.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    </article>`;
}

function renderHospitals() {
  const s = t();
  const m = state.match;
  const options = govtOnly ? m.options.filter((o) => o.hospital.ownership === 'govt' || o.hospital.ayushman) : m.options;
  const excluded = m.excluded.slice(0, 8);
  $('#step-3').innerHTML = `
    <div class="card tight">
      <div class="row spread">
        <h2 style="margin:0">${s.hospitalsTitle}</h2>
        <label class="small row" style="gap:.3rem"><input type="checkbox" id="govtOnly" ${govtOnly ? 'checked' : ''}> ${s.govtOnly}</label>
      </div>
      <p class="small muted">${state.triage.icon} ${esc(state.triage.label)} · <span class="sev ${state.triage.severity}">${s.severity[state.triage.severity]}</span></p>
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
    <div style="position:sticky;bottom:1rem;margin-top:1rem">
      <button id="requestBtn" class="btn danger lg block" type="button" ${state.selected ? '' : 'disabled'}>🏥 ${s.requestAdmission}${state.selected ? ` – ${esc(hName(state.selected.hospital))}` : ''}</button>
    </div>`;

  // Map with patient + hospitals
  if (hospMap) hospMap.remove();
  hospMap = createMap($('#hospMap'), state.location, 12);
  hospLayer = window.L.featureGroup().addTo(hospMap);
  marker(hospMap, state.location, '📍').addTo(hospLayer);
  for (const o of [...options.slice(0, 5), ...(m.stabilise ? [m.stabilise] : [])]) {
    marker(hospMap, o.hospital, o.recommended ? '🏥' : '🏨', `<b>${esc(hName(o.hospital))}</b><br>${o.etaMin} ${s.min}`).addTo(hospLayer);
  }
  if (hospLayer.getLayers().length > 1) hospMap.fitBounds(hospLayer.getBounds().pad(0.15));

  $('#govtOnly').onchange = (e) => { govtOnly = e.target.checked; renderHospitals(); };
  for (const card of document.querySelectorAll('.hosp')) {
    const pick = () => {
      const id = card.dataset.id;
      state.selected = [...m.options, m.stabilise].find((o) => o && o.hospital.id === id);
      renderHospitals();
    };
    card.onclick = pick;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
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
      state.caseData = await api.createCase({
        triage: state.triage, location: state.location, patient: state.patient, lang: state.lang,
        vision: state.vision ? { engine: state.vision.engine, description: state.vision.description, findings: state.vision.findings } : null,
        text: state.text,
      });
      openStream(state.caseData.id);
    }
    const c = await api.requestAdmission(state.caseData.id, { hospitalId: option.hospital.id, option: stripOption(option) });
    onCaseUpdate(c);
  } catch (e) {
    // Offline or server unreachable: we cannot get a confirmation, so help the
    // family act anyway – call 108 / call ahead and navigate.
    $('#step-4').innerHTML = `
      <div class="card">
        <h2>📵 ${s.genericError}</h2>
        <p class="small">${esc(e.message)}</p>
        <div class="row">
          <a class="btn danger" href="tel:108">📞 ${s.call108}</a>
          <a class="btn" href="sms:108?body=${encodeURIComponent(smsText())}">✉️ ${s.smsLocation}</a>
          <button class="btn primary" id="navAnyway">🗺️ ${s.navigate}</button>
        </div>
      </div>`;
    $('#navAnyway').onclick = () => { state.transportMode = 'own'; showNavigation(); };
  }
}

function stripOption(o) {
  // Only what the hospital needs to see.
  return { bedType: o.bedType, etaMin: o.etaMin, distanceKm: o.distanceKm, bed: o.bed, score: o.score };
}

function smsText() {
  const loc = state.location ? `https://maps.google.com/?q=${state.location.lat.toFixed(5)},${state.location.lng.toFixed(5)}` : '';
  return `EMERGENCY: ${state.triage?.label} (${state.triage?.severity}). Location: ${loc}`;
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
    <div class="card"><ul class="timeline"></ul></div>`;
  renderTimeline();
}

function renderTimeline() {
  // Every step has its own timeline; update the one on the visible step.
  const el = $(`#step-${state.step} .timeline`);
  if (!el || !state.caseData) return;
  el.innerHTML = state.caseData.timeline.slice().reverse().map((e) =>
    `<li><time>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>${esc(e.text)}</li>`).join('');
}

function openStream(id) {
  state.es?.close();
  state.es = api.streamCase(id);
  state.es.addEventListener('case', (e) => onCaseUpdate(JSON.parse(e.data)));
  state.es.addEventListener('ambulance', (e) => onAmbulance(JSON.parse(e.data)));
}

function onCaseUpdate(c) {
  state.caseData = c;
  renderTimeline();
  const key = `${c.status}:${c.requests.length}`;
  if (state.handled.has(key)) return;
  const s = t();
  const current = c.requests.at(-1);
  if (c.status === 'accepted' && state.step === 4) {
    state.handled.add(key);
    $('#step-4').innerHTML = `
      <div class="card confirm-ok">
        <div class="big-check">✅</div>
        <h2 style="text-align:center">${s.accepted}</h2>
        <p style="text-align:center"><b>${esc(hName(state.selected.hospital))}</b><br>${esc(s.bayReady(c.bay))}</p>
      </div>
      <div class="card"><ul class="timeline"></ul></div>`;
    renderTimeline();
    speak(`${s.accepted}. ${hName(state.selected.hospital)}. ${s.bayReady(c.bay)}`, state.lang);
    setTimeout(showTransport, 1800);
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
  } else if (c.status === 'enroute' || c.status === 'arrived') {
    if (c.status === 'arrived' && state.step !== 7) { state.handled.add(key); showArrived(); }
    renderNavStatus();
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
          ${ambulanceBetter ? `<p class="small" style="color:var(--brand)">★ ${s.ambRec}</p>` : ''}
        </button>
        <button class="choice ${!ambulanceBetter ? 'rec' : ''}" data-mode="own" type="button">
          <span class="emoji">🚗</span><b>${s.ownVehicle}</b>
          <span class="small">${s.ownEta(ownEta)}</span>
          ${!ambulanceBetter ? `<p class="small" style="color:var(--brand)">★ ${s.ownRec}</p>` : ''}
        </button>
      </div>
    </div>`;
  for (const b of document.querySelectorAll('[data-mode]')) {
    b.onclick = async () => {
      state.transportMode = b.dataset.mode;
      b.disabled = true;
      try { state.caseData = await api.startTransport(state.caseData.id, state.transportMode); } catch { /* keep navigating */ }
      showNavigation();
    };
  }
}

// ------------------------------------------------------------------ ⑦ navigation
let navMap = null;
let ambMarker = null;
let routes = {};
let watchId = null;

async function showNavigation() {
  go(6);
  const s = t();
  const h = state.selected.hospital;
  const tr = state.caseData?.transport;
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}&travelmode=driving`;
  const shareText = `🚑 Sehat Setu: ${state.triage.label} – going to ${h.name}${state.caseData ? ` (Case ${state.caseData.id})` : ''}. ${gmaps}`;
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
        <a class="btn" href="https://wa.me/?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">👨‍👩‍👧 ${s.shareFamily}</a>
      </div>
    </div>
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

  const main = await route(state.location, h, state.lang);
  routes.toHospital = main;
  window.L.polyline(main.coords, { color: '#0b7a75', weight: 6, opacity: 0.85 }).addTo(navMap);
  if (main.fallback) $('#routeNote').classList.remove('hidden');
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
    followOwnVehicle();
  }

  $('#voiceNavBtn').onclick = () => speak(main.steps.length ? main.steps.slice(0, 4).map((x) => `${x.text}, ${x.distance}`) : [hName(h)], state.lang);
  $('#arrivedBtn').onclick = async () => {
    if (state.caseData) { try { state.caseData = await api.markArrived(state.caseData.id); } catch { /* offline */ } }
    showArrived();
  };
  renderNavStatus();
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
  $('#ambBadge').textContent = `🚑 ${tr.ambulance.id} · ${s.ambPhase[tr.phase] || ''}`;
  if (!ambMarker) return;
  let pt = [tr.position.lat, tr.position.lng];
  if (tr.phase === 'to_patient' && routes.toPatient && !routes.toPatient.fallback) pt = pointAlong(routes.toPatient.coords, tr.progress);
  if (tr.phase === 'to_hospital' && routes.toHospital && !routes.toHospital.fallback) pt = pointAlong(routes.toHospital.coords, tr.progress);
  if (tr.phase === 'at_patient') pt = [state.location.lat, state.location.lng];
  ambMarker.setLatLng(pt);
  if (tr.phase === 'to_patient') $('#navSub').textContent = ` · ${s.ambOnWay(tr.ambulance.id, Math.max(0, tr.etaMin - (tr.etaToHospitalMin || 0) - 2))}`;
}

function renderNavStatus() {
  renderTimeline();
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
      <p style="text-align:center"><b style="font-size:1.2rem">${esc(hName(h))}</b><br>${esc(h.area)}${c?.bay ? `<br>${esc(c.bay)}` : ''}</p>
      <p class="small" style="text-align:center">${s.handedOver}</p>
      ${c ? `<p style="text-align:center">${s.caseId}: <b>${esc(c.id)}</b></p>` : ''}
    </div>
    <div class="card"><ul class="timeline"></ul></div>
    <button class="btn block" id="newBtn" type="button" style="margin-top:1rem">${s.newEmergency}</button>`;
  renderTimeline();
  $('#newBtn').onclick = () => { state.es?.close(); location.reload(); };
}

// ------------------------------------------------------------------ boot
async function boot() {
  startGps();
  state.config = await api.getConfig();
  if (state.config.offline || !navigator.onLine) setOffline(true);
  api.hospitals(); // warm the offline cache
  applyI18n();

  for (const b of document.querySelectorAll('[data-lang]')) {
    b.onclick = () => {
      state.lang = b.dataset.lang;
      try { localStorage.setItem('sehat.lang', state.lang); } catch { /* ignore */ }
      applyI18n();
      if (state.step === 1 && state.triage) runTriage();
    };
  }
  $('#micBtn').onclick = toggleMic;
  $('#chips').onclick = (e) => { const c = e.target.closest('[data-type]'); if (c) selectChip(c.dataset.type); };
  $('#photoInput').onchange = (e) => onPhoto(e.target.files[0]);
  $('#scanInput').onchange = (e) => onScan(e.target.files[0]);
  $('#helpBtn').onclick = runTriage;
  $('#describe').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runTriage(); });
  $('#demoLocBtn').onclick = () => { $('#locStatus').textContent = state.config.demoLocation?.label || ''; setLocation(state.config.demoLocation, 'demo'); };
  $('#confirmLocBtn').onclick = findHospitals;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
