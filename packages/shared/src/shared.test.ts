import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  addDays,
  consumesCredit,
  formatMoney,
  formatRrule,
  parseRrule,
  resolvePolicy,
  startOfWeek,
  wallClockToUtc,
  wallDateOf,
  weekdayOf,
  weeklyOccurrences,
} from './index';

describe('consumesCredit', () => {
  it('present always uses a credit, booked never does', () => {
    expect(consumesCredit('present', DEFAULT_POLICY)).toBe(true);
    expect(consumesCredit('booked', DEFAULT_POLICY)).toBe(false);
  });
  it('absent follows absentConsumesCredit', () => {
    expect(consumesCredit('absent', DEFAULT_POLICY)).toBe(true);
    expect(consumesCredit('absent', { ...DEFAULT_POLICY, absentConsumesCredit: false })).toBe(false);
  });
  it('late cancel follows lateCancelReturnsCredit', () => {
    expect(consumesCredit('lateCancelled', DEFAULT_POLICY)).toBe(false);
    expect(consumesCredit('lateCancelled', { ...DEFAULT_POLICY, lateCancelReturnsCredit: false })).toBe(true);
  });
  it('resolvePolicy fills missing fields from the defaults', () => {
    expect(resolvePolicy({ absentConsumesCredit: false })).toEqual({ ...DEFAULT_POLICY, absentConsumesCredit: false });
    expect(resolvePolicy(undefined)).toEqual(DEFAULT_POLICY);
  });
});

describe('formatMoney', () => {
  it('formats integer cents', () => {
    expect(formatMoney(30000)).toBe('$300.00');
    expect(formatMoney(5)).toBe('$0.05');
  });
  it('rejects fractional cents', () => {
    expect(() => formatMoney(10.5)).toThrow();
  });
});

describe('wallClockToUtc', () => {
  it('converts Singapore wall clock to UTC', () => {
    expect(wallClockToUtc('2026-10-12', '19:30', 'Asia/Singapore').toISOString()).toBe('2026-10-12T11:30:00.000Z');
    expect(wallClockToUtc('2026-10-12', '03:00', 'Asia/Singapore').toISOString()).toBe('2026-10-11T19:00:00.000Z');
  });
});

describe('rrule-lite', () => {
  it('round-trips weekly rules and orders days', () => {
    expect(formatRrule({ byDay: ['WE', 'MO'] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(formatRrule({ byDay: ['FR'], until: '2026-12-31' })).toBe('FREQ=WEEKLY;BYDAY=FR;UNTIL=20261231');
    expect(parseRrule('FREQ=WEEKLY;BYDAY=WE,MO;UNTIL=20261231')).toEqual({ byDay: ['MO', 'WE'], until: '2026-12-31' });
    expect(() => parseRrule('FREQ=DAILY')).toThrow();
    expect(() => parseRrule('FREQ=WEEKLY;BYDAY=XX')).toThrow();
  });

  it('does wall-date arithmetic', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(weekdayOf('2026-10-14')).toBe('WE');
    expect(startOfWeek('2026-10-18')).toBe('2026-10-12');
    expect(wallDateOf(new Date('2026-10-11T17:00:00Z'), 'Asia/Singapore')).toBe('2026-10-12');
  });

  it('lists occurrences in the window, at the wall-clock time, skipping exdates and after until', () => {
    const occ = weeklyOccurrences({
      startDate: '2026-10-14',
      time: '19:00',
      timeZone: 'Asia/Singapore',
      rule: { byDay: ['MO', 'WE'], until: '2026-10-28' },
      from: '2026-10-01',
      to: '2026-12-01',
      exdates: ['2026-10-19'],
    });
    expect(occ.map((o) => o.date)).toEqual(['2026-10-14', '2026-10-21', '2026-10-26', '2026-10-28']);
    expect(occ[0]!.startAt.toISOString()).toBe('2026-10-14T11:00:00.000Z');
  });

  it('keeps local time across a DST change', () => {
    const occ = weeklyOccurrences({
      startDate: '2026-10-21',
      time: '18:00',
      timeZone: 'Europe/London',
      rule: { byDay: ['WE'] },
      from: '2026-10-21',
      to: '2026-11-05',
    });
    expect(occ.map((o) => o.startAt.toISOString())).toEqual([
      '2026-10-21T17:00:00.000Z',
      '2026-10-28T18:00:00.000Z',
      '2026-11-04T18:00:00.000Z',
    ]);
  });
});
