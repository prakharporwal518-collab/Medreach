import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SEHAT_DISABLE_AI = '1';
const { createStore } = await import('../server/store.js');
const { pointAlong, downsample, remainingPath } = await import('../shared/geo.js');

const loc = { lat: 23.2355, lng: 77.4005 };
const triage = { type: 'cardiac', label: 'Heart attack', severity: 'critical', required: [], ambulanceType: 'ALS' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake road: an L-shaped detour, so a straight line would be clearly wrong.
const roadVia = (from, to) => ({ coords: [[from.lat, from.lng], [from.lat, to.lng], [to.lat, to.lng]], km: 5, min: 10 });

test('geo helpers: point along, downsample, remaining path', () => {
  const line = [[0, 0], [0, 10], [10, 10]];
  assert.deepEqual(pointAlong(line, 0.5), [0, 10]);
  assert.deepEqual(pointAlong(line, 0.25), [0, 5]);
  assert.equal(downsample(Array.from({ length: 500 }, (_, i) => [i, i]), 50).length, 50);
  assert.deepEqual(remainingPath(line, 0.75), [[5, 10], [10, 10]]);
});

async function acceptedCase(store) {
  const c = store.createCase({ triage, location: loc });
  const h = store.hospitals.find((x) => x.id === 'bansal');
  c.hospitalId = h.id; c.status = 'accepted'; c.etaMin = 12;
  return { c, h };
}

test('ambulance moves along the real road route, not a straight line', async () => {
  const store = createStore({ demoSpeed: 400, routeFn: async (a, b) => roadVia(a, b) });
  const { c } = await acceptedCase(store);
  store.startTransport(c.id, { mode: 'ambulance' });
  await wait(1300);
  const t = store.view(c).transport;
  assert.equal(t.onRoad, true);
  assert.ok(t.path.length >= 2);
  // On an L-shaped road the vehicle is on one of the two legs (same lat or same lng as a corner).
  const p = t.position;
  const from = t.from;
  const onLeg = Math.abs(p.lat - from.lat) < 1e-9 || Math.abs(p.lng - loc.lng) < 1e-9;
  assert.ok(onLeg, `position ${JSON.stringify(p)} should be on the road`);
  store.stop();
});

test('routing failure keeps tracking on a straight line', async () => {
  const store = createStore({ demoSpeed: 400, routeFn: async () => { throw new Error('down'); } });
  const { c } = await acceptedCase(store);
  store.startTransport(c.id, { mode: 'ambulance' });
  await wait(1200);
  const t = store.view(c).transport;
  assert.equal(t.onRoad, false);
  assert.ok(Number.isFinite(t.position.lat));
  store.stop();
});

test('own vehicle drives along the route, and real GPS movement takes over', async () => {
  const store = createStore({ demoSpeed: 30, routeFn: async (a, b) => roadVia(a, b) });
  const { c, h } = await acceptedCase(store);
  store.startTransport(c.id, { mode: 'own' });
  await wait(1300);
  let t = store.view(c).transport;
  assert.equal(t.mode, 'own');
  assert.equal(t.simulated, true);
  assert.ok(t.progress > 0);
  // A GPS fix still at the pick-up point does not stop the simulation …
  store.updatePosition(c.id, { lat: loc.lat, lng: loc.lng });
  assert.equal(store.view(c).transport.gps, false);
  // … real movement does.
  store.updatePosition(c.id, { lat: (loc.lat + h.lat) / 2, lng: (loc.lng + h.lng) / 2, etaMin: 6 });
  t = store.view(c).transport;
  assert.equal(t.gps, true);
  assert.equal(t.simulated, false);
  assert.equal(t.etaMin, 6);
  store.stop();
});
