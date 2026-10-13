// Public holidays for a school's country, stored on the school (schools/{id}.holidays) so the apps and
// booking read one place. Countries with a built-in official list (Singapore) use that; others use the
// date-holidays library (national public holidays only, names in English).
import Holidays from 'date-holidays';
import type { Firestore } from 'firebase-admin/firestore';
import { HOLIDAY_COUNTRIES, builtInHolidays, type HolidayCountry } from '@lessonkaki/shared';
import { audit, now, schoolRef, type Actor } from './db';

/** Years ahead kept on the school; the monthly refresh rolls the window forward. */
const YEARS = 3;

export function holidayDates(country: HolidayCountry, fromYear: number, years = YEARS): Record<string, string> {
  const builtIn = builtInHolidays(country);
  if (builtIn) return Object.fromEntries(builtIn.map((h) => [h.date, h.name]));
  const hd = new Holidays(country, { languages: ['en'] });
  const out: Record<string, string> = {};
  for (let y = fromYear; y < fromYear + years; y++) {
    for (const h of hd.getHolidays(y, 'en') || []) {
      if (h.type !== 'public') continue;
      const date = h.date.slice(0, 10);
      out[date] = out[date] && out[date] !== h.name ? `${out[date]} / ${h.name}` : h.name;
    }
  }
  return out;
}

export interface SetHolidaysInput {
  schoolId: string;
  country: HolidayCountry | null;
  closed: boolean;
}

export async function setHolidays(db: Firestore, input: SetHolidaysInput, actor: Actor, at = new Date()) {
  if (input.country && !(input.country in HOLIDAY_COUNTRIES)) throw new Error('Unknown country');
  const school = schoolRef(db, input.schoolId);
  const dates = input.country ? holidayDates(input.country, at.getUTCFullYear()) : {};
  const holidays = { country: input.country, closed: !!input.country && input.closed, dates, refreshedAt: now() };
  await db.runTransaction(async (tx) => {
    tx.update(school, { holidays, updatedAt: now() });
    audit(tx, school, actor, 'setHolidays', `schools/${input.schoolId}`, { country: input.country, closed: holidays.closed });
  });
  return { country: input.country, count: Object.keys(dates).length };
}

/** Monthly: recompute stored dates for every school with a country, so the window stays YEARS ahead. */
export async function refreshAllHolidays(db: Firestore, at = new Date()) {
  const schools = await db.collection('schools').where('holidays.country', '!=', null).get();
  let updated = 0;
  for (const s of schools.docs) {
    const country = s.get('holidays.country') as HolidayCountry;
    if (!(country in HOLIDAY_COUNTRIES)) continue;
    await s.ref.update({ 'holidays.dates': holidayDates(country, at.getUTCFullYear()), 'holidays.refreshedAt': now() });
    updated++;
  }
  return { updated };
}
