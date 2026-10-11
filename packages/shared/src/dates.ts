// Times are stored in UTC and shown in the school's time zone (Asia/Singapore for school #1).

/** Minutes the zone is ahead of UTC at a given instant (Singapore: 480). */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - (at.getTime() - at.getMilliseconds())) / 60000);
}

/** A wall-clock date ('2026-10-12') and time ('19:30') in `timeZone`, as a UTC instant. */
export function wallClockToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if ([y, m, d, hh, mm].some((n) => n === undefined || Number.isNaN(n))) {
    throw new Error(`Bad date/time: ${date} ${time}`);
  }
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const first = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
  // Second pass settles zones whose offset differs either side of the guess (DST).
  return new Date(guess - tzOffsetMinutes(new Date(first), timeZone) * 60000);
}

export function formatDateTime(at: Date, timeZone: string, locale = 'en-SG'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

export function formatDate(at: Date, timeZone: string, locale = 'en-SG'): string {
  return new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}

/** Lots with no expiry get a far-future validUntil so "earliest-expiring first" can order on it. */
export const NO_EXPIRY = new Date(Date.UTC(9999, 11, 31));
