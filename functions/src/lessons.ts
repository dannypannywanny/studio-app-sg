import { Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type Query } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { enqueueAlert } from './alerts';
import { newAttendeeDoc } from './attendance';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';

/** Longest lesson we accept; also bounds the conflict query window. */
export const MAX_DURATION_MIN = 12 * 60;
const MIN_MS = 60_000;

/** A teacher's lessons that could overlap anything in [fromMs, toMs). */
export function teacherWindow(school: DocumentReference, teacherId: string, fromMs: number, toMs: number): Query {
  return school
    .collection('lessons')
    .where('teacherId', '==', teacherId)
    .where('startAt', '>', Timestamp.fromMillis(fromMs - MAX_DURATION_MIN * MIN_MS))
    .where('startAt', '<', Timestamp.fromMillis(toMs));
}

/** The first scheduled lesson overlapping [start, end), ignoring the ids in `ignore`. */
export function findClash(
  lessons: DocumentSnapshot[],
  startMs: number,
  endMs: number,
  ignore: ReadonlySet<string> = new Set(),
): DocumentSnapshot | undefined {
  return lessons.find(
    (d) =>
      !ignore.has(d.id) &&
      d.get('status') !== 'cancelled' &&
      (d.get('startAt') as Timestamp).toMillis() < endMs &&
      (d.get('endAt') as Timestamp).toMillis() > startMs,
  );
}

export interface LessonShape {
  teacherId: string;
  subjectId: string;
  locationId?: string | null;
  isOnline: boolean;
  meetingUrl?: string | null;
  durationMin: number;
}

/** Writes a new scheduled lesson and its booked attendees. */
export function writeLesson(
  tx: FirebaseFirestore.Transaction,
  ref: DocumentReference,
  schoolId: string,
  shape: LessonShape,
  startMs: number,
  studentIds: string[],
  actor: Actor,
  series: { seriesId: string; occurrenceDate: string } | null = null,
  /** Replace a doc being rewritten in the same transaction (a series edit) instead of creating it. */
  overwrite = false,
  /** Who put the students on it: staff ('admin') or the student portal ('portal'). */
  source: 'admin' | 'portal' = 'admin',
): void {
  const startTs = Timestamp.fromMillis(startMs);
  const put = (r: DocumentReference, data: FirebaseFirestore.DocumentData) => (overwrite ? tx.set(r, data) : tx.create(r, data));
  put(ref, {
    teacherId: shape.teacherId,
    subjectId: shape.subjectId,
    locationId: shape.locationId ?? null,
    isOnline: shape.isOnline,
    meetingUrl: shape.meetingUrl ?? null,
    startAt: startTs,
    endAt: Timestamp.fromMillis(startMs + shape.durationMin * MIN_MS),
    durationMin: shape.durationMin,
    seriesId: series?.seriesId ?? null,
    occurrenceDate: series?.occurrenceDate ?? null,
    isException: false,
    status: 'scheduled',
    capacity: Math.max(1, studentIds.length),
    studentIds,
    attendanceState: 'unmarked',
    createdBy: actor.uid,
    createdAt: now(),
    updatedAt: now(),
  });
  for (const studentId of studentIds) {
    put(ref.collection('attendees').doc(studentId), newAttendeeDoc(schoolId, ref.id, studentId, startTs, source));
  }
}

/** Reads and checks the teacher, subject and students a lesson or series refers to. */
export async function checkRefs(
  tx: FirebaseFirestore.Transaction,
  school: DocumentReference,
  refs: { teacherId: string; subjectId: string; studentIds: string[] },
): Promise<DocumentSnapshot> {
  const [schoolSnap, teacherSnap, subjectSnap, ...studentSnaps] = await readAll(
    tx,
    school,
    school.collection('teachers').doc(refs.teacherId),
    school.collection('subjects').doc(refs.subjectId),
    ...refs.studentIds.map((id) => school.collection('students').doc(id)),
  );
  if (!schoolSnap.exists) notFound('School');
  if (!teacherSnap.exists || teacherSnap.get('active') === false) notFound('Teacher');
  if (!subjectSnap.exists) notFound('Subject');
  for (const s of studentSnaps) {
    if (!s.exists) notFound(`Student ${s.id}`);
    if (s.get('status') === 'archived') throw new HttpsError('failed-precondition', `Student ${s.id} is archived`);
  }
  return schoolSnap;
}

export interface CreateLessonInput {
  schoolId: string;
  teacherId: string;
  subjectId: string;
  startAt: Date;
  durationMin: number;
  studentIds: string[];
  isOnline: boolean;
  locationId?: string | null;
  meetingUrl?: string | null;
}

export interface CreateLessonResult {
  lessonId: string;
}

export async function createLesson(
  db: Firestore,
  input: CreateLessonInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<CreateLessonResult> {
  const school = schoolRef(db, input.schoolId);
  const studentIds = [...new Set(input.studentIds)];
  if (studentIds.length === 0) throw new HttpsError('invalid-argument', 'Add at least one student');
  if (input.durationMin < 5 || input.durationMin > MAX_DURATION_MIN) {
    throw new HttpsError('invalid-argument', 'Duration must be between 5 minutes and 12 hours');
  }
  const start = input.startAt.getTime();
  const end = start + input.durationMin * 60_000;

  return db.runTransaction(async (tx) => {
    await checkRefs(tx, school, { teacherId: input.teacherId, subjectId: input.subjectId, studentIds });

    // Teacher conflict: any scheduled lesson for this teacher overlapping [start, end).
    const nearby = await tx.get(teacherWindow(school, input.teacherId, start, end));
    const clash = findClash(nearby.docs, start, end);
    if (clash) {
      throw new HttpsError('already-exists', 'This teacher already has a lesson at that time', {
        conflictLessonId: clash.id,
      });
    }

    const lessonRef = school.collection('lessons').doc();
    writeLesson(tx, lessonRef, input.schoolId, input, start, studentIds, actor);
    // A lesson entered after the fact is record-keeping, not a booking.
    if (start > at.getTime()) {
      enqueueAlert(
        tx,
        school,
        `lesson_${lessonRef.id}`,
        { type: 'lesson.booked', lessonId: lessonRef.id, studentIds, startAt: input.startAt, source: 'admin' },
        actor,
        at,
      );
    }
    audit(tx, school, actor, 'createLesson', `lessons/${lessonRef.id}`, { teacherId: input.teacherId, studentIds });
    return { lessonId: lessonRef.id };
  });
}
