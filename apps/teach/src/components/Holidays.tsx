// Public holidays for the school's country (schools/{id}.holidays). Shown on the calendar; when the school
// is closed on them they also act like all-day time off (online booking skips them on the server).
import { useMemo } from 'react';
import { holidayMap, resolveHolidaySettings } from '@lessonkaki/shared';
import { useSchool } from '../hooks';

export function useHolidays() {
  const school = useSchool().data as { holidays?: unknown } | null;
  return useMemo(() => {
    const settings = resolveHolidaySettings(school?.holidays);
    return { ...settings, names: holidayMap(settings.country) };
  }, [school?.holidays]);
}
