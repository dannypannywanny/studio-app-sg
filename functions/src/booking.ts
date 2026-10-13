// Student self-booking (learn site): open slots from teacher hours, and booking one of them.
//
// A teacher is busy during any scheduled lesson that still has someone on it (booked, present or
// absent). A lesson whose only student cancelled frees the slot again. Nothing is charged at booking:
// the lesson is an ordinary one-on-one and credits move when attendance is marked (policy debitOn
// 'mark'), going owed when the student has none.
import { Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type Query, type QuerySnapshot } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  bookingWindow,
  openSlots,
  resolveAvailability,
  slotLockId,
  type AttendanceStatus,
  type BusyInterval,
  type LessonMode,
  type ResolvedAvailability,
} from '@lessonkaki/shared';
import { enqueueAlert } from './alerts';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';
import { MAX_DURATION_MIN, checkRefs, teacherWindow, writeLesson } from './lessons';

/** Attendee statuses that keep the teacher's time taken. */
const HOLDS_TIME: ReadonlySet<AttendanceStatus> = new Set(['booked', 'present', 'absent']);
const MAX_LESSON_MS = MAX_DURATION_MIN * 60_000;
const DAY_MS = 86_400_000;

/** Reads through a transaction or straight from the database, so the same helpers serve both. */
interface Reader {
  query(q: Query): Promise<QuerySnapshot>;
  docs(refs: DocumentReference[]): Promise<DocumentSnapshot[]>;
}
const dbReader = (db: Firestore): Reader => ({
  query: (q) => q.get(),
  docs: async (refs) => (refs.length ? db.getAll(...refs) : []),
});
const txReader = (tx: FirebaseFirestore.Transaction): Reader => ({
  query: (q) => tx.get(q),
  docs: async (refs) => (refs.length ? tx.getAll(...refs) : []),
});

const startMs = (d: DocumentSnapshot) => (d.get('startAt') as Timestamp).toMillis();
const endMs = (d: DocumentSnapshot) => (d.get('endAt') as Timestamp).toMillis();
/**
 * Upcoming portal bookings one student may hold at once (schools/{s}.booking.maxUpcoming).
 * Unset or null = no limit (Daniel's studio); a school that wants a cap sets a number.
 */
const maxUpcoming = (school: DocumentSnapshot): number | null => {
  const n = school.get('booking.maxUpcoming');
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * Who must have a session before booking online (schools/{s}.booking.creditRequired):
 * 'none' (default) books on credit like staff do; 'newStudents' asks anyone not migrated from the old
 * system (no legacyId) to buy first; 'all' asks everyone.
 */
export type CreditRule = 'none' | 'newStudents' | 'all';
export function creditRule(school: DocumentSnapshot): CreditRule {
  const r = school.get('booking.creditRequired');
  return r === 'newStudents' || r === 'all' ? r : 'none';
}
export function mustHaveCredit(rule: CreditRule, student: DocumentSnapshot): boolean {
  return rule === 'all' || (rule === 'newStudents' && !student.get('legacyId'));
}

/** The teacher's lessons overlapping [fromMs, toMs) that still have a student on them. */
export async function teacherBusy(
  read: Reader,
  school: DocumentReference,
  teacherId: string,
  fromMs: number,
  toMs: number,
): Promise<BusyInterval[]> {
  const lessons = (await read.query(teacherWindow(school, teacherId, fromMs, toMs))).docs.filter(
    (d) => d.get('status') !== 'cancelled' && endMs(d) > fromMs,
  );
  if (!lessons.length) return [];
  // One collection-group read for every attendee in the window, instead of one read per lesson.
  const attendees = await read.query(
    school.firestore
      .collectionGroup('attendees')
      .where('schoolId', '==', school.id)
      .where('lessonStartAt', '>', Timestamp.fromMillis(fromMs - MAX_LESSON_MS))
      .where('lessonStartAt', '<', Timestamp.fromMillis(toMs)),
  );
  const statuses = new Map<string, AttendanceStatus[]>();
  for (const a of attendees.docs) {
    const lessonId = a.ref.parent.parent!.id;
    statuses.set(lessonId, [...(statuses.get(lessonId) ?? []), a.get('status') as AttendanceStatus]);
  }
  return lessons
    .filter((d) => {
      const list = statuses.get(d.id);
      // No attendee docs found (shouldn't happen): keep it busy rather than double-book.
      return !list || list.some((s) => HOLDS_TIME.has(s));
    })
    .map((d) => ({ startMs: startMs(d), endMs: endMs(d) }));
}

interface OwnLesson {
  lessonId: string;
  teacherId: string;
  startMs: number;
  endMs: number;
  /** Still on it (booked / present / absent). */
  active: boolean;
  source: string | null;
}

/** The student's lessons overlapping [fromMs, toMs), with their own attendance on each. */
async function studentLessons(read: Reader, school: DocumentReference, studentId: string, fromMs: number, toMs: number): Promise<OwnLesson[]> {
  const lessons = (
    await read.query(
      school
        .collection('lessons')
        .where('studentIds', 'array-contains', studentId)
        .where('startAt', '>', Timestamp.fromMillis(fromMs - MAX_LESSON_MS))
        .where('startAt', '<', Timestamp.fromMillis(toMs)),
    )
  ).docs.filter((d) => d.get('status') !== 'cancelled' && endMs(d) > fromMs);
  const mine = await read.docs(lessons.map((d) => d.ref.collection('attendees').doc(studentId)));
  return lessons.map((d, i) => ({
    lessonId: d.id,
    teacherId: d.get('teacherId') as string,
    startMs: startMs(d),
    endMs: endMs(d),
    active: HOLDS_TIME.has(mine[i]?.get('status') as AttendanceStatus),
    source: (mine[i]?.get('source') as string | undefined) ?? null,
  }));
}

function requireStudent(actor: Actor): string {
  if (actor.role !== 'student' || !actor.studentId) throw new HttpsError('permission-denied', 'Only students can book here');
  return actor.studentId;
}

// ---------------------------------------------------------------------------------------------
// getAvailability
// ---------------------------------------------------------------------------------------------

export interface GetAvailabilityInput {
  schoolId: string;
  /** One teacher, or every bookable teacher. */
  teacherId?: string | null;
}

export interface BookableTeacher {
  teacherId: string;
  name: string;
  /** What booked lessons are for (packages for this subject are the ones to buy). */
  subjectId: string | null;
  lessonMin: number;
  inPerson: boolean;
  online: boolean;
}

export interface AvailabilityResult {
  timeZone: string;
  teachers: BookableTeacher[];
  /** ISO instants, sorted. */
  slots: { teacherId: string; startAt: string; inPerson: boolean; online: boolean }[];
  /** Upcoming lessons the student booked here, and how many they may hold (max null = no limit). Null for staff. */
  upcoming: { booked: number; max: number | null } | null;
  /**
   * The student's sessions: unused ones, how many upcoming lessons will use them, and whether they
   * must buy a package before booking (no free session and the school requires one). Null for staff.
   */
  credit: { sessionsAvailable: number; upcomingLessons: number; mustBuy: boolean } | null;
}

export async function getAvailability(
  db: Firestore,
  input: GetAvailabilityInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<AvailabilityResult> {
  const school = schoolRef(db, input.schoolId);
  const read = dbReader(db);
  const studentId = actor.role === 'student' ? requireStudent(actor) : null;
  const schoolSnap = await school.get();
  if (!schoolSnap.exists) notFound('School');
  const timeZone = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';

  const availDocs = input.teacherId
    ? [await school.collection('availability').doc(input.teacherId).get()].filter((d) => d.exists)
    : (await school.collection('availability').get()).docs;
  const teacherSnaps = await read.docs(availDocs.map((d) => school.collection('teachers').doc(d.id)));

  const bookable = availDocs.flatMap((d, i) => {
    const teacher = teacherSnaps[i]!;
    const av = resolveAvailability(d.data());
    if (!teacher.exists || teacher.get('active') === false || !av.bookable || !av.weekly.length) return [];
    return [{ teacherId: d.id, teacher, av }];
  });
  if (!bookable.length) return { timeZone, teachers: [], slots: [], upcoming: null, credit: null };

  // One window wide enough for every teacher.
  const windows = bookable.map((b) => bookingWindow(b.av, at));
  const fromMs = Math.min(...windows.map((w) => w.fromMs));
  const toMs = Math.max(...windows.map((w) => w.toMs));
  const own = studentId ? await studentLessons(read, school, studentId, at.getTime(), toMs + MAX_LESSON_MS) : [];
  const ownBusy = own.filter((l) => l.active).map((l) => ({ startMs: l.startMs, endMs: l.endMs }));

  const slots: AvailabilityResult['slots'] = [];
  for (const b of bookable) {
    const busy = await teacherBusy(read, school, b.teacherId, fromMs, toMs + MAX_LESSON_MS);
    for (const s of openSlots(b.av, { timeZone, now: at, busy })) {
      // The student's own lessons (with anyone) block that time for them, without the teacher's buffer.
      if (ownBusy.some((o) => o.startMs < s.endAt.getTime() && o.endMs > s.startAt.getTime())) continue;
      slots.push({ teacherId: b.teacherId, startAt: s.startAt.toISOString(), inPerson: s.inPerson, online: s.online });
    }
  }
  slots.sort((x, y) => x.startAt.localeCompare(y.startAt));

  return {
    timeZone,
    teachers: bookable.map((b) => ({
      teacherId: b.teacherId,
      name: (b.teacher.get('publicName') as string | undefined) || (b.teacher.get('displayName') as string) || 'Teacher',
      subjectId: b.av.subjectId ?? ((b.teacher.get('subjectIds') as string[] | undefined) ?? [])[0] ?? null,
      lessonMin: b.av.lessonMin,
      inPerson: b.av.weekly.some((w) => w.inPerson),
      online: b.av.weekly.some((w) => w.online),
    })),
    slots,
    upcoming: studentId
      ? { booked: own.filter((l) => l.active && l.source === 'portal' && l.startMs > at.getTime()).length, max: maxUpcoming(schoolSnap) }
      : null,
    credit: studentId ? await creditFor(school, schoolSnap, studentId, own, at) : null,
  };
}

async function creditFor(school: DocumentReference, schoolSnap: DocumentSnapshot, studentId: string, own: OwnLesson[], at: Date) {
  const student = await school.collection('students').doc(studentId).get();
  const sessionsAvailable = (student.get('summary.sessionsAvailable') as number | undefined) ?? 0;
  const upcomingLessons = own.filter((l) => l.active && l.startMs > at.getTime()).length;
  return { sessionsAvailable, upcomingLessons, mustBuy: mustHaveCredit(creditRule(schoolSnap), student) && sessionsAvailable - upcomingLessons < 1 };
}

// ---------------------------------------------------------------------------------------------
// bookLesson
// ---------------------------------------------------------------------------------------------

export interface BookLessonInput {
  schoolId: string;
  teacherId: string;
  startAt: Date;
  mode: LessonMode;
}

export interface BookLessonResult {
  lessonId: string;
  /** True when this exact booking already existed (a retried request): nothing new was written. */
  existing: boolean;
}

export async function bookLesson(db: Firestore, input: BookLessonInput, actor: Actor, at: Date = new Date()): Promise<BookLessonResult> {
  const studentId = requireStudent(actor);
  const school = schoolRef(db, input.schoolId);
  const start = input.startAt.getTime();

  return db.runTransaction(async (tx) => {
    const read = txReader(tx);
    const [schoolSnap, teacherSnap, availSnap] = await readAll(
      tx,
      school,
      school.collection('teachers').doc(input.teacherId),
      school.collection('availability').doc(input.teacherId),
    );
    if (!schoolSnap.exists) notFound('School');
    const timeZone = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const av: ResolvedAvailability = resolveAvailability(availSnap.data());
    if (!teacherSnap.exists || teacherSnap.get('active') === false || !availSnap.exists || !av.bookable) {
      throw new HttpsError('failed-precondition', 'This teacher is not taking bookings online');
    }
    const subjectId = av.subjectId ?? ((teacherSnap.get('subjectIds') as string[] | undefined) ?? [])[0];
    if (!subjectId) throw new HttpsError('failed-precondition', 'This teacher has no subject set up for booking');
    await checkRefs(tx, school, { teacherId: input.teacherId, subjectId, studentIds: [studentId] });

    const end = start + av.lessonMin * 60_000;
    // Bookings for this teacher and day(s) run one after the other (see slotLockId).
    const lockIds = new Set([slotLockId(input.teacherId, new Date(start), timeZone), slotLockId(input.teacherId, new Date(end), timeZone)]);
    const lockRefs = [...lockIds].map((id) => school.collection('slotLocks').doc(id));
    await read.docs(lockRefs);

    const window = bookingWindow(av, at);
    const own = await studentLessons(read, school, studentId, at.getTime(), Math.max(window.toMs, end) + DAY_MS);
    const same = own.find((l) => l.active && l.teacherId === input.teacherId && l.startMs === start);
    if (same) return { lessonId: same.lessonId, existing: true };
    if (own.some((l) => l.active && l.startMs < end && l.endMs > start)) {
      throw new HttpsError('failed-precondition', 'You already have a lesson at that time');
    }
    const studentSnap = await tx.get(school.collection('students').doc(studentId));
    if (mustHaveCredit(creditRule(schoolSnap), studentSnap)) {
      const free = ((studentSnap.get('summary.sessionsAvailable') as number | undefined) ?? 0) - own.filter((l) => l.active && l.startMs > at.getTime()).length;
      if (free < 1) throw new HttpsError('failed-precondition', 'Buy a package first: your sessions are all used or booked.', { needsPackage: true });
    }
    const booked = own.filter((l) => l.active && l.source === 'portal' && l.startMs > at.getTime()).length;
    const max = maxUpcoming(schoolSnap);
    if (max !== null && booked >= max) {
      throw new HttpsError(
        'failed-precondition',
        `You can have up to ${max} upcoming lessons booked here. Please contact the studio to book more.`,
      );
    }

    const bufferMs = av.bufferMin * 60_000;
    const busy = await teacherBusy(read, school, input.teacherId, start - bufferMs, end + bufferMs);
    const slot = openSlots(av, { timeZone, now: at, busy, from: input.startAt, to: input.startAt }).find(
      (s) => s.startAt.getTime() === start,
    );
    if (!slot) throw new HttpsError('failed-precondition', 'That time is no longer available. Please pick another.');
    if (!slot[input.mode]) {
      throw new HttpsError('failed-precondition', input.mode === 'online' ? 'That time is in person only' : 'That time is online only');
    }

    // Writes start here.
    for (const ref of lockRefs) tx.set(ref, { teacherId: input.teacherId, lastBookedAt: now(), updatedAt: now() }, { merge: true });
    const lessonRef = school.collection('lessons').doc();
    const isOnline = input.mode === 'online';
    writeLesson(
      tx,
      lessonRef,
      input.schoolId,
      { teacherId: input.teacherId, subjectId, isOnline, locationId: isOnline ? null : slot.locationId, durationMin: av.lessonMin },
      start,
      [studentId],
      actor,
      null,
      false,
      'portal',
    );
    enqueueAlert(
      tx,
      school,
      `lesson_${lessonRef.id}`,
      { type: 'lesson.booked', lessonId: lessonRef.id, studentIds: [studentId], startAt: input.startAt, source: 'portal', payment: null },
      actor,
      at,
    );
    audit(tx, school, actor, 'bookLesson', `lessons/${lessonRef.id}`, { teacherId: input.teacherId, studentId, mode: input.mode });
    return { lessonId: lessonRef.id, existing: false };
  });
}
