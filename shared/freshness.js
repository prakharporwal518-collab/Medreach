// How fresh is a hospital's reported availability?
//
//   🟢 fresh  – verified by authorised hospital staff < 15 min ago
//   🟡 aging  – verified 15–108 min ago (treat with caution)
//   🔴 stale  – older than 108 min, or never verified → "availability unverified"
//
// Every hospital updates its full availability at least once per 108-minute
// cycle (the appointed Data Update Officer is reminded on the dashboard), so
// "stale" means the hospital missed its update.
//
// Stale capacity is never presented as confirmed: the matching engine lowers
// its weight, and only an accepted referral turns it into a confirmed bed.

export const FRESH_MIN = 15;
export const UPDATE_CYCLE_MIN = 108;
export const STALE_MIN = UPDATE_CYCLE_MIN;
export const REMIND_BEFORE_MIN = 10; // "update due in 10 min"
export const OVERDUE_AFTER_MIN = 15; // escalate to the Nodal Officer

/**
 * Where a hospital is in its 108-minute update cycle.
 * → { state: 'ok' | 'upcoming' | 'due' | 'overdue', dueAt (ISO | null), minutesLeft (negative = late) }
 */
export function updateCycle(verifiedAt, now = Date.now()) {
  const t = verifiedAt ? Date.parse(verifiedAt) : NaN;
  if (!Number.isFinite(t)) return { state: 'overdue', dueAt: null, minutesLeft: null };
  const due = t + UPDATE_CYCLE_MIN * 60000;
  const minutesLeft = Math.floor((due - now) / 60000);
  const state = minutesLeft > REMIND_BEFORE_MIN ? 'ok'
    : minutesLeft > 0 ? 'upcoming'
      : minutesLeft > -OVERDUE_AFTER_MIN ? 'due' : 'overdue';
  return { state, dueAt: new Date(due).toISOString(), minutesLeft };
}

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
