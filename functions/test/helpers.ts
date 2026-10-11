import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { DEFAULT_POLICY, type CreditPolicy } from '@lessonkaki/shared';
import { createLesson } from '../src/lessons';
import { sellPackage } from '../src/credits';
import type { Actor } from '../src/db';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Tests run against the Firestore emulator only. Use `pnpm test` (firebase emulators:exec).');
}
if (!getApps().length) initializeApp({ projectId: 'demo-lessonkaki' });

export const db = getFirestore();
export const owner: Actor = { uid: 'owner-uid', role: 'owner' };
export const DAY = 86_400_000;

export interface TestSchool {
  schoolId: string;
  teacherId: string;
  subjectId: string;
  studentId: string;
  /** 4 sessions, SGD 300, 30-day validity */
  pkg30: string;
  /** 4 sessions, SGD 300, 90-day validity */
  pkg90: string;
  /** 4 sessions, SGD 300, no expiry */
  pkgNoExpiry: string;
}

/** A fresh, isolated school per test (random id), so tests never see each other's data. */
export async function makeSchool(policy: Partial<CreditPolicy> = {}): Promise<TestSchool> {
  const schoolId = `t_${randomUUID().slice(0, 8)}`;
  const school = db.collection('schools').doc(schoolId);
  const t: TestSchool = {
    schoolId,
    teacherId: 'teacher1',
    subjectId: 'voice',
    studentId: 'student1',
    pkg30: 'four30',
    pkg90: 'four90',
    pkgNoExpiry: 'fourForever',
  };
  const batch = db.batch();
  batch.set(school, {
    name: 'Test School',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
    policy: { ...DEFAULT_POLICY, ...policy },
  });
  batch.set(school.collection('teachers').doc(t.teacherId), { displayName: 'Teacher One', active: true });
  batch.set(school.collection('teachers').doc('teacher2'), { displayName: 'Teacher Two', active: true });
  batch.set(school.collection('subjects').doc(t.subjectId), { name: 'Voice', defaultDurationMin: 60, active: true });
  const pkg = { sessions: 4, priceCents: 30000, kind: 'paid', active: true };
  batch.set(school.collection('packages').doc(t.pkg30), { ...pkg, name: '4 Sessions', validityDays: 30 });
  batch.set(school.collection('packages').doc(t.pkg90), { ...pkg, name: '4 Sessions (90 days)', validityDays: 90 });
  batch.set(school.collection('packages').doc(t.pkgNoExpiry), { ...pkg, name: '4 Sessions (no expiry)', validityDays: null });
  batch.set(school.collection('students').doc(t.studentId), {
    firstName: 'Test',
    lastName: 'Student',
    status: 'active',
    summary: { sessionsAvailable: 0, sessionsOwed: 0 },
  });
  await batch.commit();
  return t;
}

export function sell(t: TestSchool, packageId: string, at = new Date(), key: string = randomUUID()) {
  return sellPackage(db, { schoolId: t.schoolId, studentId: t.studentId, packageId, idempotencyKey: key }, owner, at);
}

let minuteOffset = 0;
/** A one-hour lesson; each call is offset so lessons never clash unless a test wants them to. */
export async function lesson(t: TestSchool, startAt = new Date(Date.now() - DAY + minuteOffset++ * 61 * 60_000)) {
  const { lessonId } = await createLesson(
    db,
    {
      schoolId: t.schoolId,
      teacherId: t.teacherId,
      subjectId: t.subjectId,
      startAt,
      durationMin: 60,
      studentIds: [t.studentId],
      isOnline: false,
    },
    owner,
  );
  return lessonId;
}

export async function summary(t: TestSchool) {
  const snap = await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).get();
  return snap.get('summary') as { sessionsAvailable: number; sessionsOwed: number };
}

export async function lot(t: TestSchool, enrolmentId: string) {
  return (await db.doc(`schools/${t.schoolId}/enrolments/${enrolmentId}`).get()).data()!;
}

export async function attendee(t: TestSchool, lessonId: string) {
  return (await db.doc(`schools/${t.schoolId}/lessons/${lessonId}/attendees/${t.studentId}`).get()).data()!;
}

export async function ledger(t: TestSchool) {
  const snap = await db.collection(`schools/${t.schoolId}/ledger`).where('studentId', '==', t.studentId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string });
}

export { Timestamp };
