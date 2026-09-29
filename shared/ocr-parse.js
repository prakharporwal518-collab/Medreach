// Sehat Setu – turn raw OCR text from an Ayushman card, ABHA card,
// prescription or old discharge summary into structured patient details the
// emergency doctor needs *before* the patient arrives.

const CONDITIONS = [
  ['diabetes', /diabet|dm\s*type|t2dm|sugar|मधुमेह|शुगर/i],
  ['hypertension', /hypertens|\bhtn\b|high\s*bp|blood\s*pressure|उच्च\s*रक्तचाप|बीपी/i],
  ['heart disease', /\bcad\b|ischemic|ischaemic|angina|\bmi\b|stent|cabg|हृदय\s*रोग/i],
  ['asthma / COPD', /asthma|copd|दमा/i],
  ['epilepsy', /epilep|seizure\s*disorder|मिर्गी/i],
  ['kidney disease', /\bckd\b|renal|kidney|dialysis|गुर्दे/i],
  ['pregnancy', /pregnan|\banc\b|lmp|edd|गर्भ/i],
  ['tuberculosis', /\btb\b|tubercul|क्षय/i],
  ['thyroid', /thyroid|hypothyroid|थायराइड/i],
];

const MEDICINE_HINTS = /\b(tab|cap|inj|syp|tablet|capsule|syrup)\.?\s+([A-Za-z][A-Za-z0-9\- ]{2,30}?)(?=\s+\d|\s*[-,(]|\s+(?:od|bd|tds|qid|hs|sos)\b|$)/gim;

/**
 * @param {string} raw OCR text (English and/or Hindi)
 * @returns {{name?:string, age?:number, gender?:string, bloodGroup?:string,
 *   abhaId?:string, ayushmanId?:string, phone?:string, conditions:string[],
 *   allergies:string[], medicines:string[], fieldsFound:number}}
 */
export function parseHealthDocument(raw = '') {
  const text = String(raw).replace(/\r/g, '');
  const flat = text.replace(/\s+/g, ' ');
  const out = { conditions: [], allergies: [], medicines: [] };

  const name = text.match(/(?:^|\n)\s*(?:patient\s*name|name|नाम)\s*[:\-.]?\s*([A-Za-zऀ-ॿ .]{3,40})/i);
  if (name) out.name = name[1].replace(/\s+/g, ' ').trim().replace(/\b(age|dob|gender|sex)\b.*$/i, '').trim();

  const age = flat.match(/(?:age|आयु|उम्र)\s*[:\-/]?\s*(\d{1,3})/i) || flat.match(/(\d{1,3})\s*(?:y(?:ea)?rs?|y\/o|वर्ष|साल)\b/i);
  if (age && +age[1] > 0 && +age[1] < 120) out.age = +age[1];
  if (!out.age) {
    const yob = flat.match(/(?:year\s*of\s*birth|yob|dob|जन्म\s*तिथि|जन्म\s*वर्ष)\s*[:\-]?\s*(?:\d{1,2}[/\-.]\d{1,2}[/\-.])?((?:19|20)\d{2})/i);
    if (yob) out.age = new Date().getFullYear() - +yob[1];
  }

  // (JS \b only understands ASCII letters, so Devanagari words are matched separately.)
  const gender = flat.match(/(?<![a-z])(female|male|transgender)(?![a-z])/i) || flat.match(/(पुरुष|महिला|स्त्री)/)
    || flat.match(/(?:sex|gender|लिंग)\s*[:\-/]?\s*([MF])\b/i);
  if (gender) {
    const g = gender[1].toLowerCase();
    out.gender = /^(female|f|महिला|स्त्री)$/.test(g) ? 'Female' : /^(male|m|पुरुष)$/.test(g) ? 'Male' : 'Other';
  }

  const blood = flat.match(/(?:blood\s*(?:group|grp)?|b\.?\s*g\.?|रक्त\s*समूह)\s*[:\-]?\s*(AB|A|B|O)\s*([+-]|\s?(?:pos|neg|positive|negative|\+ve|-ve))/i);
  if (blood) {
    const sign = /[-]|neg/i.test(blood[2]) ? '-' : '+';
    out.bloodGroup = blood[1].toUpperCase() + sign;
  }

  // ABHA number: 14 digits, printed as 91-1234-5678-9012 or plain.
  const abha = flat.match(/\b(\d{2}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})\b/);
  if (abha) out.abhaId = abha[1].replace(/\s/g, '-');
  const pmjay = flat.match(/(?:pm-?jay|ayushman|आयुष्मान)[^A-Z0-9]{0,20}(?:id|no\.?|number|कार्ड)?\s*[:\-]?\s*([A-Z0-9]{8,12})/i);
  if (pmjay && /\d/.test(pmjay[1])) out.ayushmanId = pmjay[1].toUpperCase();

  const phone = flat.match(/(?:\+91[\s-]?)?\b([6-9]\d{9})\b/);
  if (phone) out.phone = phone[1];

  for (const [label, re] of CONDITIONS) if (re.test(flat)) out.conditions.push(label);

  // Match line-by-line so the next line (e.g. a medicine) is not swallowed.
  const allergy = text.match(/(?:allerg(?:y|ies|ic)(?:[ \t]*to)?|एलर्जी)[ \t]*[:\-]?[ \t]*([A-Za-zऀ-ॿ ,/]{3,60})/i);
  if (allergy && !/^\s*(nil|none|no|nkda|nka)\b/i.test(allergy[1])) {
    out.allergies = allergy[1].split(/[,/]| and /).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 5);
  }

  for (const m of text.matchAll(MEDICINE_HINTS)) {
    const med = m[2].trim();
    if (med && !out.medicines.includes(med)) out.medicines.push(med);
    if (out.medicines.length >= 8) break;
  }

  out.fieldsFound = ['name', 'age', 'gender', 'bloodGroup', 'abhaId', 'ayushmanId', 'phone']
    .filter((k) => out[k] !== undefined).length + (out.conditions.length ? 1 : 0) + (out.allergies.length ? 1 : 0) + (out.medicines.length ? 1 : 0);
  return out;
}
