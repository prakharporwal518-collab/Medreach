import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, extractAge } from '../shared/triage.js';

const cases = [
  // [description, expected type, expected severity]
  ['papa ko seene mein dard hai, pasina aa raha hai', 'cardiac', 'critical'],
  ['मेरी माँ को लकवा हो गया, मुंह टेढ़ा है', 'stroke', 'critical'],
  ['bike accident, sir par chot', 'trauma', 'serious'],
  ['saanp ne kaat liya khet mein', 'snakebite', 'critical'],
  ['kheti me keetnashak pee liya', 'poisoning', 'critical'],
  ['pregnant wife labour pain started', 'pregnancy', 'serious'],
  ['kutte ne kaat liya', 'animal_bite', 'moderate'],
  ['dil ka daura pada', 'cardiac', 'critical'],
  ['he collapsed and is unconscious', 'collapse', 'critical'],
  ['गैस सिलेंडर फटा, हाथ जल गया', 'burns', 'serious'],
];

for (const [text, type, severity] of cases) {
  test(`understands: "${text}"`, () => {
    const r = triage(text);
    assert.equal(r.type, type);
    assert.equal(r.severity, severity);
    assert.ok(r.required.includes('emergency'));
    assert.ok(r.firstAid.length >= 3);
  });
}

test('red flags escalate severity and add capabilities', () => {
  const r = triage('bike accident, sir par chot, bahut khoon');
  assert.equal(r.severity, 'critical');
  assert.ok(r.redFlags.includes('heavy_bleeding'));
  assert.ok(r.redFlags.includes('head_injury'));
  assert.ok(r.required.includes('neurosurgery'));
  assert.ok(r.required.includes('blood_bank'));
  assert.equal(r.ambulanceType, 'ALS');
});

test('"not breathing" triggers CPR first and is not mistaken for asthma', () => {
  const r = triage('he is unconscious and not breathing');
  assert.equal(r.type, 'collapse');
  assert.ok(r.redFlags.includes('not_breathing'));
  assert.match(r.firstAid[0], /108/);
  assert.match(r.firstAid.join(' '), /CPR/);
});

test('unconscious heart attack patient does not get "make them sit" advice', () => {
  const r = triage('papa behosh ho gaye, seene mein dard tha');
  assert.equal(r.type, 'cardiac');
  assert.ok(!r.firstAid.some((s) => /sit down/i.test(s)));
});

test('follow-up answers change the result (conversational triage)', () => {
  const before = triage('bacche ko tez bukhar hai');
  assert.equal(before.type, 'child_fever');
  const after = triage('bacche ko tez bukhar hai', { answers: { conscious: 'no' } });
  assert.equal(after.severity, 'critical');
  assert.ok(!after.followUps.includes('conscious'));
});

test('elderly patients are escalated', () => {
  assert.equal(triage('fever and weakness').severity, 'moderate');
  assert.equal(triage('fever and weakness, 75 saal').severity, 'serious');
});

test('Hindi first aid in Devanagari', () => {
  const r = triage('snake bite', { lang: 'hi' });
  assert.match(r.firstAid[0], /[ऀ-ॿ]/);
  assert.equal(r.label, 'साँप का काटना');
});

test('quick chip hint works with an empty description', () => {
  const r = triage('', { hintType: 'pregnancy' });
  assert.equal(r.type, 'pregnancy');
  assert.equal(r.ambulanceType, 'JANANI');
});

test('extractAge', () => {
  assert.equal(extractAge(' papa 62 saal '), 62);
  assert.equal(extractAge(' baby 6 months old '), 0.5);
  assert.equal(extractAge(' no age here '), null);
});

test('bleeding from an accident is routed as trauma', () => {
  const r = triage('accident hua hai, bahut khoon beh raha hai\nPhoto shows: possible heavy bleeding');
  assert.equal(r.type, 'trauma');
  assert.ok(r.redFlags.includes('heavy_bleeding'));
  assert.ok(r.required.includes('blood_bank'));
});
