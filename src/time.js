// Local calendar time: limits reset at midnight, weeks start on Monday, and the
// check-in runs at 17:00 on this computer's clock.

export const HOUR = 60 * 60 * 1000;

export function startOfDay(at) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(at, n) {
  const d = new Date(at);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

// 2026-10-17
export function dayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fromDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export const isDayKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && dayKey(fromDayKey(v)) === v;

// Monday of the week `at` falls in.
export function weekStart(at) {
  const day = startOfDay(at);
  const weekday = (new Date(day).getDay() + 6) % 7; // Monday = 0
  return addDays(day, -weekday);
}

export const weekKey = (at) => dayKey(weekStart(at));

export const isWeekday = (at) => ![0, 6].includes(new Date(at).getDay());

// "17:00" today, as a timestamp.
export function atTime(at, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(at);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export const isClockTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
