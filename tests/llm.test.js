import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { mergeTriage, templateHandover } from '../server/llm.js';
import { triage } from '../shared/triage.js';

const aiOut = (over = {}) => ({
  emergency_type: 'cardiac', severity: 'moderate', confidence: 0.9, red_flags: [], extra_capabilities: [],
  estimated_age: 60, first_aid: ['step 1', 'step 2', 'step 3'], follow_up_question: '', doctor_summary: 'Chest pain 60M', ...over,
});

test('SDK error classes used for fallback handling exist', () => {
  for (const k of ['AuthenticationError', 'RateLimitError', 'BadRequestError', 'APIConnectionTimeoutError', 'APIConnectionError', 'APIError']) {
    assert.equal(typeof Anthropic[k], 'function', k);
  }
});

test('AI can never downgrade severity below the rule engine (safety floor)', () => {
  const rule = triage('heart attack'); // critical
  const merged = mergeTriage(rule, aiOut({ severity: 'moderate' }), 'en');
  assert.equal(merged.severity, 'critical');
  assert.equal(merged.engine, 'claude');
});

test('AI can raise severity and add capabilities', () => {
  const rule = triage('fell from bike'); // trauma, serious
  const merged = mergeTriage(rule, aiOut({ emergency_type: 'trauma', severity: 'critical', extra_capabilities: ['neurosurgery', 'not_a_cap'] }), 'en');
  assert.equal(merged.severity, 'critical');
  assert.ok(merged.required.includes('neurosurgery'));
  assert.ok(!merged.required.includes('not_a_cap'));
  assert.equal(merged.ambulanceType, 'ALS');
});

test('unknown AI type falls back to the rule type', () => {
  const rule = triage('snake bite');
  assert.equal(mergeTriage(rule, aiOut({ emergency_type: 'alien' }), 'en').type, 'snakebite');
});

test('template SBAR handover includes patient history', () => {
  const t = triage('heart attack');
  const note = templateHandover({ triage: t, patient: { name: 'Asha', age: 58, allergies: ['Penicillin'], bloodGroup: 'O+' }, bedType: 'icu' });
  assert.match(note, /^S: Asha, 58y/);
  assert.match(note, /Allergies: Penicillin/);
  assert.match(note, /Bed: ICU/);
});
