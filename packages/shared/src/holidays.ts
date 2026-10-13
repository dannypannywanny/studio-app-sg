// Public holidays by country. Singapore from the Ministry of Manpower list
// (https://www.mom.gov.sg/employment-practices/public-holidays), checked 2026-10-13. A holiday on a Sunday
// gives the Monday after as a holiday too; those Mondays are listed as their own entries.
// Update yearly when MOM publishes the next year.

export interface PublicHoliday {
  date: string;
  name: string;
}

export const HOLIDAY_COUNTRIES = { SG: 'Singapore' } as const;
export type HolidayCountry = keyof typeof HOLIDAY_COUNTRIES;

const SG: PublicHoliday[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-02-17', name: 'Chinese New Year' },
  { date: '2026-02-18', name: 'Chinese New Year' },
  { date: '2026-03-21', name: 'Hari Raya Puasa' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-05-27', name: 'Hari Raya Haji' },
  { date: '2026-05-31', name: 'Vesak Day' },
  { date: '2026-06-01', name: 'Vesak Day (observed)' },
  { date: '2026-08-09', name: 'National Day' },
  { date: '2026-08-10', name: 'National Day (observed)' },
  { date: '2026-11-08', name: 'Deepavali' },
  { date: '2026-11-09', name: 'Deepavali (observed)' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-02-06', name: 'Chinese New Year' },
  { date: '2027-02-07', name: 'Chinese New Year' },
  { date: '2027-02-08', name: 'Chinese New Year (observed)' },
  { date: '2027-03-10', name: 'Hari Raya Puasa' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-05-01', name: 'Labour Day' },
  { date: '2027-05-17', name: 'Hari Raya Haji' },
  { date: '2027-05-20', name: 'Vesak Day' },
  { date: '2027-08-09', name: 'National Day' },
  { date: '2027-10-28', name: 'Deepavali' },
  { date: '2027-12-25', name: 'Christmas Day' },
];

const BY_COUNTRY: Record<HolidayCountry, PublicHoliday[]> = { SG };

/** A school's holiday setting (schools/{id}.holidays). */
export interface HolidaySettings {
  country: HolidayCountry | null;
  /** Closed on public holidays: no online booking those days, shown as time off. */
  closed: boolean;
}

export function resolveHolidaySettings(raw: unknown): HolidaySettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const country = typeof r.country === 'string' && r.country in BY_COUNTRY ? (r.country as HolidayCountry) : null;
  return { country, closed: country !== null && r.closed === true };
}

/** date -> holiday name, for a country (empty when none). */
export function holidayMap(country: HolidayCountry | null): Map<string, string> {
  return new Map((country ? BY_COUNTRY[country] : []).map((h) => [h.date, h.name]));
}

/** Dates a school is closed for public holidays. */
export function closedHolidayDates(settings: HolidaySettings): Set<string> {
  return settings.closed ? new Set(holidayMap(settings.country).keys()) : new Set();
}
