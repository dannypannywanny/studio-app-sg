import { describe, expect, it } from 'vitest';
import { openSlots, resolveAvailability, slotLockId, type Availability } from './availability';
import { wallClockToUtc } from './dates';

const TZ = 'Asia/Singapore';
const at = (date: string, time: string) => wallClockToUtc(date, time, TZ);
const times = (slots: { startAt: Date }[]) =>
  slots.map((s) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(s.startAt));

// 2026-10-19 is a Monday.
const MONDAY: Availability = {
  weekly: [{ day: 'MO', start: '10:00', end: '12:00', inPerson: true, online: true, locationId: 'studio' }],
  minNoticeHours: 0,
  horizonDays: 14,
};
const sunday = at('2026-10-18', '09:00');

describe('resolveAvailability', () => {
  it('fills defaults and drops bad entries', () => {
    const av = resolveAvailability({
      weekly: [
        { day: 'MO', start: '10:00', end: '12:00', inPerson: true },
        { day: 'XX', start: '10:00', end: '12:00', inPerson: true },
        { day: 'TU', start: '12:00', end: '10:00', online: true },
        { day: 'WE', start: '10:00', end: '12:00' },
        null,
      ],
      exceptions: [{ date: 'nope' }, { date: '2026-10-20', ranges: [] }],
      lessonMin: 2,
      bufferMin: 30,
    });
    expect(av.weekly).toEqual([{ day: 'MO', start: '10:00', end: '12:00', inPerson: true, online: false, locationId: null }]);
    expect(av.exceptions).toEqual([{ date: '2026-10-20', closed: true, ranges: [] }]);
    expect(av).toMatchObject({ bookable: true, lessonMin: 45, stepMin: 30, bufferMin: 30, minNoticeHours: 12, horizonDays: 28 });
  });

  it('treats a missing doc as no hours', () => {
    expect(openSlots(resolveAvailability(undefined), { timeZone: TZ, now: sunday, busy: [] })).toEqual([]);
  });
});

describe('openSlots', () => {
  const av = resolveAvailability(MONDAY);
  const mondayOnly = { timeZone: TZ, now: sunday, to: at('2026-10-20', '00:00') };

  it('steps through each block, leaving room for the whole lesson', () => {
    const slots = openSlots(av, { ...mondayOnly, busy: [] });
    expect(times(slots)).toEqual(['10:00', '10:30', '11:00']);
    expect(slots[0]).toMatchObject({ inPerson: true, online: true, locationId: 'studio' });
    expect(slots[0]!.endAt.getTime() - slots[0]!.startAt.getTime()).toBe(45 * 60_000);
  });

  it('keeps the buffer around busy lessons', () => {
    const busy = [{ startMs: at('2026-10-19', '11:15').getTime(), endMs: at('2026-10-19', '12:00').getTime() }];
    // 10:30 + 45 min = 11:15, plus a 15 min buffer, runs into the busy lesson.
    expect(times(openSlots(av, { ...mondayOnly, busy }))).toEqual(['10:00']);
    const noBuffer = resolveAvailability({ ...MONDAY, bufferMin: 0 });
    expect(times(openSlots(noBuffer, { ...mondayOnly, busy }))).toEqual(['10:00', '10:30']);
  });

  it('respects minimum notice and the horizon', () => {
    // Sunday 09:00 + 25 h = Monday 10:00, still bookable; 26 h drops 10:00 and 10:30.
    const noticed = resolveAvailability({ ...MONDAY, minNoticeHours: 25 });
    expect(times(openSlots(noticed, { ...mondayOnly, busy: [] }))).toEqual(['10:00', '10:30', '11:00']);
    const later = resolveAvailability({ ...MONDAY, minNoticeHours: 26 });
    expect(times(openSlots(later, { ...mondayOnly, busy: [] }))).toEqual(['11:00']);
    const short = resolveAvailability({ ...MONDAY, horizonDays: 1 });
    expect(openSlots(short, { timeZone: TZ, now: sunday, busy: [] })).toEqual([]);
    // Two weeks ahead: two Mondays.
    expect(openSlots(av, { timeZone: TZ, now: sunday, busy: [] })).toHaveLength(6);
  });

  it('applies exceptions: closed days and replacement hours', () => {
    const withExceptions = resolveAvailability({
      ...MONDAY,
      exceptions: [
        { date: '2026-10-19', closed: true },
        { date: '2026-10-26', ranges: [{ start: '14:00', end: '15:00', online: true, inPerson: false }] },
        { date: '2026-10-21', ranges: [{ start: '09:00', end: '09:45' }] },
      ],
    });
    const slots = openSlots(withExceptions, { timeZone: TZ, now: sunday, busy: [] });
    expect(slots.map((s) => s.startAt.toISOString())).toEqual([
      at('2026-10-21', '09:00').toISOString(),
      at('2026-10-26', '14:00').toISOString(),
    ]);
    expect(slots[1]).toMatchObject({ inPerson: false, online: true, locationId: null });
  });

  it('merges overlapping blocks into one slot per start', () => {
    const two = resolveAvailability({
      ...MONDAY,
      weekly: [
        { day: 'MO', start: '10:00', end: '11:00', inPerson: true, online: false, locationId: 'studio' },
        { day: 'MO', start: '10:00', end: '11:00', inPerson: false, online: true },
      ],
    });
    const slots = openSlots(two, { ...mondayOnly, busy: [] });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ inPerson: true, online: true, locationId: 'studio' });
  });

  it('offers nothing when the teacher is not bookable', () => {
    expect(openSlots(resolveAvailability({ ...MONDAY, bookable: false }), { timeZone: TZ, now: sunday, busy: [] })).toEqual([]);
  });
});

describe('slotLockId', () => {
  it('keys by teacher and the school-zone date', () => {
    // 23:30 UTC on the 18th is already the 19th in Singapore.
    expect(slotLockId('t1', new Date('2026-10-18T23:30:00Z'), TZ)).toBe('t1_20261019');
  });
});

describe('time off', () => {
  const tz = 'Asia/Singapore';
  const av = resolveAvailability({
    weekly: [{ day: 'MO', start: '10:00', end: '14:00', inPerson: true, online: true }],
    lessonMin: 60,
    stepMin: 60,
    bufferMin: 0,
    minNoticeHours: 0,
    horizonDays: 30,
    timeOff: [
      { id: 'a', date: '2030-01-07', start: '11:00', end: '12:30', note: 'Dentist' },
      { id: 'b', date: '2030-01-14', start: '00:00', end: '24:00' },
      { id: 'bad', date: 'nope', start: '11:00', end: '12:00' },
    ],
  });
  const now = wallClockToUtc('2030-01-06', '09:00', tz);
  const starts = (date: string) =>
    openSlots(av, { timeZone: tz, now, busy: [], from: wallClockToUtc(date, '00:00', tz), to: wallClockToUtc(date, '23:59', tz) }).map((x) =>
      x.startAt.toISOString(),
    );

  it('drops malformed entries', () => expect(av.timeOff.map((t) => t.id)).toEqual(['a', 'b']));
  it('hides slots overlapping a block, keeps the rest', () =>
    expect(starts('2030-01-07')).toEqual(['10:00', '13:00'].map((t) => wallClockToUtc('2030-01-07', t, tz).toISOString())));
  it('an all-day block closes the day', () => expect(starts('2030-01-14')).toEqual([]));
});
