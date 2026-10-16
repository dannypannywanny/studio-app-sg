// Public holidays by country. Singapore from the Ministry of Manpower list
// (https://www.mom.gov.sg/employment-practices/public-holidays), checked 2026-10-13. A holiday on a Sunday
// gives the Monday after as a holiday too; those Mondays are listed as their own entries.
// Update yearly when MOM publishes the next year.
// Other countries: national public holidays from the date-holidays library, worked out on the server when the
// owner picks a country (setHolidays) and stored on the school as `holidays.dates`, refreshed monthly.

export interface PublicHoliday {
  date: string;
  name: string;
}

/** Countries offered in Settings (Asia first; date-holidays has data for each). */
export const HOLIDAY_COUNTRIES = {
  SG: 'Singapore',
  MY: 'Malaysia',
  ID: 'Indonesia',
  TH: 'Thailand',
  PH: 'Philippines',
  VN: 'Vietnam',
  BN: 'Brunei',
  HK: 'Hong Kong',
  TW: 'Taiwan',
  CN: 'China',
  JP: 'Japan',
  KR: 'South Korea',
  IN: 'India',
  LK: 'Sri Lanka',
  BD: 'Bangladesh',
  PK: 'Pakistan',
  KZ: 'Kazakhstan',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  BH: 'Bahrain',
  IL: 'Israel',
  TR: 'Turkey',
} as const;
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

/** Built-in lists, used instead of stored dates (official sources beat the library). */
const BUILT_IN: Partial<Record<HolidayCountry, PublicHoliday[]>> = { SG };
export const builtInHolidays = (country: HolidayCountry): PublicHoliday[] | null => BUILT_IN[country] ?? null;

/** A school's holiday setting (schools/{id}.holidays). */
export interface HolidaySettings {
  country: HolidayCountry | null;
  /** Closed on public holidays: no online booking those days, shown as time off. */
  closed: boolean;
  /** date -> name, stored by the server for countries without a built-in list. */
  dates: Record<string, string>;
}

export function resolveHolidaySettings(raw: unknown): HolidaySettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const country = typeof r.country === 'string' && r.country in HOLIDAY_COUNTRIES ? (r.country as HolidayCountry) : null;
  const dates: Record<string, string> = {};
  if (r.dates && typeof r.dates === 'object') {
    for (const [d, n] of Object.entries(r.dates as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'string') dates[d] = n.slice(0, 80);
    }
  }
  return { country, closed: country !== null && r.closed === true, dates };
}

/** date -> holiday name for a school's settings (empty when no country). */
export function holidayMap(settings: Pick<HolidaySettings, 'country' | 'dates'>): Map<string, string> {
  if (!settings.country) return new Map();
  const builtIn = BUILT_IN[settings.country];
  return builtIn ? new Map(builtIn.map((h) => [h.date, h.name])) : new Map(Object.entries(settings.dates).sort());
}

/** Dates a school is closed for public holidays. */
export function closedHolidayDates(settings: HolidaySettings): Set<string> {
  return settings.closed ? new Set(holidayMap(settings).keys()) : new Set();
}
