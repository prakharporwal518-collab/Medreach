import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEHAT_DISABLE_AI;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-test';

const llm = await import('../server/llm.js');
const { triage } = await import('../shared/triage.js');

test('Gemini is used when only GEMINI_API_KEY is set; output is merged with the safety floor', async () => {
  assert.equal(llm.aiProvider(), 'gemini');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const out = {
      emergency_type: 'cardiac', severity: 'serious', confidence: 0.9, red_flags: ['sweating'], extra_capabilities: [],
      estimated_age: 62, first_aid: ['Sit him down', 'Call 108'], follow_up_question: '', doctor_summary: '62M chest pain',
    };
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(out) }] } }] }), { status: 200 });
  };
  try {
    const rule = triage('papa ko seene mein dard hai, pasina aa raha hai, 62 saal', { lang: 'en' });
    const r = await llm.aiTriage({ text: 'papa ko seene mein dard hai', lang: 'en', ruleResult: rule });
    assert.equal(r.engine, 'gemini');
    assert.equal(r.model, 'gemini-test');
    // AI said "serious" but the rules said critical: the floor holds.
    assert.equal(r.severity, rule.severity === 'critical' ? 'critical' : r.severity);
    assert.match(calls[0].url, /models\/gemini-test:generateContent$/);
    assert.equal(calls[0].opts.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.generationConfig.responseJsonSchema);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Gemini errors fall back to the rule engine', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 403 });
  try {
    const rule = triage('snake bite on leg', { lang: 'en' });
    const r = await llm.aiTriage({ text: 'snake bite on leg', lang: 'en', ruleResult: rule });
    assert.equal(r.type, rule.type);
    assert.match(r.aiError, /GEMINI_API_KEY/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
