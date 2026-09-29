// Hospital capability vocabulary shared by the triage engine, the hospital
// registry and the UI. A capability is "live" only when the hospital has it
// AND (for specialist services) a specialist is on duty AND (for equipment)
// the machine is working right now.

export const CAPABILITIES = {
  emergency:    { en: '24×7 Emergency',        hi: '24×7 इमरजेंसी',        icon: '🚑' },
  icu:          { en: 'ICU',                   hi: 'आईसीयू',               icon: '🛏️' },
  ventilator:   { en: 'Ventilator',            hi: 'वेंटिलेटर',             icon: '🫁' },
  cardiology:   { en: 'Cardiologist',          hi: 'हृदय रोग विशेषज्ञ',     icon: '❤️' },
  cath_lab:     { en: 'Cath Lab (angioplasty)', hi: 'कैथ लैब',             icon: '🫀' },
  neurology:    { en: 'Neurologist',           hi: 'न्यूरोलॉजिस्ट',          icon: '🧠' },
  thrombolysis: { en: 'Stroke thrombolysis',   hi: 'स्ट्रोक थ्रोम्बोलिसिस',   icon: '💉' },
  ct_scan:      { en: 'CT Scan',               hi: 'सीटी स्कैन',            icon: '🩻' },
  mri:          { en: 'MRI',                   hi: 'एमआरआई',               icon: '🧲' },
  trauma:       { en: 'Trauma surgeon',        hi: 'ट्रॉमा सर्जन',           icon: '🩹' },
  neurosurgery: { en: 'Neurosurgeon',          hi: 'न्यूरो सर्जन',           icon: '🧠' },
  orthopedics:  { en: 'Orthopaedics',          hi: 'हड्डी रोग',             icon: '🦴' },
  burns:        { en: 'Burns unit',            hi: 'बर्न यूनिट',             icon: '🔥' },
  obstetrics:   { en: 'Obstetrician / Labour room', hi: 'प्रसूति विशेषज्ञ / लेबर रूम', icon: '🤰' },
  nicu:         { en: 'NICU / SNCU',           hi: 'नवजात आईसीयू',          icon: '👶' },
  pediatrics:   { en: 'Paediatrician',         hi: 'बाल रोग विशेषज्ञ',       icon: '🧒' },
  blood_bank:   { en: 'Blood bank',            hi: 'ब्लड बैंक',              icon: '🩸' },
  anti_venom:   { en: 'Anti-snake venom',      hi: 'एंटी स्नेक वेनम',        icon: '🐍' },
  toxicology:   { en: 'Poison management',     hi: 'ज़हर उपचार',             icon: '☠️' },
  dialysis:     { en: 'Dialysis',              hi: 'डायलिसिस',              icon: '💧' },
  anti_rabies:  { en: 'Anti-rabies vaccine',   hi: 'एंटी रेबीज़ टीका',        icon: '🐕' },
};

// Capabilities that need a human specialist physically on duty.
export const SPECIALIST_CAPS = new Set([
  'cardiology', 'neurology', 'trauma', 'neurosurgery', 'orthopedics',
  'obstetrics', 'pediatrics',
]);

// Capabilities that depend on a machine that can break down.
export const EQUIPMENT_CAPS = new Set(['cath_lab', 'ct_scan', 'mri', 'ventilator', 'dialysis']);

export function capLabel(cap, lang = 'en') {
  const c = CAPABILITIES[cap];
  return c ? (c[lang] || c.en) : cap;
}

/**
 * Is a capability usable at this hospital right now?
 * Returns { cap, has, live, reason }.
 */
export function checkCapability(hospital, cap) {
  const has = hospital.capabilities.includes(cap);
  if (!has) return { cap, has: false, live: false, reason: 'not_available' };
  const status = hospital.status || {};
  if (EQUIPMENT_CAPS.has(cap) && (status.equipmentDown || []).includes(cap)) {
    return { cap, has: true, live: false, reason: 'equipment_down' };
  }
  if (cap === 'ventilator' && status.ventilatorsFree === 0) {
    return { cap, has: true, live: false, reason: 'all_in_use' };
  }
  if (SPECIALIST_CAPS.has(cap) && !(status.onDuty || []).includes(cap)) {
    return { cap, has: true, live: false, reason: 'specialist_off_duty' };
  }
  return { cap, has: true, live: true, reason: 'ok' };
}
