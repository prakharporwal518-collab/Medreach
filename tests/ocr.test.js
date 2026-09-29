import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthDocument } from '../shared/ocr-parse.js';

test('parses an Ayushman / ABHA style card with prescription lines', () => {
  const out = parseHealthDocument(`AYUSHMAN BHARAT PM-JAY
Name: Ramesh Kumar Patel
Year of Birth: 1968   Male
ABHA: 91-4521-7788-1203
Blood Group: B+ve
K/C/O Diabetes, HTN
Allergy: Penicillin, Sulfa
Tab Metformin 500 mg BD
Tab Amlodipine 5mg OD`);
  assert.equal(out.name, 'Ramesh Kumar Patel');
  assert.equal(out.gender, 'Male');
  assert.equal(out.bloodGroup, 'B+');
  assert.equal(out.abhaId, '91-4521-7788-1203');
  assert.deepEqual(out.conditions, ['diabetes', 'hypertension']);
  assert.deepEqual(out.allergies, ['Penicillin', 'Sulfa']);
  assert.deepEqual(out.medicines, ['Metformin', 'Amlodipine']);
  assert.ok(out.age > 50);
});

test('parses Hindi labels', () => {
  const out = parseHealthDocument('नाम: सीता देवी\nआयु: 28\nमहिला\nरक्त समूह: O-\nगर्भवती');
  assert.equal(out.name, 'सीता देवी');
  assert.equal(out.age, 28);
  assert.equal(out.gender, 'Female');
  assert.equal(out.bloodGroup, 'O-');
  assert.ok(out.conditions.includes('pregnancy'));
});

test('"Allergy: Nil" yields no allergies; garbage yields nothing', () => {
  assert.deepEqual(parseHealthDocument('Allergy: NIL').allergies, []);
  assert.equal(parseHealthDocument('~~ %% ##').fieldsFound, 0);
});
