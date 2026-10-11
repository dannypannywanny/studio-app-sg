import { randomUUID } from 'node:crypto';
import { afterEach, expect } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { DEFAULT_POLICY, type CreditPolicy } from '@lessonkaki/shared';
import { createLesson } from '../src/lessons';
import { sellPackage } from '../src/credits';
import type { Actor } from '../src/db';
import { reconcileStudent } from '../src/reconcile';

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

export async function addStudent(t: TestSchool, studentId: string, firstName = studentId) {
  await db.doc(`schools/${t.schoolId}/students/${studentId}`).set({
    firstName,
    lastName: 'Student',
    status: 'active',
    summary: { sessionsAvailable: 0, sessionsOwed: 0 },
  });
  return studentId;
}

/** Every problem reconcileStudent finds, for every student in the school. */
export async function reconcileSchool(schoolId: string): Promise<string[]> {
  const students = await db.collection(`schools/${schoolId}/students`).get();
  const all = await Promise.all(
    students.docs.map(async (d) => (await reconcileStudent(db, schoolId, d.id)).map((p) => `${d.id}: ${p}`)),
  );
  return all.flat();
}

/**
 * Registers an afterEach that asserts the ledger invariant for every school a test created.
 * Returns `school(policy)`, which makes a fresh school and tracks it.
 */
export function withInvariant() {
  const schools: string[] = [];
  afterEach(async () => {
    const ids = schools.splice(0);
    for (const id of ids) expect(await reconcileSchool(id)).toEqual([]);
  });
  return async (policy: Partial<CreditPolicy> = {}) => {
    const t = await makeSchool(policy);
    schools.push(t.schoolId);
    return t;
  };
}

export function sell(
  t: TestSchool,
  packageId: string,
  at = new Date(),
  key: string = randomUUID(),
  studentId = t.studentId,
) {
  return sellPackage(db, { schoolId: t.schoolId, studentId, packageId, idempotencyKey: key }, owner, at);
}

let minuteOffset = 0;
/** A one-hour lesson; each call is offset so lessons never clash unless a test wants them to. */
export async function lesson(
  t: TestSchool,
  startAt = new Date(Date.now() - DAY + minuteOffset++ * 61 * 60_000),
  studentIds = [t.studentId],
) {
  const { lessonId } = await createLesson(
    db,
    {
      schoolId: t.schoolId,
      teacherId: t.teacherId,
      subjectId: t.subjectId,
      startAt,
      durationMin: 60,
      studentIds,
      isOnline: false,
    },
    owner,
  );
  return lessonId;
}

/** Credit counts only (money fields are checked by the money tests). */
export async function summary(t: TestSchool, studentId = t.studentId) {
  const snap = await db.doc(`schools/${t.schoolId}/students/${studentId}`).get();
  const s = snap.get('summary') as { sessionsAvailable: number; sessionsOwed: number };
  return { sessionsAvailable: s.sessionsAvailable, sessionsOwed: s.sessionsOwed };
}

export async function money(t: TestSchool, studentId = t.studentId) {
  const s = (await db.doc(`schools/${t.schoolId}/students/${studentId}`).get()).get('summary');
  return { outstandingCents: s.outstandingCents ?? 0, moneyCreditCents: s.moneyCreditCents ?? 0 };
}

export async function lot(t: TestSchool, enrolmentId: string) {
  return (await db.doc(`schools/${t.schoolId}/enrolments/${enrolmentId}`).get()).data()!;
}

export async function attendee(t: TestSchool, lessonId: string, studentId = t.studentId) {
  return (await db.doc(`schools/${t.schoolId}/lessons/${lessonId}/attendees/${studentId}`).get()).data()!;
}

export async function lessonDoc(t: TestSchool, lessonId: string) {
  return (await db.doc(`schools/${t.schoolId}/lessons/${lessonId}`).get()).data()!;
}

export async function ledger(t: TestSchool, studentId = t.studentId) {
  const snap = await db.collection(`schools/${t.schoolId}/ledger`).where('studentId', '==', studentId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string });
}

export { Timestamp };
