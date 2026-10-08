// Practice 108 control room console: watches incidents arriving from Medreach,
// shows the fleet and lets a dispatcher (with the key) assign or cancel.
import { esc } from './icons.js';
import { LiveMap, legend } from './livemap.js';

const $ = (s) => document.querySelector(s);
const KEY = 'medreach.practiceCad.key';
let key = (() => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } })();
let map = null;
let fitted = false;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}
const live = (ok, text) => { $('#live').classList.toggle('ok', ok); $('#liveText').textContent = text; };
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const STATUS = {
  received: ['Received', 'amber'], waiting_for_unit: ['Waiting for a unit', 'amber'], assigned: ['Unit assigned', 'blue'],
  enroute_to_patient: ['To patient', 'blue'], at_patient: ['At patient', 'blue'], patient_on_board: ['Patient on board', 'blue'],
  to_hospital: ['To hospital', 'blue'], arrived: ['Arrived', 'green'], cancelled: ['Cancelled', 'red'],
};

function renderKeyState() {
  $('#keyState').textContent = key
    ? 'Actions unlocked for this tab. A wrong key is refused by the server.'
    : 'Without the key you can watch; incidents are assigned automatically after a few seconds.';
}

function incidentCard(r) {
  const [label, tone] = STATUS[r.status] || [r.status, 'gray'];
  return `
    <article class="panel pc-inc ${r.closed ? 'closed' : ''}">
      <div class="row spread">
        <div class="row"><b class="mono">${esc(r.id)}</b><span class="pill ${r.priority === 'P1' ? 'red' : r.priority === 'P2' ? 'amber' : 'gray'}">${esc(r.priority)}</span><span class="pill gray">${esc(r.service)} · ${esc(r.ambulanceType)}</span></div>
        <span class="pill ${tone}">${esc(label)}</span>
      </div>
      <p class="pc-what"><b>${esc(r.complaint.label || 'Emergency')}</b> (${esc(r.complaint.severity || '?')})${r.complaint.personAlone ? ' · <b class="pc-alone">person is alone</b>' : ''}</p>
      <div class="pc-kv">
        <span>Pick-up (≈1 km)</span><b>${r.pickup.lat.toFixed(2)}, ${r.pickup.lng.toFixed(2)}</b>
        <span>Destination</span><b>${esc(r.destination.name)}${r.destination.bay ? ` · bay ${esc(r.destination.bay)}` : ''} <span class="pill green">already accepted</span></b>
        <span>Unit</span><b>${r.unit ? `${esc(r.unit.id)} (${esc(r.unit.type)}) from ${esc(r.unit.base)}` : '—'}${r.assignedBy ? ` <small class="muted">by ${esc(r.assignedBy)}</small>` : ''}</b>
        <span>ETA to hospital</span><b>${Number.isFinite(r.etaMin) ? `${r.etaMin} min` : '—'}</b>
        <span>Call-back</span><b>${esc(r.callback || '—')}</b>
        <span>Medreach ref</span><b class="mono">${esc(r.ref)}</b>
        <span>Last update to Medreach</span><b>${esc(r.delivery || '—')}</b>
      </div>
      <details><summary class="small">Log (${r.history.length})</summary><ul class="pc-log">${r.history.slice().reverse().map((h) => `<li><span class="muted">${time(h.at)}</span> ${esc(h.text)}</li>`).join('')}</ul></details>
      ${r.closed ? '' : `<div class="row pc-actions">
        ${r.unit ? '' : `<button class="b sm primary" data-act="assign" data-id="${esc(r.id)}" ${key ? '' : 'disabled'}>Assign nearest unit now</button>`}
        <button class="b sm danger" data-act="cancel" data-id="${esc(r.id)}" ${key ? '' : 'disabled'}>Cancel incident</button>
      </div>`}
    </article>`;
}

function drawMap(data) {
  if (!window.L) return;
  if (!map) {
    map = new LiveMap($('#map'), { lat: 23.2599, lng: 77.4126 }, 9);
    $('#legend').innerHTML = legend([['ambulance', 'Ambulance'], ['patient', 'Pick-up'], ['dest', 'Accepted hospital']]);
  }
  const keep = new Set();
  const busy = new Map();
  for (const r of data.incidents.filter((x) => !x.closed)) {
    map.set(`p:${r.id}`, r.pickup, 'patient', { text: '!', popup: `<b>${esc(r.id)}</b><br>${esc(r.complaint.label)}` });
    map.set(`d:${r.id}`, r.destination, 'dest', { text: 'H', popup: `<b>${esc(r.destination.name)}</b><br>accepted` });
    keep.add(`p:${r.id}`); keep.add(`d:${r.id}`);
    if (r.unit && r.position) {
      busy.set(r.unit.id, r);
      map.set(`u:${r.unit.id}`, r.position, 'ambulance', { text: '🚑', z: 900, popup: `<b>${esc(r.unit.id)}</b> · ${esc(STATUS[r.status]?.[0] || r.status)}<br>ETA ${r.etaMin} min` });
      keep.add(`u:${r.unit.id}`);
      if (r.path) { map.route(`r:${r.id}`, r.path, r.position, r.phase === 'to_hospital' ? r.destination : r.pickup, r.phase === 'to_hospital' ? '#e11d48' : '#f59e0b'); keep.add(`r:${r.id}`); }
    }
  }
  for (const a of data.fleet) {
    if (busy.has(a.id)) continue;
    map.set(`u:${a.id}`, a, 'ambulance', { text: '🚑', popup: `<b>${esc(a.id)}</b> (${esc(a.type)})<br>${esc(a.base)} · ${a.available ? 'free' : 'on a call'}` });
    keep.add(`u:${a.id}`);
  }
  for (const prefix of ['p:', 'd:', 'u:', 'r:']) map.prune(prefix, keep);
  if (!fitted) { map.fit(true); fitted = true; }
}

async function load() {
  let res;
  try {
    res = await fetch('/api/practice-cad/incidents', { headers: key ? { 'X-Dispatcher-Key': key } : {} });
  } catch {
    live(false, 'Offline');
    return;
  }
  if (res.status === 404) {
    live(false, 'Off');
    $('#board').classList.add('hidden');
    $('#off').classList.remove('hidden');
    let checks = null;
    try { checks = (await (await fetch('/api/practice-cad/status')).json()).checks; } catch { /* older server */ }
    const want = {
      SEHAT_PRACTICE_CAD: 'on',
      SEHAT_EMS_SECRET: 'a long random secret',
      SEHAT_EMS_URL: `${location.origin}/api/practice-cad/incidents`,
    };
    const rows = Object.entries(want).map(([k, v]) => {
      const ok = checks ? checks[k] : null;
      return `<li>${ok === true ? '✅' : ok === false ? '❌' : '•'} <code>${k}</code> = <code>${esc(v)}</code>${ok === false ? ' <b>← missing or wrong</b>' : ''}</li>`;
    }).join('');
    $('#off').innerHTML = `<b>The practice control room is switched off on this server.</b> In Render → Environment set:<ul class="pc-checks">${rows}</ul>then click <b>Save, rebuild and deploy</b> (not just “Save”). Until then Medreach uses its built-in simulated control room.`;
    return;
  }
  if (res.status === 401) { live(false, 'Key needed'); $('#incidents').innerHTML = '<p class="muted">Enter the dispatcher key to view incidents.</p>'; return; }
  const data = await res.json();
  live(true, 'Live');
  const free = data.fleet.filter((a) => a.available).length;
  const open = data.incidents.filter((r) => !r.closed).length;
  $('#counts').textContent = `${open} active incident${open === 1 ? '' : 's'} · ${free}/${data.fleet.length} units free`;
  $('#fleet').innerHTML = data.fleet.map((a) => `<li><span class="mono">${esc(a.id)}</span><span class="muted">${esc(a.type)} · ${esc(a.base)}</span><span class="pill ${a.available ? 'green' : 'amber'}">${a.available ? 'free' : 'on a call'}</span></li>`).join('');
  // Don't rebuild cards while a log is open.
  if (!document.querySelector('.pc-inc details[open]')) {
    $('#incidents').innerHTML = data.incidents.map(incidentCard).join('') || '<p class="muted">Waiting for incidents from Medreach…</p>';
  }
  drawMap(data);
}

$('#keyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $('#key').value.trim();
  try { sessionStorage.setItem(KEY, key); } catch { /* ignore */ }
  $('#key').value = '';
  renderKeyState();
  load();
});

$('#incidents').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.dataset.act === 'cancel' && !confirm('Cancel this incident? Medreach will tell the family to call 108.')) return;
  b.disabled = true;
  try {
    const res = await fetch(`/api/practice-cad/incidents/${encodeURIComponent(b.dataset.id)}/${b.dataset.act}`, { method: 'POST', headers: { 'X-Dispatcher-Key': key } });
    if (res.status === 401) { toast('Wrong dispatcher key'); key = ''; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } renderKeyState(); } else if (!res.ok) toast(`Failed: HTTP ${res.status}`);
    else toast(b.dataset.act === 'assign' ? 'Unit assigned – Medreach informed' : 'Incident cancelled – Medreach informed');
  } catch { toast('Could not reach the server'); }
  load();
});

renderKeyState();
load();
setInterval(load, 2000);
