// Sign-in page for both portals.
//   Citizen            → account on this device → /citizen
//   Hospital Staff     → Hospital ID + Staff ID + OTP (server) → /hospital
//   Health Admin       → MP-STATE + Staff ID + OTP (server)    → /hospital (read-only oversight)
import { hydrateIcons, esc } from './icons.js';
import * as citizen from './citizen-store.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let role = ['staff', 'admin'].includes(params.get('role')) ? params.get('role') : 'citizen';
let citizenMode = params.get('mode') === 'register' ? 'register' : 'signin';
let config = { dataMode: 'demo' };
let hospitals = [];

hydrateIcons();

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function render() {
  for (const c of document.querySelectorAll('.role-card')) c.setAttribute('aria-checked', String(c.dataset.role === role));
  $('#roleCode').textContent = `ROLE: ${role === 'citizen' ? 'CITIZEN' : role === 'staff' ? 'HOSPITAL STAFF' : 'HEALTH ADMIN'}`;
  $('#citizenBox').classList.toggle('hidden', role !== 'citizen');
  $('#staffBox').classList.toggle('hidden', role === 'citizen');
  const reg = citizenMode === 'register';
  if (role === 'citizen') {
    $('#title').textContent = reg ? 'Create Citizen Account' : 'Citizen Sign in';
    $('#lead').textContent = reg ? 'Register your profile for fast, private emergency help' : 'Welcome back – your data stays on this device';
    $('#tabSignin').setAttribute('aria-selected', String(!reg));
    $('#tabRegister').setAttribute('aria-selected', String(reg));
    $('#signinForm').classList.toggle('hidden', reg);
    $('#registerForm').classList.toggle('hidden', !reg);
    $('#authFoot').innerHTML = reg
      ? 'Already have an account? <a href="#" id="swap">Sign in</a>'
      : 'New to Medreach? <a href="#" id="swap">Create an account</a>';
    $('#swap').onclick = (e) => { e.preventDefault(); citizenMode = reg ? 'signin' : 'register'; render(); };
  } else {
    $('#title').textContent = role === 'staff' ? 'Hospital Staff Sign in' : 'Health Admin Sign in';
    $('#lead').textContent = role === 'staff' ? 'Authorised hospital staff only · every action is audit-logged' : 'Read-only oversight of all hospitals · audit-logged';
    $('#hospField').classList.toggle('hidden', role === 'admin');
    $('#staffId').placeholder = role === 'admin' ? 'e.g. MP-ADMIN-01' : 'e.g. BANSAL-ED01';
    $('#authFoot').innerHTML = 'Are you a patient or family member? <a href="/login?role=citizen">Citizen sign in</a>';
    $('#otpForm').classList.add('hidden');
    quickLogin();
  }
  showAlready();
}

// Already signed in? Offer to continue (the two portals stay independent).
function showAlready() {
  const box = $('#already');
  if (role === 'citizen') {
    const me = citizen.current();
    box.classList.toggle('hidden', !me);
    if (me) box.innerHTML = `Signed in as <b>${esc(me.name)}</b> on this device. <a href="/citizen">Go to your dashboard →</a> · <a href="#" id="soCit">Sign out</a>`;
    $('#soCit')?.addEventListener('click', (e) => { e.preventDefault(); citizen.signOut(); showAlready(); });
  } else {
    const st = citizen.staffSession();
    box.classList.toggle('hidden', !st);
    if (st) box.innerHTML = `This tab is signed in as <b>${esc(st.staff.name)}</b> (${esc(st.staff.roleLabel)}). <a href="/hospital">Open hospital dashboard →</a>`;
  }
}

// ---------------------------------------------------------------- citizen
$('#tabSignin').onclick = () => { citizenMode = 'signin'; render(); };
$('#tabRegister').onclick = () => { citizenMode = 'register'; render(); };
for (const b of document.querySelectorAll('[data-toggle]')) {
  b.onclick = () => { const i = $(`#${b.dataset.toggle}`); i.type = i.type === 'password' ? 'text' : 'password'; };
}

$('#signinForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#siError').textContent = '';
  try {
    await citizen.signIn($('#siPhone').value, $('#siPass').value);
    location.href = params.get('next')?.startsWith('/') && !params.get('next').startsWith('//') ? params.get('next') : '/citizen';
  } catch (err) { $('#siError').textContent = err.message; }
};

$('#registerForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#rgError').textContent = '';
  if ($('#rgPass').value !== $('#rgPass2').value) { $('#rgError').textContent = 'Passwords do not match'; return; }
  if (!$('#rgAgree').checked) { $('#rgError').textContent = 'Please tick the privacy acknowledgement'; return; }
  try {
    await citizen.register({ name: $('#rgName').value, email: $('#rgEmail').value, phone: $('#rgPhone').value, password: $('#rgPass').value });
    location.href = '/citizen#welcome';
  } catch (err) { $('#rgError').textContent = err.message; }
};

// ---------------------------------------------------------------- hospital staff / admin
const hospitalIdValue = () => (role === 'admin' ? 'MP-STATE' : $('#hospitalId').value);

async function quickLogin() {
  if (config.dataMode !== 'demo') return;
  try {
    const hid = hospitalIdValue();
    const staff = await api(`/api/auth/demo-staff?hospitalId=${encodeURIComponent(hid)}`);
    const list = staff.filter((s) => s.hospitalId === hid);
    $('#quickList').innerHTML = list.map((s) => `<button type="button" class="chip-t" data-staff="${esc(s.staffId)}">${esc(s.roleLabel)} · ${esc(s.staffId)}</button>`).join('');
    $('#quickLogin').classList.toggle('hidden', !list.length);
  } catch { /* optional */ }
}

async function requestOtp(e) {
  e?.preventDefault();
  $('#stError').textContent = '';
  try {
    const out = await api('/api/auth/otp', { hospitalId: hospitalIdValue(), staffId: $('#staffId').value });
    $('#otpForm').classList.remove('hidden');
    $('#otpSent').textContent = `OTP sent to the registered mobile ${out.maskedMobile}. Valid for 5 minutes.`;
    $('#otpDemo').classList.toggle('hidden', !out.demoOtp);
    if (out.demoOtp) $('#otpDemo').innerHTML = `Demo only (no SMS gateway in the prototype): your OTP is <b>${esc(out.demoOtp)}</b>`;
    $('#otp').focus();
  } catch (err) { $('#stError').textContent = err.message; }
}

async function verifyOtp(e) {
  e.preventDefault();
  $('#stError').textContent = '';
  try {
    const out = await api('/api/auth/verify', { hospitalId: hospitalIdValue(), staffId: $('#staffId').value, otp: $('#otp').value });
    try { sessionStorage.setItem('sehat.staff', JSON.stringify(out)); } catch { /* ignore */ }
    location.href = '/hospital';
  } catch (err) { $('#stError').textContent = err.message; }
}

$('#otpReqForm').onsubmit = requestOtp;
$('#otpForm').onsubmit = verifyOtp;
$('#hospitalId').onchange = () => { $('#otpForm').classList.add('hidden'); quickLogin(); };
$('#quickList').onclick = (e) => { const b = e.target.closest('[data-staff]'); if (b) { $('#staffId').value = b.dataset.staff; requestOtp(); } };
for (const c of document.querySelectorAll('.role-card')) c.onclick = () => { role = c.dataset.role; $('#stError').textContent = ''; render(); };

async function boot() {
  try {
    [config, hospitals] = await Promise.all([api('/api/config'), api('/api/hospitals')]);
  } catch { /* offline: citizen sign-in still works */ }
  $('#hospitalId').innerHTML = hospitals.map((h) => `<option value="${esc(h.id)}">${esc(h.id)} – ${esc(h.name)}</option>`).join('');
  if (params.get('hospital')) $('#hospitalId').value = params.get('hospital');
  if (role === 'citizen' && citizenMode === 'signin' && !params.get('mode')) {
    // First visit on this device → start with registration.
    try { if (!Object.keys(JSON.parse(localStorage.getItem('sehat.citizen.accounts') || '{}')).length) citizenMode = 'register'; } catch { /* ignore */ }
  }
  render();
}
boot();
