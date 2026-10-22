// A student's packages drawn as one box per session: used (and how), booked ahead, still free, expired.
// Used boxes come from the attendees each package paid for; sessions used with no lesson on record
// (imported from Classcard, or adjusted by hand) show as plain used boxes. Booked-ahead boxes are a
// forecast: upcoming lessons are placed the way marking will charge them (chosen package, else earliest
// expiry), so nothing here moves a credit.
import { collectionGroup, orderBy, query, where } from 'firebase/firestore';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatDate, type AttendanceStatus } from '@lessonkaki/shared';
import { db } from '../firebase';
import { useQuery, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Enrolment, Invoice, Ts } from '../types';
import { useLessonHref } from './LessonSheet';

interface StudentAttendee {
  lessonId: string;
  lessonStartAt: Ts;
  status: AttendanceStatus;
  enrolmentId: string | null;
  ledgerEntryId: string | null;
  preferredEnrolmentId?: string | null;
}

type Lot = Enrolment & { id: string };
type BoxKind = 'present' | 'absent' | 'lateCancelled' | 'used' | 'booked' | 'free' | 'expired';
interface Box {
  kind: BoxKind;
  lessonId?: string;
  at?: Ts;
}

const KIND_LABEL: Record<BoxKind, string> = {
  present: 'Present',
  absent: 'Absent',
  lateCancelled: 'Late cancel',
  used: 'Used (no lesson on record)',
  booked: 'Booked',
  free: 'Free',
  expired: 'Expired unused',
};
const KIND_MARK: Partial<Record<BoxKind, string>> = { present: '✓', absent: '✕', lateCancelled: 'L', used: '•', expired: '–' };

const far = (l: Enrolment) => l.validUntil.toDate().getUTCFullYear() >= 2900;

function boxesFor(lots: Lot[], attendees: StudentAttendee[], nowMs: number) {
  const boxes = new Map<string, Box[]>(lots.map((l) => [l.id, []]));
  // Used: the lessons each package actually paid for, oldest first.
  for (const a of attendees) {
    if (!a.ledgerEntryId || !a.enrolmentId || !boxes.has(a.enrolmentId)) continue;
    const kind: BoxKind = a.status === 'present' || a.status === 'absent' || a.status === 'lateCancelled' ? a.status : 'used';
    boxes.get(a.enrolmentId)!.push({ kind, lessonId: a.lessonId, at: a.lessonStartAt });
  }
  // Booked ahead: upcoming unmarked lessons, placed as marking would charge them.
  const free = new Map(lots.map((l) => [l.id, l.status === 'active' ? l.sessionsRemaining : 0]));
  const byExpiry = [...lots].sort((a, b) => a.validUntil.toMillis() - b.validUntil.toMillis());
  const booked = new Map<string, Box[]>();
  for (const a of attendees) {
    if (a.status !== 'booked' || a.ledgerEntryId || a.lessonStartAt.toMillis() < nowMs) continue;
    const at = a.lessonStartAt.toMillis();
    const fits = (l: Lot) => (free.get(l.id) ?? 0) > 0 && l.validUntil.toMillis() >= at;
    const lot = byExpiry.find((l) => l.id === a.preferredEnrolmentId && fits(l)) ?? byExpiry.find(fits);
    if (!lot) continue;
    free.set(lot.id, free.get(lot.id)! - 1);
    booked.set(lot.id, [...(booked.get(lot.id) ?? []), { kind: 'booked', lessonId: a.lessonId, at: a.lessonStartAt }]);
  }
  for (const l of lots) {
    const list = boxes.get(l.id)!;
    // Imported or hand-adjusted usage has no lesson behind it.
    const unrecorded = Math.max(0, l.sessionsUsed - list.length);
    const ahead = booked.get(l.id) ?? [];
    list.unshift(...Array.from({ length: unrecorded }, (): Box => ({ kind: 'used' })));
    list.push(
      ...ahead,
      ...Array.from({ length: Math.max(0, l.sessionsRemaining - ahead.length) }, (): Box => ({ kind: 'free' })),
      ...Array.from({ length: l.sessionsExpired ?? 0 }, (): Box => ({ kind: 'expired' })),
    );
  }
  return boxes;
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5V8l2.25 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const glyph = (k: BoxKind) => (k === 'booked' ? <ClockIcon /> : (KIND_MARK[k] ?? ''));

function PackageCard({ lot, boxes, invoiceNumber }: { lot: Lot; boxes: Box[]; invoiceNumber: string | null }) {
  const tz = useTimeZone();
  const lessonHref = useLessonHref();
  const count = (k: BoxKind) => boxes.filter((b) => b.kind === k).length;
  const used = count('present') + count('absent') + count('lateCancelled') + count('used');
  const counts = [
    lot.status === 'active' ? `${count('free')} free` : null,
    count('booked') ? `${count('booked')} booked` : null,
    `${used} used`,
    count('expired') ? `${count('expired')} expired` : null,
  ].filter(Boolean);
  return (
    <div className={`pkg-card pkg-${lot.status}`}>
      <div className="pkg-head">
        <div className="pkg-title">
          <span className="pkg-name">{lot.packageName}</span>
          <span className="muted pkg-meta">
            {invoiceNumber && lot.invoiceId && (
              <>
                <Link to={`/invoices/${lot.invoiceId}`}>Invoice {invoiceNumber}</Link>
                {' · '}
              </>
            )}
            {far(lot) ? 'No expiry' : `${lot.status === 'expired' ? 'Expired' : 'Valid until'} ${formatDate(lot.validUntil.toDate(), tz)}`}
          </span>
        </div>
        <span className="pkg-counts">{counts.join(' · ')}</span>
      </div>
      <ol className="pkg-boxes" aria-label={`${lot.packageName}: ${counts.join(', ')}`}>
        {boxes.map((b, i) => {
          const title = `${KIND_LABEL[b.kind]}${b.at ? ` · ${formatDate(b.at.toDate(), tz)}` : ''}`;
          return (
            <li key={i} className={`pkg-box box-${b.kind}`} title={title}>
              {b.lessonId ? (
                <Link to={lessonHref(b.lessonId)} aria-label={title}>
                  {glyph(b.kind)}
                </Link>
              ) : (
                <span aria-label={title}>{glyph(b.kind)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function CreditBoxes({ studentId, lots, invoices }: { studentId: string; lots: Lot[]; invoices: (Invoice & { id: string })[] }) {
  const schoolId = useSchoolId();
  const [showPast, setShowPast] = useState(false);
  const [nowMs] = useState(() => Date.now());
  const attendees = useQuery<StudentAttendee>(`studentAttendees:${schoolId}:${studentId}`, () =>
    query(collectionGroup(db, 'attendees'), where('schoolId', '==', schoolId), where('studentId', '==', studentId), orderBy('lessonStartAt')),
  );
  const numbers = new Map(invoices.map((i) => [i.id, i.number]));
  const boxes = boxesFor(lots, attendees.data, nowMs);
  // Packages that can still pay first (soonest expiry on top), then the rest, newest first.
  const current = lots.filter((l) => l.status === 'active').sort((a, b) => a.validUntil.toMillis() - b.validUntil.toMillis());
  const past = lots.filter((l) => l.status !== 'active').sort((a, b) => b.validFrom.toMillis() - a.validFrom.toMillis());
  const card = (l: Lot) => (
    <PackageCard key={l.id} lot={l} boxes={boxes.get(l.id)!} invoiceNumber={l.invoiceId ? (numbers.get(l.invoiceId) ?? null) : null} />
  );

  if (lots.length === 0) return <p className="empty">No packages yet.</p>;
  return (
    <div className="stack">
      {attendees.error && <p className="error">{attendees.error.message}</p>}
      {current.length === 0 && <p className="muted">No package with credits right now.</p>}
      {current.map(card)}
      {past.length > 0 && (
        <>
          <button className="link-add" onClick={() => setShowPast(!showPast)} aria-expanded={showPast}>
            {showPast ? 'Hide' : 'Show'} {past.length} past package{past.length === 1 ? '' : 's'}
          </button>
          {showPast && past.map(card)}
        </>
      )}
      <p className="muted pkg-legend">
        {(['present', 'absent', 'lateCancelled', 'booked', 'free', 'expired'] as BoxKind[]).map((k) => (
          <span key={k} className="pkg-legend-item">
            <span className={`pkg-box pkg-box-key box-${k}`} aria-hidden="true">
              {glyph(k)}
            </span>
            {KIND_LABEL[k]}
          </span>
        ))}
      </p>
    </div>
  );
}
