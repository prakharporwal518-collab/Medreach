import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, freshnessLabel } from '../shared/freshness.js';
import { rankHospitals, explain } from '../shared/matching.js';
import { triage } from '../shared/triage.js';
import { HOSPITALS, DEMO_LOCATION } from '../server/data/hospitals.js';
import { can } from '../shared/roles.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

test('freshness levels', () => {
  assert.equal(freshness(minsAgo(2), NOW).level, 'fresh');
  assert.equal(freshness(minsAgo(28), NOW).level, 'aging');
  assert.equal(freshness(minsAgo(90), NOW).level, 'stale');
  assert.equal(freshness(null, NOW).level, 'stale');
  assert.match(freshnessLabel(freshness(minsAgo(2), NOW)).text, /Verified 2 min ago/);
  assert.match(freshnessLabel(freshness(null, NOW)).text, /unverified/);
});

test('stale capacity is not presented as confirmed and scores lower', () => {
  const t = triage('heart attack');
  const fresh = structuredClone(HOSPITALS).map((h) => ({ ...h, status: { ...h.status, verifiedAt: minsAgo(2) } }));
  const stale = structuredClone(HOSPITALS).map((h) => ({ ...h, status: { ...h.status, verifiedAt: minsAgo(180) } }));
  const a = rankHospitals(t, DEMO_LOCATION, fresh, { hour: 12, now: NOW }).options.find((o) => o.hospital.id === 'bansal');
  const b = rankHospitals(t, DEMO_LOCATION, stale, { hour: 12, now: NOW }).options.find((o) => o.hospital.id === 'bansal');
  assert.equal(a.capacityVerified, true);
  assert.equal(b.capacityVerified, false);
  assert.ok(b.scoreParts.capacity < a.scoreParts.capacity);
  assert.ok(explain(b).some((i) => /not verified recently – acceptance required/.test(i.text)));
  assert.ok(explain(a).some((i) => /capacity reported: \d+ bed/.test(i.text)));
});

test('score parts add up to the score', () => {
  const o = rankHospitals(triage('stroke'), DEMO_LOCATION, structuredClone(HOSPITALS), { hour: 12, now: NOW }).options[0];
  assert.equal(o.score, Object.values(o.scoreParts).reduce((x, y) => x + y, 0));
});

test('role-based permissions', () => {
  const desk = { role: 'emergency_desk', hospitalId: 'bansal' };
  const rm = { role: 'resource_manager', hospitalId: 'bansal' };
  const admin = { role: 'admin', hospitalId: 'MP-STATE' };
  assert.equal(can(desk, 'referral.respond', 'bansal'), true);
  assert.equal(can(desk, 'referral.respond', 'aiims-bpl'), false);
  assert.equal(can(desk, 'status.beds', 'bansal'), false);
  assert.equal(can(rm, 'status.beds', 'bansal'), true);
  assert.equal(can(rm, 'referral.respond', 'bansal'), false);
  assert.equal(can(admin, 'audit.view', 'bansal'), true);
  assert.equal(can(admin, 'referral.respond', 'bansal'), false);
});
