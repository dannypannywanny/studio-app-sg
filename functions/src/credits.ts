// The credit engine. Every balance change is an append-only ledger entry, written in the same
// transaction as the lot (enrolment), the attendee and the student's summary. Clients never write these.
//
// Lots ("enrolments") hold sessions from one package sale. An attendee that consumes a credit points
// at the ledger entry that charged it (`ledgerEntryId`) and the lot it came from (`enrolmentId`, or
// null + `owed: true` when there were no credits). Undoing a charge always restores to that same lot.
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  NO_EXPIRY,
  consumesCredit,
  resolvePolicy,
  type AttendanceState,
  type AttendanceStatus,
  type LedgerType,
} from '@lessonkaki/shared';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';

const inc = FieldValue.increment;
const DAY_MS = 86_400_000;

interface LedgerWrite {
  studentId: string;
  enrolmentId: string | null;
  type: LedgerType;
  delta: number;
  idempotencyKey: string;
  lessonId?: string | null;
  attendeeKey?: string | null;
  reversesEntryId?: string | null;
  settlesEntryId?: string | null;
  invoiceId?: string | null;
  reason?: string | null;
}

function writeLedger(tx: Transaction, school: DocumentReference, actor: Actor, entry: LedgerWrite): string {
  const ref = school.collection('ledger').doc();
  tx.create(ref, {
    lessonId: null,
    attendeeKey: null,
    reversesEntryId: null,
    settlesEntryId: null,
    invoiceId: null,
    reason: null,
    ...entry,
    actorUid: actor.uid,
    createdAt: now(),
  });
  return ref.id;
}

const millis = (t: Timestamp | null | undefined) => (t ? t.toMillis() : NO_EXPIRY.getTime());

// ---------------------------------------------------------------------------------------------
// setAttendance: present / absent / lateCancelled / booked (= unmark)
// ---------------------------------------------------------------------------------------------

export const MARKABLE_STATUSES = ['booked', 'present', 'absent', 'lateCancelled'] as const;
export type MarkableStatus = (typeof MARKABLE_STATUSES)[number];

export interface SetAttendanceInput {
  schoolId: string;
  lessonId: string;
  studentId: string;
  status: MarkableStatus;
}

export interface SetAttendanceResult {
  status: AttendanceStatus;
  /** What happened to the credit: debited from a lot, recorded as owed, restored, or nothing. */
  charge: 'debited' | 'owed' | 'restored' | 'restoredExpired' | 'none';
  enrolmentId: string | null;
}

export function assertCanMark(actor: Actor, lessonTeacherId: string): void {
  if (actor.role === 'owner' || actor.role === 'admin' || actor.role === 'system') return;
  if (actor.role === 'teacher' && actor.teacherId && actor.teacherId === lessonTeacherId) return;
  throw new HttpsError('permission-denied', 'You can only mark attendance for your own lessons');
}

function attendanceStateOf(statuses: AttendanceStatus[]): AttendanceState {
  const marked = statuses.filter((s) => s !== 'booked').length;
  if (marked === 0) return 'unmarked';
  return marked === statuses.length ? 'marked' : 'partial';
}

export async function setAttendance(
  db: Firestore,
  input: SetAttendanceInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<SetAttendanceResult> {
  const school = schoolRef(db, input.schoolId);
  const lessonRef = school.collection('lessons').doc(input.lessonId);
  const attendeeRef = lessonRef.collection('attendees').doc(input.studentId);
  const studentRef = school.collection('students').doc(input.studentId);
  const attendeeKey = `${input.lessonId}_${input.studentId}`;

  return db.runTransaction(async (tx) => {
    // ---- reads (all before any write) ----
    const [schoolSnap, lessonSnap, attendeeSnap, studentSnap] = await readAll(
      tx,
      school,
      lessonRef,
      attendeeRef,
      studentRef,
    );
    if (!schoolSnap.exists) notFound('School');
    if (!lessonSnap.exists) notFound('Lesson');
    if (!studentSnap.exists) notFound('Student');
    if (!attendeeSnap.exists) throw new HttpsError('not-found', 'That student is not on this lesson');

    const lesson = lessonSnap.data()!;
    assertCanMark(actor, lesson.teacherId as string);
    if (lesson.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'This lesson is cancelled');
    }

    const attendee = attendeeSnap.data()!;
    const from = attendee.status as AttendanceStatus;
    if (from === input.status) {
      return { status: from, charge: 'none', enrolmentId: (attendee.enrolmentId as string | null) ?? null };
    }

    const policy = resolvePolicy(schoolSnap.get('policy'));
    const holdsCharge = attendee.ledgerEntryId != null;
    const wantsCharge = consumesCredit(input.status, policy);
    const lessonStart = lesson.startAt as Timestamp;
    const rev = ((attendee.rev as number | undefined) ?? 0) + 1;

    const siblings = await tx.get(lessonRef.collection('attendees'));

    let lotToDebit: DocumentSnapshot | null = null;
    let lotToRestore: DocumentSnapshot | null = null;
    if (wantsCharge && !holdsCharge) {
      const lots = await tx.get(
        school
          .collection('enrolments')
          .where('studentId', '==', input.studentId)
          .where('status', '==', 'active')
          .orderBy('validUntil'),
      );
      // Earliest-expiring first, then oldest. Skip empty lots and lots that expire before the lesson.
      lotToDebit =
        lots.docs
          .filter((d) => (d.get('sessionsRemaining') as number) > 0)
          .filter((d) => millis(d.get('validUntil')) >= lessonStart.toMillis())
          .sort(
            (a, b) =>
              millis(a.get('validUntil')) - millis(b.get('validUntil')) ||
              millis(a.get('validFrom')) - millis(b.get('validFrom')),
          )[0] ?? null;
      if (!lotToDebit && !policy.allowOwedLessons) {
        throw new HttpsError('failed-precondition', 'This student has no credits left');
      }
    } else if (!wantsCharge && holdsCharge && attendee.enrolmentId) {
      lotToRestore = await tx.get(school.collection('enrolments').doc(attendee.enrolmentId as string));
      if (!lotToRestore.exists) notFound('Enrolment');
    }

    // ---- writes ----
    let charge: SetAttendanceResult['charge'] = 'none';
    const attendeeUpdate: Record<string, unknown> = {
      status: input.status,
      rev,
      markedBy: input.status === 'booked' ? null : actor.uid,
      markedAt: input.status === 'booked' ? null : Timestamp.fromDate(at),
      updatedAt: now(),
    };

    if (wantsCharge && !holdsCharge) {
      const base = { studentId: input.studentId, lessonId: input.lessonId, attendeeKey };
      if (lotToDebit) {
        const remaining = (lotToDebit.get('sessionsRemaining') as number) - 1;
        const entryId = writeLedger(tx, school, actor, {
          ...base,
          enrolmentId: lotToDebit.id,
          type: 'debit',
          delta: -1,
          idempotencyKey: `${attendeeKey}:${rev}:debit`,
        });
        tx.update(lotToDebit.ref, {
          sessionsUsed: inc(1),
          sessionsRemaining: remaining,
          status: remaining === 0 ? 'completed' : 'active',
          updatedAt: now(),
        });
        tx.update(studentRef, { 'summary.sessionsAvailable': inc(-1), updatedAt: now() });
        Object.assign(attendeeUpdate, { ledgerEntryId: entryId, enrolmentId: lotToDebit.id, owed: false });
        charge = 'debited';
      } else {
        const entryId = writeLedger(tx, school, actor, {
          ...base,
          enrolmentId: null,
          type: 'debit',
          delta: -1,
          idempotencyKey: `${attendeeKey}:${rev}:owed`,
        });
        tx.update(studentRef, { 'summary.sessionsOwed': inc(1), updatedAt: now() });
        Object.assign(attendeeUpdate, { ledgerEntryId: entryId, enrolmentId: null, owed: true });
        charge = 'owed';
      }
    } else if (!wantsCharge && holdsCharge) {
      const base = {
        studentId: input.studentId,
        lessonId: input.lessonId,
        attendeeKey,
        reversesEntryId: attendee.ledgerEntryId as string,
      };
      if (lotToRestore) {
        const lot = lotToRestore;
        writeLedger(tx, school, actor, {
          ...base,
          enrolmentId: lot.id,
          type: 'restore',
          delta: 1,
          idempotencyKey: `${attendeeKey}:${rev}:restore`,
        });
        const expired = millis(lot.get('validUntil')) < at.getTime();
        if (expired) {
          // The credit comes back to a lot that has already run out of time: it expires straight away.
          writeLedger(tx, school, actor, {
            ...base,
            enrolmentId: lot.id,
            type: 'expire',
            delta: -1,
            idempotencyKey: `${attendeeKey}:${rev}:expire`,
            reason: 'Restored onto an expired lot',
          });
          const remaining = lot.get('sessionsRemaining') as number;
          tx.update(lot.ref, {
            sessionsUsed: inc(-1),
            sessionsExpired: inc(1),
            status: remaining === 0 ? 'expired' : lot.get('status'),
            updatedAt: now(),
          });
          charge = 'restoredExpired';
        } else {
          tx.update(lot.ref, {
            sessionsUsed: inc(-1),
            sessionsRemaining: (lot.get('sessionsRemaining') as number) + 1,
            status: 'active',
            updatedAt: now(),
          });
          tx.update(studentRef, { 'summary.sessionsAvailable': inc(1), updatedAt: now() });
          charge = 'restored';
        }
      } else {
        // It was an owed lesson: nothing is owed any more.
        writeLedger(tx, school, actor, {
          ...base,
          enrolmentId: null,
          type: 'restore',
          delta: 1,
          idempotencyKey: `${attendeeKey}:${rev}:restore`,
        });
        tx.update(studentRef, { 'summary.sessionsOwed': inc(-1), updatedAt: now() });
        charge = 'restored';
      }
      Object.assign(attendeeUpdate, { ledgerEntryId: null, enrolmentId: null, owed: false });
    }

    tx.update(attendeeRef, attendeeUpdate);

    const statuses = siblings.docs.map((d) =>
      d.id === input.studentId ? input.status : (d.get('status') as AttendanceStatus),
    );
    tx.update(lessonRef, { attendanceState: attendanceStateOf(statuses), updatedAt: now() });

    audit(tx, school, actor, 'setAttendance', `lessons/${input.lessonId}/attendees/${input.studentId}`, {
      from,
      to: input.status,
      charge,
    });

    return {
      status: input.status,
      charge,
      enrolmentId: (attendeeUpdate.enrolmentId as string | null | undefined) ?? attendee.enrolmentId ?? null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// sellPackage: invoice + lot + grant, then settle the oldest owed lessons onto the new lot
// ---------------------------------------------------------------------------------------------

export interface SellPackageInput {
  schoolId: string;
  studentId: string;
  packageId: string;
  /** One per user action (the client makes it when the sell dialog opens). Retries return the first result. */
  idempotencyKey: string;
}

export interface SellPackageResult {
  invoiceId: string;
  invoiceNumber: string;
  enrolmentId: string;
  settled: number;
  sessionsRemaining: number;
}

export function formatInvoiceNumber(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

export async function sellPackage(
  db: Firestore,
  input: SellPackageInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<SellPackageResult> {
  const school = schoolRef(db, input.schoolId);
  const idemRef = school.collection('idempotency').doc(`sellPackage_${input.idempotencyKey}`);
  const studentRef = school.collection('students').doc(input.studentId);
  const packageRef = school.collection('packages').doc(input.packageId);
  const counterRef = school.collection('counters').doc('invoice');

  return db.runTransaction(async (tx) => {
    // ---- reads ----
    const [idem, schoolSnap, studentSnap, pkgSnap, counterSnap] = await readAll(
      tx,
      idemRef,
      school,
      studentRef,
      packageRef,
      counterRef,
    );
    if (idem.exists) {
      if (idem.get('studentId') !== input.studentId || idem.get('packageId') !== input.packageId) {
        throw new HttpsError('already-exists', 'This idempotency key was already used for a different sale');
      }
      return idem.get('result') as SellPackageResult;
    }
    if (!schoolSnap.exists) notFound('School');
    if (!studentSnap.exists) notFound('Student');
    if (!pkgSnap.exists) notFound('Package');
    if (studentSnap.get('status') === 'archived') {
      throw new HttpsError('failed-precondition', 'This student is archived');
    }
    const pkg = pkgSnap.data()!;
    if (pkg.active === false) throw new HttpsError('failed-precondition', 'This package is no longer sold');
    const sessions = pkg.sessions as number;
    if (!Number.isInteger(sessions) || sessions < 1) {
      throw new HttpsError('failed-precondition', 'Package has no session count');
    }

    const owed = await tx.get(
      db
        .collectionGroup('attendees')
        .where('schoolId', '==', input.schoolId)
        .where('studentId', '==', input.studentId)
        .where('owed', '==', true)
        .orderBy('lessonStartAt'),
    );

    // ---- writes ----
    const nowTs = Timestamp.fromDate(at);
    const validityDays = pkg.validityDays as number | null | undefined;
    const validUntil = Timestamp.fromDate(validityDays ? new Date(at.getTime() + validityDays * DAY_MS) : NO_EXPIRY);
    const priceCents = pkg.priceCents as number;
    const currency = (schoolSnap.get('currency') as string | undefined) ?? 'SGD';

    const n = counterSnap.exists ? (counterSnap.get('next') as number) : 1;
    const invoiceNumber = formatInvoiceNumber((schoolSnap.get('invoicePrefix') as string | undefined) ?? 'INV', n);
    tx.set(counterRef, { next: n + 1, updatedAt: now() });

    const invoiceRef = school.collection('invoices').doc();
    const lotRef = school.collection('enrolments').doc();

    tx.create(invoiceRef, {
      number: invoiceNumber,
      studentId: input.studentId,
      currency,
      lines: [
        {
          desc: pkg.name as string,
          qty: 1,
          unitCents: priceCents,
          packageId: input.packageId,
          enrolmentId: lotRef.id,
        },
      ],
      subtotalCents: priceCents,
      discountCents: 0,
      moneyCreditAppliedCents: 0,
      totalCents: priceCents,
      paidCents: 0,
      pendingCents: priceCents,
      status: 'sent',
      issueDate: nowTs,
      dueDate: Timestamp.fromDate(new Date(at.getTime() + 7 * DAY_MS)),
      createdBy: actor.uid,
      createdAt: now(),
      updatedAt: now(),
    });

    writeLedger(tx, school, actor, {
      studentId: input.studentId,
      enrolmentId: lotRef.id,
      type: 'grant',
      delta: sessions,
      invoiceId: invoiceRef.id,
      idempotencyKey: `sellPackage:${input.idempotencyKey}:grant`,
    });

    // Settle owed lessons, oldest first, as long as the lot has sessions and covers the lesson date.
    let remaining = sessions;
    let settled = 0;
    for (const att of owed.docs) {
      if (remaining === 0) break;
      if ((att.get('lessonStartAt') as Timestamp).toMillis() > validUntil.toMillis()) continue;
      const lessonId = att.get('lessonId') as string;
      const entryId = writeLedger(tx, school, actor, {
        studentId: input.studentId,
        enrolmentId: lotRef.id,
        type: 'settle',
        delta: -1,
        lessonId,
        attendeeKey: `${lessonId}_${input.studentId}`,
        settlesEntryId: att.get('ledgerEntryId') as string,
        invoiceId: invoiceRef.id,
        idempotencyKey: `sellPackage:${input.idempotencyKey}:settle:${lessonId}`,
      });
      tx.update(att.ref, { owed: false, enrolmentId: lotRef.id, ledgerEntryId: entryId, updatedAt: now() });
      remaining -= 1;
      settled += 1;
    }

    tx.create(lotRef, {
      studentId: input.studentId,
      packageId: input.packageId,
      packageName: pkg.name as string,
      invoiceId: invoiceRef.id,
      sessionsTotal: sessions,
      sessionsUsed: settled,
      sessionsRemaining: remaining,
      sessionsExpired: 0,
      validFrom: nowTs,
      validUntil,
      status: remaining === 0 ? 'completed' : 'active',
      createdAt: now(),
      updatedAt: now(),
    });

    tx.update(studentRef, {
      'summary.sessionsAvailable': inc(remaining),
      'summary.sessionsOwed': inc(-settled),
      updatedAt: now(),
    });

    const result: SellPackageResult = {
      invoiceId: invoiceRef.id,
      invoiceNumber,
      enrolmentId: lotRef.id,
      settled,
      sessionsRemaining: remaining,
    };
    tx.create(idemRef, {
      studentId: input.studentId,
      packageId: input.packageId,
      result,
      actorUid: actor.uid,
      createdAt: now(),
    });
    audit(tx, school, actor, 'sellPackage', `invoices/${invoiceRef.id}`, { invoiceNumber, settled });
    return result;
  });
}
