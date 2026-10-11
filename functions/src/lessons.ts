import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';

/** Longest lesson we accept; also bounds the conflict query window. */
export const MAX_DURATION_MIN = 12 * 60;

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

export async function createLesson(db: Firestore, input: CreateLessonInput, actor: Actor): Promise<CreateLessonResult> {
  const school = schoolRef(db, input.schoolId);
  const studentIds = [...new Set(input.studentIds)];
  if (studentIds.length === 0) throw new HttpsError('invalid-argument', 'Add at least one student');
  if (input.durationMin < 5 || input.durationMin > MAX_DURATION_MIN) {
    throw new HttpsError('invalid-argument', 'Duration must be between 5 minutes and 12 hours');
  }
  const start = input.startAt.getTime();
  const end = start + input.durationMin * 60_000;

  return db.runTransaction(async (tx) => {
    const [schoolSnap, teacherSnap, subjectSnap, ...studentSnaps] = await readAll(
      tx,
      school,
      school.collection('teachers').doc(input.teacherId),
      school.collection('subjects').doc(input.subjectId),
      ...studentIds.map((id) => school.collection('students').doc(id)),
    );
    if (!schoolSnap.exists) notFound('School');
    if (!teacherSnap.exists || teacherSnap.get('active') === false) notFound('Teacher');
    if (!subjectSnap.exists) notFound('Subject');
    for (const s of studentSnaps) {
      if (!s.exists) notFound(`Student ${s.id}`);
      if (s.get('status') === 'archived') throw new HttpsError('failed-precondition', `Student ${s.id} is archived`);
    }

    // Teacher conflict: any scheduled lesson for this teacher overlapping [start, end).
    const nearby = await tx.get(
      school
        .collection('lessons')
        .where('teacherId', '==', input.teacherId)
        .where('startAt', '>', Timestamp.fromMillis(start - MAX_DURATION_MIN * 60_000))
        .where('startAt', '<', Timestamp.fromMillis(end)),
    );
    const clash = nearby.docs.find(
      (d) => d.get('status') !== 'cancelled' && (d.get('endAt') as Timestamp).toMillis() > start,
    );
    if (clash) {
      throw new HttpsError('already-exists', 'This teacher already has a lesson at that time', {
        conflictLessonId: clash.id,
      });
    }

    const lessonRef = school.collection('lessons').doc();
    const startTs = Timestamp.fromMillis(start);
    tx.create(lessonRef, {
      teacherId: input.teacherId,
      subjectId: input.subjectId,
      locationId: input.locationId ?? null,
      isOnline: input.isOnline,
      meetingUrl: input.meetingUrl ?? null,
      startAt: startTs,
      endAt: Timestamp.fromMillis(end),
      durationMin: input.durationMin,
      seriesId: null,
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
      tx.create(lessonRef.collection('attendees').doc(studentId), {
        schoolId: input.schoolId,
        lessonId: lessonRef.id,
        studentId,
        lessonStartAt: startTs,
        status: 'booked',
        owed: false,
        enrolmentId: null,
        ledgerEntryId: null,
        rev: 0,
        source: 'admin',
        markedBy: null,
        markedAt: null,
        createdAt: now(),
        updatedAt: now(),
      });
    }
    audit(tx, school, actor, 'createLesson', `lessons/${lessonRef.id}`, { teacherId: input.teacherId, studentIds });
    return { lessonId: lessonRef.id };
  });
}
