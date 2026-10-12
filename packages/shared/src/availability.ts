// Teacher booking hours and the open slots they produce (architecture §3 `availability/{teacherId}`).
// Hours are wall-clock in the school's time zone; slots come out as UTC instants. Pure: the busy
// intervals (the teacher's lessons) are passed in, so the same function runs in getAvailability, in
// bookLesson's transaction, and in tests.
import { wallClockToUtc } from './dates';
import { addDays, isWallDate, isWallTime, wallDateOf, weekdayOf, WEEKDAYS, type Weekday } from './rrule';

export const LESSON_MODES = ['inPerson', 'online'] as const;
export type LessonMode = (typeof LESSON_MODES)[number];

/** One block of weekly hours, e.g. Monday 10:00-18:00, in person and online. */
export interface WeeklyHours {
  day: Weekday;
  start: string;
  end: string;
  inPerson: boolean;
  online: boolean;
  /** Where in-person lessons in this block happen (a locations/{id}); null = the school's default. */
  locationId?: string | null;
}

/** A date that differs from the weekly hours: closed, or open only for `ranges`. */
export interface HoursException {
  date: string;
  closed?: boolean;
  ranges?: { start: string; end: string; inPerson?: boolean; online?: boolean; locationId?: string | null }[];
}

/** `schools/{s}/availability/{teacherId}`. Missing numbers fall back to AVAILABILITY_DEFAULTS. */
export interface Availability {
  /** false hides the teacher from booking without deleting the hours. */
  bookable?: boolean;
  /** The subject booked lessons are for; defaults to the teacher's first subject. */
  subjectId?: string | null;
  weekly: WeeklyHours[];
  exceptions?: HoursException[];
  /** Length of a booked lesson. */
  lessonMin?: number;
  /** Slots start every `stepMin` from the start of each block. */
  stepMin?: number;
  /** Gap kept free before and after the teacher's other lessons. */
  bufferMin?: number;
  /** Earliest a student may book, in hours from now. */
  minNoticeHours?: number;
  /** How far ahead students may book, in days. */
  horizonDays?: number;
}

export const AVAILABILITY_DEFAULTS = {
  lessonMin: 45,
  stepMin: 30,
  bufferMin: 15,
  minNoticeHours: 12,
  horizonDays: 28,
} as const;

/** Availability with every number filled in and bad entries dropped. */
export type ResolvedAvailability = Required<Omit<Availability, 'subjectId'>> & { subjectId: string | null };

const LIMITS = {
  lessonMin: [15, 240],
  stepMin: [5, 240],
  bufferMin: [0, 120],
  minNoticeHours: [0, 24 * 14],
  horizonDays: [1, 120],
} as const;

export const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMinutes = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Accepts '24:00' as an end of day as well as the usual 'HH:mm'. */
const isEnd = (s: unknown): s is string => typeof s === 'string' && (isWallTime(s) || s === '24:00');
const okRange = (start: unknown, end: unknown): boolean =>
  typeof start === 'string' && isWallTime(start) && isEnd(end) && toMinutes(end) > toMinutes(start);

function num(raw: unknown, key: keyof typeof LIMITS): number {
  const [min, max] = LIMITS[key];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : AVAILABILITY_DEFAULTS[key];
}

type Raw = Record<string, unknown>;
const records = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === 'object') : []);

/** Makes a stored availability doc safe to use: unknown or invalid entries are dropped, defaults filled. */
export function resolveAvailability(raw: unknown): ResolvedAvailability {
  const doc = (raw ?? {}) as Raw;
  const weekly: WeeklyHours[] = records(doc.weekly).flatMap((w) =>
    (WEEKDAYS as readonly unknown[]).includes(w.day) && okRange(w.start, w.end) && (w.inPerson === true || w.online === true)
      ? [
          {
            day: w.day as Weekday,
            start: w.start as string,
            end: w.end as string,
            inPerson: w.inPerson === true,
            online: w.online === true,
            locationId: typeof w.locationId === 'string' ? w.locationId : null,
          },
        ]
      : [],
  );
  const exceptions: HoursException[] = records(doc.exceptions).flatMap((e) => {
    if (typeof e.date !== 'string' || !isWallDate(e.date)) return [];
    if (e.closed === true) return [{ date: e.date, closed: true, ranges: [] }];
    const ranges = records(e.ranges).flatMap((r) =>
      okRange(r.start, r.end)
        ? [
            {
              start: r.start as string,
              end: r.end as string,
              inPerson: r.inPerson !== false,
              online: r.online !== false,
              locationId: typeof r.locationId === 'string' ? r.locationId : null,
            },
          ]
        : [],
    );
    return [{ date: e.date, closed: ranges.length === 0, ranges }];
  });
  return {
    bookable: doc.bookable !== false,
    subjectId: typeof doc.subjectId === 'string' && doc.subjectId ? doc.subjectId : null,
    weekly,
    exceptions,
    lessonMin: num(doc.lessonMin, 'lessonMin'),
    stepMin: num(doc.stepMin, 'stepMin'),
    bufferMin: num(doc.bufferMin, 'bufferMin'),
    minNoticeHours: num(doc.minNoticeHours, 'minNoticeHours'),
    horizonDays: num(doc.horizonDays, 'horizonDays'),
  };
}

/** A time the teacher is taken: [startMs, endMs). */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

export interface Slot {
  startAt: Date;
  endAt: Date;
  inPerson: boolean;
  online: boolean;
  locationId: string | null;
}

export interface SlotQuery {
  timeZone: string;
  now: Date;
  busy: readonly BusyInterval[];
  /** Optional narrower window (still clipped to notice and horizon). */
  from?: Date;
  to?: Date;
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** The bookable window for `now`: [now + notice, now + horizon]. */
export function bookingWindow(av: ResolvedAvailability, now: Date): { fromMs: number; toMs: number } {
  return { fromMs: now.getTime() + av.minNoticeHours * HOUR_MS, toMs: now.getTime() + av.horizonDays * DAY_MS };
}

type Block = Omit<WeeklyHours, 'day'>;

/** The hours that apply on one wall date: an exception replaces the weekly hours for that date. */
export function hoursOn(av: ResolvedAvailability, date: string): Block[] {
  const exception = av.exceptions.find((e) => e.date === date);
  if (exception) {
    return (exception.ranges ?? []).map((r) => ({ ...r, inPerson: r.inPerson !== false, online: r.online !== false }));
  }
  const day = weekdayOf(date);
  return av.weekly.filter((w) => w.day === day);
}

/** Open slots, sorted by start. A start offered by two blocks merges their modes. */
export function openSlots(av: ResolvedAvailability, q: SlotQuery): Slot[] {
  if (!av.bookable) return [];
  const window = bookingWindow(av, q.now);
  const fromMs = Math.max(window.fromMs, q.from?.getTime() ?? -Infinity);
  const toMs = Math.min(window.toMs, q.to?.getTime() ?? Infinity);
  if (fromMs > toMs) return [];
  const lessonMs = av.lessonMin * MIN_MS;
  const bufferMs = av.bufferMin * MIN_MS;
  const free = (start: number, end: number) => !q.busy.some((b) => b.startMs < end + bufferMs && b.endMs > start - bufferMs);

  const byStart = new Map<number, Slot>();
  const lastDate = wallDateOf(new Date(toMs), q.timeZone);
  for (let date = wallDateOf(new Date(fromMs), q.timeZone); date <= lastDate; date = addDays(date, 1)) {
    for (const block of hoursOn(av, date)) {
      const endMin = toMinutes(block.end);
      for (let m = toMinutes(block.start); m + av.lessonMin <= endMin; m += av.stepMin) {
        const start = wallClockToUtc(date, fromMinutes(m), q.timeZone).getTime();
        const end = start + lessonMs;
        if (start < fromMs || start > toMs || !free(start, end)) continue;
        const seen = byStart.get(start);
        if (seen) {
          seen.inPerson ||= block.inPerson;
          seen.online ||= block.online;
          if (block.inPerson) seen.locationId ??= block.locationId ?? null;
          continue;
        }
        byStart.set(start, {
          startAt: new Date(start),
          endAt: new Date(end),
          inPerson: block.inPerson,
          online: block.online,
          locationId: block.inPerson ? (block.locationId ?? null) : null,
        });
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * Booking lock per teacher per day, `<teacherId>_<yyyyMMdd>` (school zone). Every portal booking reads
 * and writes the lock for its day, so two bookings for the same teacher and day run one after the
 * other and the second sees the first's lesson. A per-start lock would let 10:00 and 10:30 overlap.
 */
export function slotLockId(teacherId: string, at: Date, timeZone: string): string {
  return `${teacherId}_${wallDateOf(at, timeZone).replaceAll('-', '')}`;
}
