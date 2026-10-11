// Recurrence, "rrule-lite": weekly on one or more weekdays, optionally until a date.
// Series are defined in wall-clock terms (date 'YYYY-MM-DD', time 'HH:mm', school time zone) so a
// 19:00 lesson stays at 19:00 local time; each occurrence is converted to UTC on its own date.
import { wallClockToUtc } from './dates';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WeeklyRule {
  byDay: Weekday[];
  /** Last date (inclusive) an occurrence may fall on, 'YYYY-MM-DD'. */
  until?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isWallDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const isWallTime = (s: string) => TIME_RE.test(s);

export function formatRrule(rule: WeeklyRule): string {
  const days = WEEKDAYS.filter((d) => rule.byDay.includes(d));
  if (days.length === 0) throw new Error('A weekly rule needs at least one day');
  const parts = ['FREQ=WEEKLY', `BYDAY=${days.join(',')}`];
  if (rule.until) parts.push(`UNTIL=${rule.until.replaceAll('-', '')}`);
  return parts.join(';');
}

export function parseRrule(text: string): WeeklyRule {
  const fields = new Map(
    text.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim().toUpperCase() ?? '', v?.trim().toUpperCase() ?? ''] as const;
    }),
  );
  if (fields.get('FREQ') !== 'WEEKLY') throw new Error(`Only weekly rules are supported: ${text}`);
  const byDay = (fields.get('BYDAY') ?? '').split(',').filter(Boolean);
  if (byDay.length === 0 || !byDay.every((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d))) {
    throw new Error(`Bad BYDAY in ${text}`);
  }
  const u = fields.get('UNTIL');
  const until = u ? `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` : null;
  if (until && !isWallDate(until)) throw new Error(`Bad UNTIL in ${text}`);
  return { byDay: WEEKDAYS.filter((d) => byDay.includes(d)), until };
}

/** Calendar arithmetic on wall dates (no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  // getUTCDay: 0 = Sunday
  return WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

/** The wall-clock date of an instant in a time zone, 'YYYY-MM-DD'. */
export function wallDateOf(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The wall-clock time of an instant in a time zone, 'HH:mm'. */
export function wallTimeOf(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

export interface Occurrence {
  /** The occurrence's wall date, also its identity within the series. */
  date: string;
  startAt: Date;
}

export interface OccurrenceQuery {
  /** First date the series may produce (its start date). */
  startDate: string;
  time: string;
  timeZone: string;
  rule: WeeklyRule;
  /** Window, wall dates: from inclusive, to exclusive. */
  from: string;
  to: string;
  exdates?: readonly string[];
}

/** Occurrences of a weekly series inside [from, to), skipping exdates and anything after `until`. */
export function weeklyOccurrences(q: OccurrenceQuery): Occurrence[] {
  if (!isWallDate(q.startDate) || !isWallDate(q.from) || !isWallDate(q.to)) throw new Error('Bad date');
  if (!isWallTime(q.time)) throw new Error(`Bad time ${q.time}`);
  const skip = new Set(q.exdates ?? []);
  const out: Occurrence[] = [];
  let d = q.from > q.startDate ? q.from : q.startDate;
  for (; d < q.to; d = addDays(d, 1)) {
    if (q.rule.until && d > q.rule.until) break;
    if (!q.rule.byDay.includes(weekdayOf(d)) || skip.has(d)) continue;
    out.push({ date: d, startAt: wallClockToUtc(d, q.time, q.timeZone) });
  }
  return out;
}

/** Weeks of lessons kept materialised ahead of today. */
export const MATERIALISE_WEEKS = 12;
