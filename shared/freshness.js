// How fresh is a hospital's reported availability?
//
//   🟢 fresh  – verified by authorised hospital staff < 15 min ago
//   🟡 aging  – verified 15–60 min ago (treat with caution)
//   🔴 stale  – older than 60 min, or never verified → "availability unverified"
//
// Stale capacity is never presented as confirmed: the matching engine lowers
// its weight, and only an accepted referral turns it into a confirmed bed.

export const FRESH_MIN = 15;
export const STALE_MIN = 60;

export function freshness(verifiedAt, now = Date.now()) {
  const t = verifiedAt ? Date.parse(verifiedAt) : NaN;
  if (!Number.isFinite(t)) {
    return { level: 'stale', minutes: null, verified: false };
  }
  const minutes = Math.max(0, Math.round((now - t) / 60000));
  const level = minutes < FRESH_MIN ? 'fresh' : minutes < STALE_MIN ? 'aging' : 'stale';
  return { level, minutes, verified: level !== 'stale' };
}

export function ago(minutes, lang = 'en') {
  if (minutes === null || minutes === undefined) return lang === 'hi' ? 'कभी नहीं' : 'never';
  if (minutes < 1) return lang === 'hi' ? 'अभी' : 'just now';
  if (minutes < 60) return lang === 'hi' ? `${minutes} मिनट पहले` : `${minutes} min ago`;
  const h = Math.round(minutes / 60);
  return lang === 'hi' ? `${h} घंटे पहले` : `${h} h ago`;
}

export function freshnessLabel(f, lang = 'en') {
  const hi = lang === 'hi';
  if (f.level === 'fresh') return { icon: '🟢', text: hi ? `${ago(f.minutes, lang)} सत्यापित` : `Verified ${ago(f.minutes, lang)}` };
  if (f.level === 'aging') return { icon: '🟡', text: hi ? `${ago(f.minutes, lang)} सत्यापित – पुष्टि ज़रूरी` : `Verified ${ago(f.minutes, lang)} – may have changed` };
  return {
    icon: '🔴',
    text: hi ? `उपलब्धता असत्यापित (${ago(f.minutes, lang)})` : `Availability unverified (${f.minutes === null ? 'never verified' : `last ${ago(f.minutes, lang)}`})`,
  };
}
