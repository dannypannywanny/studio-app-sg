// Which package pays for a student's lesson. "Auto" = the earliest-expiring package with credits left
// (the default); staff can pick a specific one. Saved on the attendee (setAttendeePackage) and used when
// attendance is marked; a package that can no longer pay by then falls back to auto.
import { collection, query, where } from 'firebase/firestore';
import { formatDate } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { useQuery, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Enrolment } from '../types';

export const setAttendeePackage = call<{ schoolId: string; lessonId: string; studentId: string; enrolmentId: string | null }, { ok: true }>(
  'setAttendeePackage',
);

/** Active packages with credits left for one student, earliest expiry first. */
export function useActiveLots(studentId: string) {
  const schoolId = useSchoolId();
  const lots = useQuery<Enrolment>(`lots:${schoolId}:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'enrolments'), where('studentId', '==', studentId), where('status', '==', 'active')),
  );
  return lots.data
    .filter((l) => l.sessionsRemaining > 0)
    .sort((a, b) => a.validUntil.toMillis() - b.validUntil.toMillis());
}

export function PackageSelect({
  studentId,
  value,
  onChange,
  disabled,
}: {
  studentId: string;
  value: string | null;
  onChange: (enrolmentId: string | null) => void;
  disabled?: boolean;
}) {
  const tz = useTimeZone();
  const lots = useActiveLots(studentId);
  const far = (l: Enrolment) => l.validUntil.toDate().getUTCFullYear() >= 2900;
  return (
    <select
      className="package-select"
      aria-label="Package to use"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{lots.length ? 'Package: auto (earliest expiry)' : 'No package with credits: owed'}</option>
      {lots.map((l) => (
        <option key={l.id} value={l.id}>
          {l.packageName} · {l.sessionsRemaining} left{far(l) ? '' : ` · expires ${formatDate(l.validUntil.toDate(), tz)}`}
        </option>
      ))}
    </select>
  );
}
