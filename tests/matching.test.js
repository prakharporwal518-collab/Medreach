import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../shared/triage.js';
import { rankHospitals, bedTypeFor } from '../shared/matching.js';
import { predictTravelMin, predictBedAvailability, haversineKm } from '../shared/predict.js';
import { checkCapability } from '../shared/capabilities.js';
import { HOSPITALS, DEMO_LOCATION } from '../server/data/hospitals.js';

const fresh = () => structuredClone(HOSPITALS);

test('only hospitals with every required capability LIVE are offered', () => {
  const t = triage('snake bite');
  const { options } = rankHospitals(t, DEMO_LOCATION, fresh(), { hour: 14 });
  assert.ok(options.length > 0);
  for (const o of options) assert.ok(o.capChecks.every((c) => c.live), o.hospital.name);
  assert.ok(options.every((o) => o.hospital.capabilities.includes('anti_venom')));
});

test('a specialist going off duty removes the hospital from options', () => {
  const hospitals = fresh();
  const t = triage('heart attack');
  const before = rankHospitals(t, DEMO_LOCATION, hospitals, { hour: 14 }).options.map((o) => o.hospital.id);
  assert.ok(before.includes('bansal'));
  hospitals.find((h) => h.id === 'bansal').status.onDuty = [];
  const after = rankHospitals(t, DEMO_LOCATION, hospitals, { hour: 14 });
  assert.ok(!after.options.some((o) => o.hospital.id === 'bansal'));
  const ex = after.excluded.find((e) => e.hospital.id === 'bansal');
  assert.ok(ex.excludedBecause.includes('specialist_off_duty:cardiology'));
});

test('diverting emergency departments are excluded', () => {
  const hospitals = fresh();
  hospitals.forEach((h) => { if (h.id === 'aiims-bpl') h.status.erStatus = 'diverting'; });
  const { options, excluded } = rankHospitals(triage('road accident'), DEMO_LOCATION, hospitals, { hour: 3 });
  assert.ok(!options.some((o) => o.hospital.id === 'aiims-bpl'));
  assert.ok(excluded.find((e) => e.hospital.id === 'aiims-bpl').excludedBecause.includes('er_diverting'));
});

test('broken equipment is detected', () => {
  const chirayu = HOSPITALS.find((h) => h.id === 'chirayu');
  assert.equal(checkCapability(chirayu, 'cath_lab').live, false);
  assert.equal(checkCapability(chirayu, 'cath_lab').reason, 'equipment_down');
});

test('options are sorted by score and the best is recommended', () => {
  const { options } = rankHospitals(triage('pregnant, labour pain'), DEMO_LOCATION, fresh(), { hour: 10 });
  for (let i = 1; i < options.length; i++) assert.ok(options[i - 1].score >= options[i].score);
  assert.equal(options[0].recommended, true);
  assert.equal(options[0].bedType, 'labour');
});

test('critical patient far from capable care gets a stabilisation option', () => {
  // A village near Berasia: only the CHC is close; cardiac care is in Bhopal.
  const village = { lat: 23.64, lng: 77.44 };
  const r = rankHospitals(triage('heart attack, unconscious'), village, fresh(), { hour: 12 });
  assert.ok(r.stabilise, 'should suggest nearest ER for stabilisation');
  assert.equal(r.stabilise.hospital.id, 'chc-berasia');
});

test('traffic model: rush hour is slower than night', () => {
  assert.ok(predictTravelMin(10, { hour: 18 }).minutes > predictTravelMin(10, { hour: 3 }).minutes);
  assert.ok(predictTravelMin(10, { hour: 18, mode: 'ambulance' }).minutes < predictTravelMin(10, { hour: 18 }).minutes);
});

test('bed model: no free beds → low probability; many free → high', () => {
  const h = structuredClone(HOSPITALS[0]);
  h.status.beds.icu.free = 0;
  assert.ok(predictBedAvailability(h, 'icu', 20, 12).probability < 0.2);
  h.status.beds.icu.free = 10;
  assert.ok(predictBedAvailability(h, 'icu', 20, 12).probability > 0.9);
});

test('bed type selection', () => {
  assert.equal(bedTypeFor(triage('heart attack')), 'icu');
  assert.equal(bedTypeFor(triage('dog bite')), 'emergency');
});

test('haversine sanity: Bhopal → Vidisha ≈ 50 km', () => {
  const d = haversineKm({ lat: 23.2599, lng: 77.4126 }, { lat: 23.5251, lng: 77.8081 });
  assert.ok(d > 45 && d < 55, `${d}`);
});

test('specialty hospitals only receive their own patient group', () => {
  const adult = rankHospitals(triage('road accident, heavy bleeding'), DEMO_LOCATION, fresh(), { hour: 12 });
  assert.ok(!adult.options.some((o) => o.hospital.id === 'kamla-nehru' || o.hospital.id === 'sultania'));
  const child = rankHospitals(triage('bacche ko tez bukhar, 4 saal'), DEMO_LOCATION, fresh(), { hour: 12 });
  assert.ok(child.options.some((o) => o.hospital.id === 'kamla-nehru'));
  const labour = rankHospitals(triage('pregnant, labour pain'), DEMO_LOCATION, fresh(), { hour: 12 });
  assert.ok(labour.options.some((o) => o.hospital.id === 'sultania'));
});
