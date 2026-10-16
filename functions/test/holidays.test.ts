import { describe, expect, it } from 'vitest';
import { closedHolidayDates, resolveHolidaySettings } from '@lessonkaki/shared';
import { holidayDates, refreshAllHolidays, setHolidays } from '../src/holidays';
import { db, owner, withInvariant } from './helpers';

const school = withInvariant();

describe('holidayDates', () => {
  it('Singapore uses the built-in MOM list (with observed Mondays)', () => {
    const sg = holidayDates('SG', 2026);
    expect(sg['2026-11-09']).toBe('Deepavali (observed)');
    expect(sg['2026-08-09']).toBe('National Day');
  });

  it('other countries come from date-holidays, public holidays only, in English, several years', () => {
    const my = holidayDates('MY', 2026);
    expect(my['2026-01-01']).toBe("New Year's Day");
    expect(my['2026-02-17']).toBe('Chinese New Year');
    expect(Object.keys(my).some((d) => d.startsWith('2028-'))).toBe(true);
    expect(Object.keys(holidayDates('JP', 2026))).toContain('2026-01-01');
  });
});

describe('setHolidays', () => {
  it('stores the dates on the school; closed applies them to booking', async () => {
    const t = await school();
    const res = await setHolidays(db, { schoolId: t.schoolId, country: 'TH', closed: true }, owner, new Date('2026-10-13T00:00:00Z'));
    expect(res.count).toBeGreaterThan(30);
    const stored = resolveHolidaySettings((await db.doc(`schools/${t.schoolId}`).get()).get('holidays'));
    expect(stored).toMatchObject({ country: 'TH', closed: true });
    expect(closedHolidayDates(stored).has('2026-04-13')).toBe(true); // Songkran
    await setHolidays(db, { schoolId: t.schoolId, country: null, closed: true }, owner);
    expect(resolveHolidaySettings((await db.doc(`schools/${t.schoolId}`).get()).get('holidays'))).toMatchObject({ country: null, closed: false, dates: {} });
  });

  it('the monthly refresh rolls the window forward', async () => {
    const t = await school();
    await setHolidays(db, { schoolId: t.schoolId, country: 'JP', closed: false }, owner, new Date('2026-10-13T00:00:00Z'));
    await refreshAllHolidays(db, new Date('2029-01-01T00:00:00Z'));
    const dates = Object.keys((await db.doc(`schools/${t.schoolId}`).get()).get('holidays.dates'));
    expect(dates.some((d) => d.startsWith('2031-'))).toBe(true);
  });
});
