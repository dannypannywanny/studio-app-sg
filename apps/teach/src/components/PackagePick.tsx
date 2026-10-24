// Which package (invoice) pays for a student's lesson. "Auto" = the earliest-expiring package with credits
// left (the default); staff can pick a specific one. Saved on the attendee (setAttendeePackage). Before
// marking it is remembered; after marking, picking another package moves the credit there.
import { collection, query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import { formatDate } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { useQuery, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Enrolment, Invoice } from '../types';

export const setAttendeePackage = call<
  { schoolId: string; lessonId: string; studentId: string; enrolmentId: string | null },
  { ok: true; moved: boolean }
>('setAttendeePackage');

/** A student's packages that can still pay (plus `keep`, the one already charged), earliest expiry first. */
export function useActiveLots(studentId: string, keep: string | null = null) {
  const schoolId = useSchoolId();
  const lots = useQuery<Enrolment>(`studentLots:${schoolId}:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'enrolments'), where('studentId', '==', studentId)),
  );
  return lots.data
    .filter((l) => l.id === keep || (l.status === 'active' && l.sessionsRemaining > 0))
    .sort((a, b) => a.validUntil.toMillis() - b.validUntil.toMillis());
}

/** Invoice number by invoice id, for naming packages the way staff know them. */
export function useInvoiceNumbers(studentId: string) {
  const schoolId = useSchoolId();
  const invoices = useQuery<Invoice>(`invoices:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'invoices'), where('studentId', '==', studentId)),
  );
  return useMemo(() => new Map(invoices.data.map((i) => [i.id, i.number])), [invoices.data]);
}

export function PackageSelect({
  studentId,
  value,
  onChange,
  disabled,
  charged = false,
  trial = false,
}: {
  studentId: string;
  value: string | null;
  onChange: (enrolmentId: string | null) => void;
  disabled?: boolean;
  /** A credit was already taken (value = the package it came from, null = owed). */
  charged?: boolean;
  /** A lead's trial: with no package it's free, not owed. */
  trial?: boolean;
}) {
  const tz = useTimeZone();
  const lots = useActiveLots(studentId, charged ? value : null);
  const numbers = useInvoiceNumbers(studentId);
  const far = (l: Enrolment) => l.validUntil.toDate().getUTCFullYear() >= 2900;
  const label = (l: Enrolment) => {
    const inv = l.invoiceId ? numbers.get(l.invoiceId) : null;
    return [inv ? `Invoice ${inv}` : null, l.packageName, `${l.sessionsRemaining} left`, far(l) ? null : `expires ${formatDate(l.validUntil.toDate(), tz)}`]
      .filter(Boolean)
      .join(' · ');
  };
  // After marking there's no "auto": the credit sits on one package (or is owed).
  const none = trial ? 'No package: free trial' : 'No package with credits: owed';
  const empty = charged ? (value ? null : 'Owed (no package)') : lots.length ? 'Auto: earliest expiry' : none;
  return (
    <select
      className="package-select"
      aria-label="Package to use"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {empty !== null && <option value="">{empty}</option>}
      {lots.map((l) => (
        <option key={l.id} value={l.id}>
          {label(l)}
        </option>
      ))}
    </select>
  );
}
