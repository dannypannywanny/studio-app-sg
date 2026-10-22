// Attendance: marking, cancelling, adding and removing students, cancelling whole lessons.
//
// Every change goes through prepareTransition (reads) + applyTransition (writes), which decide from the
// attendee's current charge and the target status whether to debit (earliest-expiring lot, owed when
// empty) or restore (same lot). An attendee holding a credit points at the entry that charged it.
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  consumesCredit,
  resolvePolicy,
  type AttendanceState,
  type AttendanceStatus,
  type CreditPolicy,
} from '@lessonkaki/shared';
import { enqueueAlert } from './alerts';
import { CreditTx, pickLot, readActiveLots, type LotState } from './creditTx';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';

export const MARKABLE_STATUSES = ['booked', 'present', 'absent', 'lateCancelled'] as const;
export type MarkableStatus = (typeof MARKABLE_STATUSES)[number];

export type Charge = 'debited' | 'owed' | 'restored' | 'restoredExpired' | 'none';

const HOUR_MS = 3_600_000;
const isStaff = (actor: Actor) => actor.role === 'owner' || actor.role === 'admin' || actor.role === 'system';

export function assertCanMark(actor: Actor, lessonTeacherId: string): void {
  if (isStaff(actor)) return;
  if (actor.role === 'teacher' && actor.teacherId && actor.teacherId === lessonTeacherId) return;
  throw new HttpsError('permission-denied', 'You can only mark attendance for your own lessons');
}

/** Removed attendees don't count towards a lesson's attendance state. */
export function attendanceStateOf(statuses: AttendanceStatus[]): AttendanceState {
  const counted = statuses.filter((s) => s !== 'removed');
  const marked = counted.filter((s) => s !== 'booked').length;
  if (marked === 0) return 'unmarked';
  return marked === counted.length ? 'marked' : 'partial';
}

/**
 * The lesson-level fields derived from its attendees. `studentsCancelled`: everyone on it cancelled
 * (on time or late), so the calendar shows it struck through like a lesson the studio cancelled.
 */
export function lessonStateOf(statuses: AttendanceStatus[]): { attendanceState: AttendanceState; studentsCancelled: boolean } {
  const counted = statuses.filter((s) => s !== 'removed');
  return {
    attendanceState: attendanceStateOf(statuses),
    studentsCancelled: counted.length > 0 && counted.every((s) => s === 'cancelled' || s === 'lateCancelled'),
  };
}

// ---------------------------------------------------------------------------------------------
// The shared transition: prepare (reads) then apply (writes)
// ---------------------------------------------------------------------------------------------

export interface Prepared {
  action: 'debit' | 'restore' | 'none';
  lot: LotState | null;
}

/** Reads what a transition needs: candidate lots for a debit, the charged lot for a restore. */
export async function prepareTransition(
  ct: CreditTx,
  attendee: DocumentSnapshot,
  to: AttendanceStatus,
  policy: CreditPolicy,
  lessonStart: Timestamp,
): Promise<Prepared> {
  const holdsCharge = attendee.get('ledgerEntryId') != null;
  const wantsCharge = consumesCredit(to, policy);
  if (wantsCharge && !holdsCharge) {
    const preferred = (attendee.get('preferredEnrolmentId') as string | null | undefined) ?? null;
    const lot = pickLot(await readActiveLots(ct, attendee.id), lessonStart.toMillis(), preferred);
    if (!lot && !policy.allowOwedLessons) {
      throw new HttpsError('failed-precondition', 'This student has no credits left');
    }
    return { action: 'debit', lot };
  }
  if (!wantsCharge && holdsCharge) {
    const enrolmentId = attendee.get('enrolmentId') as string | null;
    if (!enrolmentId) return { action: 'restore', lot: null };
    const snap = await ct.tx.get(ct.school.collection('enrolments').doc(enrolmentId));
    if (!snap.exists) notFound('Enrolment');
    return { action: 'restore', lot: ct.useLot(snap) };
  }
  return { action: 'none', lot: null };
}

export interface Applied {
  charge: Charge;
  /** The lot now charged for this attendee (null when owed or uncharged). */
  enrolmentId: string | null;
  update: Record<string, unknown>;
}

/** Writes the ledger side of a transition and returns the attendee update. No reads. */
export function applyTransition(
  ct: CreditTx,
  lessonId: string,
  attendee: DocumentSnapshot,
  to: AttendanceStatus,
  prepared: Prepared,
): Applied {
  const studentId = attendee.id;
  const attendeeKey = `${lessonId}_${studentId}`;
  const rev = ((attendee.get('rev') as number | undefined) ?? 0) + 1;
  const update: Record<string, unknown> = {
    status: to,
    rev,
    markedBy: to === 'booked' ? null : ct.actor.uid,
    markedAt: to === 'booked' ? null : Timestamp.fromDate(ct.at),
    updatedAt: now(),
  };

  if (prepared.action === 'debit') {
    const lot = prepared.lot;
    const entryId = ct.debit(studentId, lot, {
      lessonId,
      attendeeKey,
      key: `${attendeeKey}:${rev}:${lot ? 'debit' : 'owed'}`,
    });
    Object.assign(update, { ledgerEntryId: entryId, enrolmentId: lot?.id ?? null, owed: !lot });
    return { charge: lot ? 'debited' : 'owed', enrolmentId: lot?.id ?? null, update };
  }
  if (prepared.action === 'restore') {
    const charge = ct.restore(studentId, prepared.lot, {
      lessonId,
      attendeeKey,
      key: `${attendeeKey}:${rev}`,
      reversesEntryId: attendee.get('ledgerEntryId') as string,
    });
    Object.assign(update, { ledgerEntryId: null, enrolmentId: null, owed: false });
    return { charge, enrolmentId: null, update };
  }
  return { charge: 'none', enrolmentId: (attendee.get('enrolmentId') as string | null) ?? null, update };
}

interface Loaded {
  ct: CreditTx;
  lessonRef: DocumentReference;
  lesson: DocumentData;
  attendee: DocumentSnapshot;
  siblings: DocumentSnapshot[];
  policy: CreditPolicy;
}

/** Reads school, lesson, student, attendee and its siblings for a one-attendee change. */
async function loadOne(ct: CreditTx, input: { lessonId: string; studentId: string }): Promise<Loaded> {
  const lessonRef = ct.school.collection('lessons').doc(input.lessonId);
  const [schoolSnap, lessonSnap, attendeeSnap, studentSnap] = await readAll(
    ct.tx,
    ct.school,
    lessonRef,
    lessonRef.collection('attendees').doc(input.studentId),
    ct.school.collection('students').doc(input.studentId),
  );
  if (!schoolSnap.exists) notFound('School');
  if (!lessonSnap.exists) notFound('Lesson');
  if (!studentSnap.exists) notFound('Student');
  if (!attendeeSnap.exists) throw new HttpsError('not-found', 'That student is not on this lesson');
  const lesson = lessonSnap.data()!;
  if (lesson.status === 'cancelled') throw new HttpsError('failed-precondition', 'This lesson is cancelled');
  const siblings = (await ct.tx.get(lessonRef.collection('attendees'))).docs;
  return { ct, lessonRef, lesson, attendee: attendeeSnap, siblings, policy: resolvePolicy(schoolSnap.get('policy')) };
}

/** Prepares, applies and writes one attendee change plus the lesson's attendance state. */
async function changeOne(
  l: Loaded,
  to: AttendanceStatus,
  extra: { lesson?: Record<string, unknown>; attendee?: Record<string, unknown> } = {},
): Promise<Applied> {
  const prepared = await prepareTransition(l.ct, l.attendee, to, l.policy, l.lesson.startAt as Timestamp);
  const applied = applyTransition(l.ct, l.lessonRef.id, l.attendee, to, prepared);
  l.ct.flush();
  l.ct.tx.update(l.attendee.ref, { ...applied.update, ...extra.attendee });
  const statuses = l.siblings.map((d) => (d.id === l.attendee.id ? to : (d.get('status') as AttendanceStatus)));
  l.ct.tx.update(l.lessonRef, { ...lessonStateOf(statuses), ...extra.lesson, updatedAt: now() });
  return applied;
}

// ---------------------------------------------------------------------------------------------
// setAttendance: present / absent / lateCancelled / booked (= unmark)
// ---------------------------------------------------------------------------------------------

export interface SetAttendanceInput {
  schoolId: string;
  lessonId: string;
  studentId: string;
  status: MarkableStatus;
}

export interface SetAttendanceResult {
  status: AttendanceStatus;
  /** What happened to the credit: debited from a lot, recorded as owed, restored, or nothing. */
  charge: Charge;
  enrolmentId: string | null;
}

export async function setAttendance(
  db: Firestore,
  input: SetAttendanceInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<SetAttendanceResult> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const l = await loadOne(new CreditTx(tx, school, actor, at), input);
    assertCanMark(actor, l.lesson.teacherId as string);
    const from = l.attendee.get('status') as AttendanceStatus;
    if (from === input.status) {
      return { status: from, charge: 'none', enrolmentId: (l.attendee.get('enrolmentId') as string | null) ?? null };
    }
    if (from === 'removed') throw new HttpsError('failed-precondition', 'Add the student back to the lesson first');
    const { charge, enrolmentId } = await changeOne(l, input.status);
    audit(tx, school, actor, 'setAttendance', `lessons/${input.lessonId}/attendees/${input.studentId}`, {
      from,
      to: input.status,
      charge,
    });
    return { status: input.status, charge, enrolmentId };
  });
}

// ---------------------------------------------------------------------------------------------
// cancelAttendance: on time or late, from policy.lateCancelHours
// ---------------------------------------------------------------------------------------------

export const CANCEL_MODES = ['auto', 'onTime', 'late'] as const;
export type CancelMode = (typeof CANCEL_MODES)[number];

export interface CancelAttendanceInput {
  schoolId: string;
  lessonId: string;
  studentId: string;
  /** 'auto' decides from the policy; staff may force 'onTime' (e.g. illness waived) or 'late'. */
  mode?: CancelMode;
}

export interface CancelAttendanceResult {
  status: 'cancelled' | 'lateCancelled';
  late: boolean;
  charge: Charge;
}

/** Late when the cancellation is inside `lateCancelHours` of the start (or after it). */
export function isLateCancel(lessonStart: Date, at: Date, policy: CreditPolicy): boolean {
  return lessonStart.getTime() - at.getTime() < policy.lateCancelHours * HOUR_MS;
}

export async function cancelAttendance(
  db: Firestore,
  input: CancelAttendanceInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<CancelAttendanceResult> {
  const school = schoolRef(db, input.schoolId);
  const mode = input.mode ?? 'auto';
  return db.runTransaction(async (tx) => {
    const l = await loadOne(new CreditTx(tx, school, actor, at), input);
    const late =
      mode === 'auto' ? isLateCancel((l.lesson.startAt as Timestamp).toDate(), at, l.policy) : mode === 'late';

    if (actor.role === 'student') {
      if (actor.studentId !== input.studentId) {
        throw new HttpsError('permission-denied', 'You can only cancel your own lessons');
      }
      if (mode !== 'auto') throw new HttpsError('permission-denied', 'Only staff can choose how a cancel counts');
      if (late) {
        throw new HttpsError(
          'failed-precondition',
          `Lessons can be cancelled online up to ${l.policy.lateCancelHours} hours before. Please contact the studio.`,
        );
      }
    } else {
      assertCanMark(actor, l.lesson.teacherId as string);
    }

    const to = late ? 'lateCancelled' : 'cancelled';
    const from = l.attendee.get('status') as AttendanceStatus;
    if (from === 'removed') throw new HttpsError('failed-precondition', 'That student was removed from this lesson');
    if (from === to) return { status: to, late, charge: 'none' };
    const { charge, update } = await changeOne(l, to, { attendee: { cancelledAt: Timestamp.fromDate(at), cancelledBy: actor.uid } });
    enqueueAlert(
      tx,
      school,
      `cancel_${input.lessonId}_${input.studentId}_${update.rev as number}`,
      {
        type: 'attendee.cancelled',
        lessonId: input.lessonId,
        studentId: input.studentId,
        startAt: (l.lesson.startAt as Timestamp).toDate(),
        late,
        charge,
        byStudent: actor.role === 'student',
      },
      actor,
      at,
    );
    audit(tx, school, actor, 'cancelAttendance', `lessons/${input.lessonId}/attendees/${input.studentId}`, {
      from,
      to,
      mode,
      charge,
    });
    return { status: to, late, charge };
  });
}

// ---------------------------------------------------------------------------------------------
// addAttendee / removeAttendee
// ---------------------------------------------------------------------------------------------

export interface AttendeeInput {
  schoolId: string;
  lessonId: string;
  studentId: string;
}

export function newAttendeeDoc(schoolId: string, lessonId: string, studentId: string, startAt: Timestamp, source = 'admin') {
  return {
    schoolId,
    lessonId,
    studentId,
    lessonStartAt: startAt,
    status: 'booked',
    owed: false,
    enrolmentId: null,
    ledgerEntryId: null,
    rev: 0,
    source,
    markedBy: null,
    markedAt: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

/**
 * Chooses which package pays for a student's lesson (null = earliest expiry). Before the credit is taken
 * it is only remembered. After, the charge moves: the credit goes back to the package (or owed lesson) it
 * came from and is taken from the chosen one, each side a ledger entry, so balances stay reconcilable.
 */
export async function setAttendeePackage(
  db: Firestore,
  input: AttendeeInput & { enrolmentId: string | null },
  actor: Actor,
  at: Date = new Date(),
): Promise<{ ok: true; moved: boolean }> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const lessonRef = school.collection('lessons').doc(input.lessonId);
    const attendeeRef = lessonRef.collection('attendees').doc(input.studentId);
    const lotRef = (id: string) => school.collection('enrolments').doc(id);
    const [lessonSnap, attendeeSnap] = await readAll(tx, lessonRef, attendeeRef);
    if (!lessonSnap?.exists) notFound('Lesson');
    if (!attendeeSnap?.exists) notFound('Student on this lesson');
    const chargedId = attendeeSnap.get('ledgerEntryId') as string | null;
    const fromId = (attendeeSnap.get('enrolmentId') as string | null) ?? null;
    const [lotSnap, fromSnap] = await readAll(
      tx,
      ...(input.enrolmentId ? [lotRef(input.enrolmentId)] : []),
      ...(chargedId && fromId && fromId !== input.enrolmentId ? [lotRef(fromId)] : []),
    );
    const target = input.enrolmentId ? lotSnap : undefined;
    if (input.enrolmentId && (!target?.exists || target.get('studentId') !== input.studentId)) {
      throw new HttpsError('invalid-argument', "That package isn't this student's");
    }
    const path = `lessons/${input.lessonId}/attendees/${input.studentId}`;

    // Not charged yet, already on that package, or back to "auto": just remember the choice.
    if (chargedId == null || !input.enrolmentId || input.enrolmentId === fromId) {
      tx.update(attendeeRef, { preferredEnrolmentId: input.enrolmentId, updatedAt: now() });
      audit(tx, school, actor, 'setAttendeePackage', path, { enrolmentId: input.enrolmentId });
      return { ok: true, moved: false };
    }

    if (lessonSnap.get('status') === 'cancelled') throw new HttpsError('failed-precondition', 'This lesson is cancelled');
    if (attendeeSnap.get('makeUp')) {
      throw new HttpsError('failed-precondition', 'A make-up was already given for this lesson, so its credit stays where it is.');
    }
    const ct = new CreditTx(tx, school, actor, at);
    const to = ct.useLot(target!);
    const startMs = (lessonSnap.get('startAt') as Timestamp).toMillis();
    if (to.status !== 'active' || to.remaining <= 0) throw new HttpsError('failed-precondition', 'That package has no credits left');
    if (to.validUntilMs < startMs) {
      throw new HttpsError('failed-precondition', "That package doesn't cover this lesson's date");
    }
    const from = fromId ? ct.useLot(fromSnap!) : null;
    const attendeeKey = `${input.lessonId}_${input.studentId}`;
    const rev = ((attendeeSnap.get('rev') as number | undefined) ?? 0) + 1;
    ct.restore(input.studentId, from, { lessonId: input.lessonId, attendeeKey, key: `${attendeeKey}:${rev}:move`, reversesEntryId: chargedId });
    const entryId = ct.debit(input.studentId, to, { lessonId: input.lessonId, attendeeKey, key: `${attendeeKey}:${rev}:move:debit` });
    ct.flush();
    tx.update(attendeeRef, {
      ledgerEntryId: entryId,
      enrolmentId: to.id,
      owed: false,
      preferredEnrolmentId: to.id,
      rev,
      updatedAt: now(),
    });
    audit(tx, school, actor, 'setAttendeePackage', path, { enrolmentId: to.id, movedFrom: fromId });
    return { ok: true, moved: true };
  });
}

export async function addAttendee(
  db: Firestore,
  input: AttendeeInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<{ added: boolean }> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const ct = new CreditTx(tx, school, actor, at);
    const lessonRef = school.collection('lessons').doc(input.lessonId);
    const attendeeRef = lessonRef.collection('attendees').doc(input.studentId);
    const [schoolSnap, lessonSnap, studentSnap, attendeeSnap] = await readAll(
      tx,
      school,
      lessonRef,
      school.collection('students').doc(input.studentId),
      attendeeRef,
    );
    if (!schoolSnap.exists) notFound('School');
    if (!lessonSnap.exists) notFound('Lesson');
    if (!studentSnap.exists) notFound('Student');
    if (studentSnap.get('status') === 'archived') throw new HttpsError('failed-precondition', 'This student is archived');
    const lesson = lessonSnap.data()!;
    if (lesson.status === 'cancelled') throw new HttpsError('failed-precondition', 'This lesson is cancelled');

    const current = attendeeSnap.exists ? (attendeeSnap.get('status') as AttendanceStatus) : null;
    if (current === 'booked' || current === 'present' || current === 'absent') return { added: false };

    const siblings = (await tx.get(lessonRef.collection('attendees'))).docs;
    const policy = resolvePolicy(schoolSnap.get('policy'));
    let rev = 0;
    if (attendeeSnap.exists) {
      // Back on after a cancel or removal: re-book (a late cancel that kept its credit gives it back).
      const prepared = await prepareTransition(ct, attendeeSnap, 'booked', policy, lesson.startAt as Timestamp);
      const { update } = applyTransition(ct, input.lessonId, attendeeSnap, 'booked', prepared);
      ct.flush();
      tx.update(attendeeRef, { ...update, cancelledAt: null, cancelledBy: null });
      rev = update.rev as number;
    } else {
      tx.create(attendeeRef, newAttendeeDoc(input.schoolId, input.lessonId, input.studentId, lesson.startAt as Timestamp));
    }
    const startAt = (lesson.startAt as Timestamp).toDate();
    // Putting someone on a past lesson is record-keeping, not a booking.
    if (startAt > at) {
      enqueueAlert(
        tx,
        school,
        `book_${input.lessonId}_${input.studentId}_${rev}`,
        { type: 'lesson.booked', lessonId: input.lessonId, studentIds: [input.studentId], startAt, source: 'admin' },
        actor,
        at,
      );
    }
    const studentIds = [...new Set([...(lesson.studentIds as string[]), input.studentId])];
    const statuses = siblings.filter((d) => d.id !== input.studentId).map((d) => d.get('status') as AttendanceStatus);
    tx.update(lessonRef, {
      studentIds: FieldValue.arrayUnion(input.studentId),
      capacity: Math.max((lesson.capacity as number | undefined) ?? 1, studentIds.length),
      ...lessonStateOf([...statuses, 'booked']),
      // A one-off change to a series occurrence: later series edits leave this lesson alone.
      ...(lesson.seriesId ? { isException: true } : {}),
      updatedAt: now(),
    });
    audit(tx, school, actor, 'addAttendee', `lessons/${input.lessonId}/attendees/${input.studentId}`, { from: current });
    return { added: true };
  });
}

/** Takes a student off a lesson. A charge is restored; the attendee doc stays (status removed) for history. */
export async function removeAttendee(
  db: Firestore,
  input: AttendeeInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<{ charge: Charge }> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const l = await loadOne(new CreditTx(tx, school, actor, at), input);
    const from = l.attendee.get('status') as AttendanceStatus;
    if (from === 'removed') return { charge: 'none' as Charge };
    const { charge, update } = await changeOne(l, 'removed', {
      lesson: { studentIds: FieldValue.arrayRemove(input.studentId), ...(l.lesson.seriesId ? { isException: true } : {}) },
    });
    // Taking an already-cancelled student off is tidying up; the cancel had its own alert.
    if (from !== 'cancelled' && from !== 'lateCancelled') {
      enqueueAlert(
        tx,
        school,
        `remove_${input.lessonId}_${input.studentId}_${update.rev as number}`,
        {
          type: 'attendee.removed',
          lessonId: input.lessonId,
          studentId: input.studentId,
          startAt: (l.lesson.startAt as Timestamp).toDate(),
          charge,
        },
        actor,
        at,
      );
    }
    audit(tx, school, actor, 'removeAttendee', `lessons/${input.lessonId}/attendees/${input.studentId}`, { from, charge });
    return { charge };
  });
}

// ---------------------------------------------------------------------------------------------
// cancelLesson: the studio cancels; every charged attendee gets their credit back
// ---------------------------------------------------------------------------------------------

export interface CancelLessonResult {
  restored: number;
  alreadyCancelled: boolean;
}

/**
 * Cancels one lesson inside an existing CreditTx (also used by series edits). Reads first, then
 * returns a function that does the writes, so several lessons can share one transaction.
 */
export async function prepareCancelLesson(
  ct: CreditTx,
  lessonRef: DocumentReference,
  lesson: DocumentData,
  policy: CreditPolicy,
  reason: string | null,
): Promise<() => number> {
  const attendees = (await ct.tx.get(lessonRef.collection('attendees'))).docs;
  const plans: { att: DocumentSnapshot; to: AttendanceStatus; prepared: Prepared }[] = [];
  for (const att of attendees) {
    const from = att.get('status') as AttendanceStatus;
    if (from === 'removed') continue;
    const charged = att.get('ledgerEntryId') != null;
    // On-time and late cancels stay as they were, unless a late cancel kept its credit.
    if ((from === 'cancelled' || from === 'lateCancelled') && !charged) continue;
    const to: AttendanceStatus = 'cancelled';
    plans.push({ att, to, prepared: await prepareTransition(ct, att, to, policy, lesson.startAt as Timestamp) });
  }
  return () => {
    let restored = 0;
    for (const p of plans) {
      const { charge, update } = applyTransition(ct, lessonRef.id, p.att, p.to, p.prepared);
      if (charge === 'restored' || charge === 'restoredExpired') restored += 1;
      ct.tx.update(p.att.ref, { ...update, cancelledAt: Timestamp.fromDate(ct.at), cancelledBy: ct.actor.uid });
    }
    ct.tx.update(lessonRef, {
      status: 'cancelled',
      cancelReason: reason,
      cancelledAt: Timestamp.fromDate(ct.at),
      cancelledBy: ct.actor.uid,
      updatedAt: now(),
    });
    return restored;
  };
}

/** One alert for a cancelled lesson (cancelLesson, and editLesson with scope 'one'). */
export function enqueueLessonCancelled(ct: CreditTx, lessonId: string, lesson: DocumentData, restored: number, reason: string | null): void {
  enqueueAlert(
    ct.tx,
    ct.school,
    `lessoncancel_${lessonId}`,
    {
      type: 'lesson.cancelled',
      lessonId,
      studentIds: lesson.studentIds as string[],
      startAt: (lesson.startAt as Timestamp).toDate(),
      restored,
      reason,
    },
    ct.actor,
    ct.at,
  );
}

export async function cancelLesson(
  db: Firestore,
  input: { schoolId: string; lessonId: string; reason?: string | null },
  actor: Actor,
  at: Date = new Date(),
): Promise<CancelLessonResult> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const ct = new CreditTx(tx, school, actor, at);
    const lessonRef = school.collection('lessons').doc(input.lessonId);
    const [schoolSnap, lessonSnap] = await readAll(tx, school, lessonRef);
    if (!schoolSnap.exists) notFound('School');
    if (!lessonSnap.exists) notFound('Lesson');
    const lesson = lessonSnap.data()!;
    if (lesson.status === 'cancelled') return { restored: 0, alreadyCancelled: true };
    const write = await prepareCancelLesson(ct, lessonRef, lesson, resolvePolicy(schoolSnap.get('policy')), input.reason ?? null);
    const restored = write();
    ct.flush();
    enqueueLessonCancelled(ct, lessonRef.id, lesson, restored, input.reason ?? null);
    audit(tx, school, actor, 'cancelLesson', `lessons/${input.lessonId}`, { restored, reason: input.reason ?? null });
    return { restored, alreadyCancelled: false };
  });
}

/**
 * A note for one student about one lesson (what was covered, homework), shown to that student in the
 * learn portal. Owners/admins for any lesson; a teacher only for their own lessons.
 */
export async function setLessonNote(
  db: Firestore,
  input: AttendeeInput & { note: string | null },
  actor: Actor,
): Promise<{ ok: true }> {
  const school = schoolRef(db, input.schoolId);
  const lessonRef = school.collection('lessons').doc(input.lessonId);
  return db.runTransaction(async (tx) => {
    const [lessonSnap, attendeeSnap] = await readAll(tx, lessonRef, lessonRef.collection('attendees').doc(input.studentId));
    if (!lessonSnap.exists) notFound('Lesson');
    if (!attendeeSnap.exists) notFound('Student on this lesson');
    if (actor.role === 'teacher' && lessonSnap.get('teacherId') !== actor.teacherId) {
      throw new HttpsError('permission-denied', 'You can only write notes on your own lessons');
    }
    const note = input.note?.trim().slice(0, 4000) || null;
    tx.update(attendeeSnap.ref, { sharedNote: note, sharedNoteAt: note ? now() : null, sharedNoteBy: note ? actor.uid : null, updatedAt: now() });
    audit(tx, school, actor, 'setLessonNote', `lessons/${input.lessonId}/attendees/${input.studentId}`, { length: note?.length ?? 0 });
    return { ok: true as const };
  });
}
