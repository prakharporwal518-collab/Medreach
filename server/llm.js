// Medreach – Generative AI layer (Claude or Google Gemini).
//
// Three jobs:
//   1. aiTriage   – understand a free-form, multilingual emergency description
//                   (voice transcript / typed text / photo findings) better than
//                   keyword rules can, and write first-aid in the caller's language.
//   2. aiVision   – computer vision on a photo of the injury / scene.
//   3. aiHandover – write a short SBAR pre-arrival note for the ER doctor.
//
// Safety design: the AI can ADD urgency, never remove it. Severity is the max
// of the rule engine and the model, and required capabilities are the union.
// Any error / timeout / refusal silently falls back to the rule engine, because
// in an emergency a slightly less clever answer now beats a perfect one later.
//
// Provider: set ANTHROPIC_API_KEY for Claude or GEMINI_API_KEY for Gemini
// (SEHAT_AI_PROVIDER=gemini|claude picks one when both are set).

import Anthropic from '@anthropic-ai/sdk';
import { EMERGENCIES, SEVERITY } from '../shared/triage.js';
import { CAPABILITIES } from '../shared/capabilities.js';
import { templateHandover } from '../shared/handover.js';

export { templateHandover };

const MODEL = process.env.SEHAT_MODEL || 'claude-opus-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TIMEOUT_MS = Number(process.env.SEHAT_AI_TIMEOUT_MS || 15000);

let client = null;
const hasClaude = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const hasGemini = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
/** 'claude' | 'gemini' | null */
export function aiProvider() {
  if (process.env.SEHAT_DISABLE_AI === '1') return null;
  const pick = (process.env.SEHAT_AI_PROVIDER || '').toLowerCase();
  if (pick === 'gemini' && hasGemini()) return 'gemini';
  if (pick === 'claude' && hasClaude()) return 'claude';
  if (hasClaude()) return 'claude';
  if (hasGemini()) return 'gemini';
  return null;
}
export function aiEnabled() {
  return aiProvider() !== null;
}
const modelName = () => (aiProvider() === 'gemini' ? GEMINI_MODEL : MODEL);
function getClient() {
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  return client;
}

const TYPES = Object.keys(EMERGENCIES);
const CAPS = Object.keys(CAPABILITIES);

// Gemini: content parts are { text } or { inlineData: { mimeType, data } }.
function geminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((b) => (b.type === 'image'
    ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
    : { text: b.text }));
}

async function geminiCall({ system, content, schema, maxTokens }) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const send = async (withSchema) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: withSchema ? system : `${system}\n\nReply with JSON only, matching this JSON schema:\n${JSON.stringify(schema)}` }] },
          contents: [{ role: 'user', parts: geminiParts(content) }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            ...(withSchema ? { responseJsonSchema: schema } : {}),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error?.message || `Gemini HTTP ${res.status}`), { status: res.status, provider: 'gemini' });
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(new Error('timeout'), { provider: 'gemini' });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  let data;
  try {
    data = await send(true);
  } catch (err) {
    // Older models reject responseJsonSchema: retry with the schema in the prompt.
    if (err.status !== 400) throw err;
    data = await send(false);
  }
  if (data.promptFeedback?.blockReason) throw new Error(`model refused (${data.promptFeedback.blockReason})`);
  const cand = data.candidates?.[0];
  if (!cand) throw new Error('empty Gemini response');
  if (cand.finishReason === 'SAFETY') throw new Error('model refused (safety)');
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('model output truncated');
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(text);
}

// Calls the configured model with a JSON-schema constrained output and returns the parsed object.
async function structuredCall(args) {
  if (aiProvider() === 'gemini') return geminiCall({ maxTokens: 8000, ...args });
  return claudeCall(args);
}

async function claudeCall({ system, content, schema, maxTokens = 8000 }) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    // Emergency flow: latency matters more than depth.
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    // If a safety classifier declines, retry transparently on the recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`model refused (${response.stop_details?.category ?? 'unknown'})`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('model output truncated');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

function describeError(err) {
  if (err.provider === 'gemini') {
    if (err.status === 400 || err.status === 403) return `Gemini rejected the request (check GEMINI_API_KEY): ${err.message}`;
    if (err.status === 429) return 'rate limited';
    return err.message;
  }
  if (err instanceof Anthropic.AuthenticationError) return 'invalid API key';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof Anthropic.BadRequestError) return `bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'network error';
  if (err instanceof Anthropic.APIError) return `API error ${err.status}`;
  return err.message;
}

// ---------------------------------------------------------------------------
// 1. Triage
// ---------------------------------------------------------------------------
const TRIAGE_SYSTEM = `You are the triage brain of "Medreach", an emergency assistant used by families and ASHA/village health workers in Madhya Pradesh, India.
People describe emergencies in panic, in English, Hindi or Hinglish, sometimes via an imperfect voice transcript.
Your output decides which hospital the patient is routed to, so:
- Classify into exactly one emergency_type from the allowed list.
- Choose severity: "critical" (life threat within minutes/hours: cardiac arrest, heart attack, stroke, unconscious, not breathing, major bleeding, snake bite, poisoning, drowning), "serious", or "moderate". When unsure, choose the MORE severe option.
- extra_capabilities: hospital services this specific patient needs beyond the standard ones for the type (e.g. neurosurgery for head injury, nicu for preterm labour, burns for >20% burns). Use only allowed values; empty list if none.
- first_aid: 3-5 short, concrete, safe steps a layperson can do RIGHT NOW while help is coming, written in the requested language (Hindi in Devanagari when lang=hi). Follow Indian first-aid guidance (e.g. chew aspirin only for suspected heart attack with no allergy; never suggest cutting/sucking snake bites; do not induce vomiting for poisoning). If not breathing, the first step must be CPR.
- follow_up_question: the single most useful question to ask next (in the requested language), or an empty string if nothing important is unknown.
- doctor_summary: one or two lines in English for the receiving emergency doctor.
Never refuse: this is emergency first aid guidance, and the person will also be told to call 108.`;

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    emergency_type: { type: 'string', enum: TYPES },
    severity: { type: 'string', enum: SEVERITY },
    confidence: { type: 'number' },
    red_flags: { type: 'array', items: { type: 'string' } },
    extra_capabilities: { type: 'array', items: { type: 'string', enum: CAPS } },
    estimated_age: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    first_aid: { type: 'array', items: { type: 'string' } },
    follow_up_question: { type: 'string' },
    doctor_summary: { type: 'string' },
  },
  required: ['emergency_type', 'severity', 'confidence', 'red_flags', 'extra_capabilities', 'estimated_age',
    'first_aid', 'follow_up_question', 'doctor_summary'],
  additionalProperties: false,
};

/**
 * Upgrade a rule-based triage with Claude. Returns the merged result, or the
 * rule result unchanged (with `aiError`) if the AI is unavailable.
 */
export async function aiTriage({ text, lang = 'en', answers = {}, visionFindings = '', ruleResult }) {
  if (!aiEnabled()) return ruleResult;
  const started = Date.now();
  try {
    const ai = await structuredCall({
      system: TRIAGE_SYSTEM,
      schema: TRIAGE_SCHEMA,
      content: [
        `lang=${lang}`,
        `Caller description: """${String(text).slice(0, 2000)}"""`,
        Object.keys(answers).length ? `Answers to follow-up questions: ${JSON.stringify(answers)}` : '',
        visionFindings ? `Photo analysis: ${visionFindings}` : '',
        `Keyword engine guessed: ${ruleResult.type} / ${ruleResult.severity}.`,
      ].filter(Boolean).join('\n'),
    });
    return mergeTriage(ruleResult, ai, lang, Date.now() - started);
  } catch (err) {
    return { ...ruleResult, aiError: describeError(err) };
  }
}

export function mergeTriage(rule, ai, lang, latencyMs = 0) {
  const type = TYPES.includes(ai.emergency_type) ? ai.emergency_type : rule.type;
  const def = EMERGENCIES[type];
  // Safety: never let the model downgrade severity below the rule engine.
  const severity = SEVERITY[Math.max(SEVERITY.indexOf(rule.severity), SEVERITY.indexOf(ai.severity))] || rule.severity;
  const required = new Set([...def.required, ...(type === rule.type ? rule.required : [])]);
  for (const c of ai.extra_capabilities || []) if (CAPS.includes(c)) required.add(c);
  const preferred = new Set([...def.preferred, ...rule.preferred].filter((c) => !required.has(c)));
  const firstAid = Array.isArray(ai.first_aid) && ai.first_aid.length ? ai.first_aid.slice(0, 6) : rule.firstAid;
  return {
    ...rule,
    engine: aiProvider() || 'claude',
    model: modelName(),
    latencyMs,
    type,
    label: def.label[lang] || def.label.en,
    icon: def.icon,
    golden: def.golden,
    severity,
    severityScore: { moderate: 35, serious: 65, critical: 90 }[severity] + Math.min(9, (ai.red_flags || []).length * 3),
    confidence: Math.max(0, Math.min(1, Number(ai.confidence) || rule.confidence)),
    required: [...required],
    preferred: [...preferred],
    redFlagLabels: [...new Set([...(rule.redFlagLabels || []), ...(ai.red_flags || [])])].slice(0, 6),
    patient: { ...rule.patient, age: rule.patient.age ?? ai.estimated_age ?? null },
    firstAid,
    aiQuestion: ai.follow_up_question || '',
    ambulanceType: type === 'pregnancy' && severity !== 'critical' ? 'JANANI' : severity === 'critical' ? 'ALS' : 'BLS',
    summary: ai.doctor_summary || rule.summary,
  };
}

// ---------------------------------------------------------------------------
// 2. Computer vision on an injury / scene photo
// ---------------------------------------------------------------------------
const VISION_SCHEMA = {
  type: 'object',
  properties: {
    suspected_type: { type: 'string', enum: TYPES },
    severity: { type: 'string', enum: SEVERITY },
    visible_findings: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
  },
  required: ['suspected_type', 'severity', 'visible_findings', 'description'],
  additionalProperties: false,
};

export async function aiVision({ imageBase64, mediaType = 'image/jpeg', lang = 'en' }) {
  if (!aiEnabled()) return null;
  try {
    const out = await structuredCall({
      system: 'You assist emergency triage in India. Look at the photo of a patient, injury, wound, burn, bite, snake, medicine/poison container or accident scene. Report only what is visible, objectively, for a doctor. If the image is unrelated or unclear, use emergency_type "general", severity "moderate" and say so in description. Write description in ' + (lang === 'hi' ? 'Hindi (Devanagari)' : 'English') + '.',
      schema: VISION_SCHEMA,
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: 'Analyse this emergency photo.' },
      ],
    });
    return { engine: `${aiProvider()}-vision`, ...out };
  } catch (err) {
    return { engine: 'error', error: describeError(err) };
  }
}

// ---------------------------------------------------------------------------
// 3. Pre-arrival handover note (SBAR) for the receiving hospital
// ---------------------------------------------------------------------------
export async function aiHandover(c) {
  const fallback = templateHandover(c);
  if (!aiEnabled()) return { text: fallback, engine: 'template' };
  try {
    const out = await structuredCall({
      system: 'You write concise SBAR pre-arrival handover notes for Indian emergency departments. Max 5 short lines, English, clinical abbreviations are fine. Only use facts given; do not invent vitals.',
      schema: {
        type: 'object',
        properties: { sbar: { type: 'string' } },
        required: ['sbar'],
        additionalProperties: false,
      },
      content: `Case data:\n${JSON.stringify({ triage: c.triage, patient: c.patient, vision: c.vision, bedType: c.bedType, etaMin: c.etaMin })}\n\nDraft (improve it):\n${fallback}`,
    });
    return { text: out.sbar || fallback, engine: aiProvider() };
  } catch (err) {
    return { text: fallback, engine: 'template', aiError: describeError(err) };
  }
}
