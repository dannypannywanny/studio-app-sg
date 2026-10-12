// Dates and times in the school's zone. Students may be abroad (online lessons), so pages say which
// zone times are in whenever the browser's zone is different.
import { wallDateOf } from '@lessonkaki/shared';

const fmt = (tz: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-SG', { timeZone: tz, ...opts });

/** "Mon 19 Oct" */
export const dayLabel = (d: Date, tz: string) => fmt(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
/** "Monday 19 October" */
export const longDayLabel = (d: Date, tz: string) => fmt(tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
/** "10:30 am" */
export const timeLabel = (d: Date, tz: string) => fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(d).replace(/\s?([ap])\.?m\.?$/i, ' $1m').toLowerCase();
/** "10:30 - 11:15 am" style, with both ends. */
export const timeRange = (start: Date, end: Date, tz: string) => `${timeLabel(start, tz)} - ${timeLabel(end, tz)}`;

/** "Today", "Tomorrow", or the day label. */
export function relativeDay(d: Date, tz: string, now = new Date()): string {
  const day = wallDateOf(d, tz);
  if (day === wallDateOf(now, tz)) return 'Today';
  if (day === wallDateOf(new Date(now.getTime() + 86_400_000), tz)) return 'Tomorrow';
  return dayLabel(d, tz);
}

/** The browser's zone, when it differs from the school's (e.g. "Europe/London"); null when the same. */
export function otherZone(schoolTz: string): string | null {
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!mine) return null;
  const probe = new Date();
  const offset = (tz: string) => fmt(tz, { timeZoneName: 'shortOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value;
  return offset(mine) === offset(schoolTz) ? null : mine;
}

/** "Singapore time" for Asia/Singapore, else the zone's short name. */
export function zoneName(tz: string): string {
  if (tz === 'Asia/Singapore') return 'Singapore time';
  return fmt(tz, { timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz;
}
