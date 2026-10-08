// Settings pasted into a hosting dashboard often carry stray spaces, quotes or
// different capitals ("ON", " on", "\"on\""). Clean our own settings once, before
// anything reads them, so a copy-paste slip can't silently switch a feature off.
// Imported first by server/index.js.

const OURS = /^(SEHAT_|GEMINI_|ANTHROPIC_)/;

export function cleanValue(v) {
  let s = String(v ?? '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1).trim();
  return s;
}

/** true for on / true / yes / 1 (any capitals). */
export const isOn = (v) => ['on', 'true', 'yes', '1'].includes(cleanValue(v).toLowerCase());

/** A URL typed without https:// still works. */
export function cleanUrl(v) {
  const s = cleanValue(v);
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function cleanEnv(env = process.env) {
  for (const k of Object.keys(env)) if (OURS.test(k) && typeof env[k] === 'string') env[k] = cleanValue(env[k]);
  if (env.SEHAT_EMS_URL) env.SEHAT_EMS_URL = cleanUrl(env.SEHAT_EMS_URL);
  return env;
}

cleanEnv(process.env);
