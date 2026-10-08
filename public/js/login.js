// Sign-in page for both portals.
//   Citizen            → Aadhaar + OTP (server-verified) → profile on this device → /citizen
//   Hospital Staff     → Hospital ID + Staff ID + OTP (server) → /hospital
//   Health Admin       → MP-STATE + Staff ID + OTP (server)    → /hospital (read-only oversight)
import { hydrateIcons, esc } from './icons.js';
import * as citizen from './citizen-store.js';
import { aadhaarProblem, cleanAadhaar, formatAadhaar } from '/shared/aadhaar.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let role = ['staff', 'admin'].includes(params.get('role')) ? params.get('role') : 'citizen';
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
  if (role === 'citizen') {
    $('#title').textContent = 'Citizen Sign in / Register';
    $('#lead').textContent = 'Verify with Aadhaar OTP – your health records stay on this device';
    $('#authFoot').innerHTML = 'Hospital staff? <a href="/login?role=staff">Staff sign in</a> · Emergency? <a href="/report">Report without logging in</a>';
    demoIds();
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

// ---------------------------------------------------------------- citizen: Aadhaar + OTP
let txn = null;          // { txnId, maskedMobile, needsName } of the OTP that was sent
let resendTimer = null;
const nextUrl = () => (params.get('next')?.startsWith('/') && !params.get('next').startsWith('//') ? params.get('next') : null);

// Show the number grouped like on the card while typing (2345 6789 0123).
$('#aadhaar').addEventListener('input', (e) => {
  const el = e.target;
  const atEnd = el.selectionStart === el.value.length;
  el.value = formatAadhaar(el.value);
  if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
  $('#aaError').textContent = '';
});

async function demoIds() {
  if (config.dataMode !== 'demo') return;
  try {
    const ids = await api('/api/citizen/demo-ids');
    $('#demoIdList').innerHTML = ids.map((p) => `<button type="button" class="chip-t" data-aadhaar="${esc(p.aadhaar)}">${esc(p.name)} · ${esc(p.aadhaar)}</button>`).join('');
    $('#demoIds').classList.toggle('hidden', !ids.length);
  } catch { /* optional */ }
}
$('#demoIdList').onclick = (e) => {
  const b = e.target.closest('[data-aadhaar]');
  if (!b) return;
  $('#aadhaar').value = b.dataset.aadhaar;
  $('#aaError').textContent = '';
};

function startResendCountdown(sec = 30) {
  clearInterval(resendTimer);
  let left = sec;
  const link = $('#aaResend');
  link.classList.add('disabled');
  $('#aaResendIn').textContent = `(${left}s)`;
  resendTimer = setInterval(() => {
    left -= 1;
    $('#aaResendIn').textContent = left > 0 ? `(${left}s)` : '';
    if (left <= 0) { clearInterval(resendTimer); link.classList.remove('disabled'); }
  }, 1000);
}

async function sendAadhaarOtp(e) {
  e?.preventDefault();
  $('#aaError').textContent = '';
  const problem = aadhaarProblem($('#aadhaar').value);
  if (problem) { $('#aaError').textContent = problem; $('#aadhaar').focus(); return; }
  if (!$('#aaConsent').checked) { $('#aaError').textContent = 'Please tick the consent box to verify with Aadhaar'; return; }
  const btn = $('#aaBtn');
  btn.disabled = true;
  try {
    txn = await api('/api/citizen/otp', { aadhaar: cleanAadhaar($('#aadhaar').value), consent: true });
    $('#aadhaarForm').classList.add('hidden');
    $('#aaOtpForm').classList.remove('hidden');
    $('#aaSent').innerHTML = `OTP sent to the mobile linked with Aadhaar <b>${esc(txn.maskedAadhaar)}</b>: <b>${esc(txn.maskedMobile)}</b>. Valid for 5 minutes.`;
    $('#aaDemo').classList.toggle('hidden', !txn.demoOtp);
    if (txn.demoOtp) $('#aaDemo').innerHTML = `Demo only (simulated UIDAI, no SMS is sent): your OTP is <b>${esc(txn.demoOtp)}</b>`;
    $('#aaNameField').classList.toggle('hidden', !txn.needsName);
    $('#aaOtp').value = '';
    $('#aaOtpError').textContent = '';
    (txn.needsName ? $('#aaName') : $('#aaOtp')).focus();
    startResendCountdown();
  } catch (err) {
    $('#aaError').textContent = err.message;
    if (!$('#aaOtpForm').classList.contains('hidden')) $('#aaOtpError').textContent = err.message;
  } finally { btn.disabled = false; }
}

$('#aadhaarForm').onsubmit = sendAadhaarOtp;
$('#aaChange').onclick = (e) => {
  e.preventDefault();
  txn = null;
  clearInterval(resendTimer);
  $('#aaOtpForm').classList.add('hidden');
  $('#aadhaarForm').classList.remove('hidden');
  $('#aadhaar').focus();
};
$('#aaResend').onclick = async (e) => {
  e.preventDefault();
  if (e.currentTarget.classList.contains('disabled')) return;
  $('#aaOtpError').textContent = '';
  try {
    txn = await api('/api/citizen/otp', { aadhaar: cleanAadhaar($('#aadhaar').value), consent: true });
    $('#aaDemo').classList.toggle('hidden', !txn.demoOtp);
    if (txn.demoOtp) $('#aaDemo').innerHTML = `Demo only (simulated UIDAI, no SMS is sent): your OTP is <b>${esc(txn.demoOtp)}</b>`;
    startResendCountdown();
  } catch (err) { $('#aaOtpError').textContent = err.message; }
};

$('#aaOtpForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#aaOtpError').textContent = '';
  if (!txn) { $('#aaChange').click(); return; }
  const btn = $('#aaVerifyBtn');
  btn.disabled = true;
  try {
    const out = await api('/api/citizen/verify', { txnId: txn.txnId, otp: $('#aaOtp').value.trim(), name: $('#aaName').value });
    const { isNew } = citizen.signInVerified(out);
    // The Aadhaar number leaves the page as soon as it is verified.
    $('#aadhaar').value = '';
    location.href = nextUrl() || (isNew ? '/citizen#welcome' : '/citizen');
  } catch (err) {
    $('#aaOtpError').textContent = err.message;
    if (/request a new|expired/i.test(err.message)) $('#aaResend').classList.remove('disabled');
  } finally { btn.disabled = false; }
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
  render();
}
boot();
