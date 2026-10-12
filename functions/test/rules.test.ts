// Security rules, against the Firestore and Storage emulators. The Admin SDK used by the engine bypasses
// rules; these tests act as signed-in clients with the custom claims setMemberRole issues.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { ref, getBytes, uploadString } from 'firebase/storage';
import { afterAll, beforeAll, describe, it } from 'vitest';

const hostPort = (env: string | undefined, fallback: string) => {
  const [host, port] = (env ?? fallback).split(':');
  return { host: host!, port: Number(port) };
};

let env: RulesTestEnvironment;
const A = `rA_${randomUUID().slice(0, 6)}`;
const B = `rB_${randomUUID().slice(0, 6)}`;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-lessonkaki',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), ...hostPort(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8180') },
    storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8'), ...hostPort(process.env.FIREBASE_STORAGE_EMULATOR_HOST, '127.0.0.1:9198') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const s of [A, B]) {
      await setDoc(doc(db, `schools/${s}`), { name: s, policy: {}, gateways: { hitpay: { enabled: false } } });
      await setDoc(doc(db, `schools/${s}/students/stu1`), { firstName: 'Ada', status: 'active', summary: { sessionsAvailable: 1 } });
      await setDoc(doc(db, `schools/${s}/students/stu2`), { firstName: 'Ben', status: 'active', summary: { sessionsAvailable: 0 } });
      await setDoc(doc(db, `schools/${s}/invoices/inv1`), { studentId: 'stu1', status: 'sent', totalCents: 100 });
      await setDoc(doc(db, `schools/${s}/invoices/inv2`), { studentId: 'stu2', status: 'sent', totalCents: 100 });
      await setDoc(doc(db, `schools/${s}/ledger/e1`), { studentId: 'stu1', delta: 4 });
      await setDoc(doc(db, `schools/${s}/packages/p1`), { name: '4 Sessions', active: true });
      await setDoc(doc(db, `schools/${s}/lessons/l1`), { teacherId: 't1', studentIds: ['stu1'], status: 'scheduled' });
      await setDoc(doc(db, `schools/${s}/lessons/l2`), { teacherId: 't2', studentIds: ['stu2'], status: 'scheduled' });
      await setDoc(doc(db, `schools/${s}/lessons/l1/attendees/stu1`), { schoolId: s, studentId: 'stu1', status: 'booked' });
      await setDoc(doc(db, `schools/${s}/lessons/l2/attendees/stu2`), { schoolId: s, studentId: 'stu2', status: 'booked' });
      await setDoc(doc(db, `schools/${s}/members/owner-${s}`), { role: 'owner' });
      await setDoc(doc(db, `schools/${s}/public/profile`), { name: s });
    }
  });
});

afterAll(async () => {
  await env?.cleanup();
});

const as = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, claims).firestore();
const owner = () => as(`owner-${A}`, { r: { [A]: 'owner' } });
const admin = () => as('admin-a', { r: { [A]: 'admin' } });
const teacher = () => as('teacher-a', { r: { [A]: 'teacher' }, t: { [A]: 't1' } });
const student = () => as('student-a', { r: { [A]: 'student' }, s: { [A]: 'stu1' } });
const anon = () => env.unauthenticatedContext().firestore();

describe('cross-school isolation', () => {
  it('staff of one school cannot read or write another school', async () => {
    await assertSucceeds(getDoc(doc(owner(), `schools/${A}/students/stu1`)));
    await assertFails(getDoc(doc(owner(), `schools/${B}`)));
    await assertFails(getDoc(doc(owner(), `schools/${B}/students/stu1`)));
    await assertFails(getDocs(collection(owner(), `schools/${B}/invoices`)));
    await assertFails(getDocs(collection(owner(), `schools/${B}/ledger`)));
    await assertFails(setDoc(doc(owner(), `schools/${B}/packages/x`), { name: 'x' }));
  });

  it('collection-group attendee reads are limited to staff of that school', async () => {
    await assertSucceeds(getDocs(query(collectionGroup(owner(), 'attendees'), where('schoolId', '==', A))));
    await assertFails(getDocs(query(collectionGroup(owner(), 'attendees'), where('schoolId', '==', B))));
    await assertFails(getDocs(query(collectionGroup(teacher(), 'attendees'), where('schoolId', '==', A))));
    await assertFails(getDocs(collectionGroup(owner(), 'attendees')));
  });

  it('signed-out visitors only see public pages', async () => {
    await assertSucceeds(getDoc(doc(anon(), `schools/${A}/public/profile`)));
    await assertFails(getDoc(doc(anon(), `schools/${A}`)));
    await assertFails(getDoc(doc(anon(), `schools/${A}/packages/p1`)));
    await assertFails(getDoc(doc(anon(), `schools/${A}/students/stu1`)));
  });
});

describe('no client writes to money and credit data', () => {
  const locked = ['ledger', 'moneyLedger', 'enrolments', 'invoices', 'payments', 'creditNotes', 'counters', 'auditLog', 'members', 'idempotency', 'jobs', 'series', 'lessons'];
  for (const name of locked) {
    it(`owner cannot write ${name}`, async () => {
      await assertFails(setDoc(doc(owner(), `schools/${A}/${name}/hack`), { studentId: 'stu1', delta: 99 }));
      await assertFails(addDoc(collection(owner(), `schools/${A}/${name}`), { studentId: 'stu1', delta: 99 }));
    });
  }

  it('nobody updates or deletes existing ledger entries, invoices or attendees', async () => {
    await assertFails(updateDoc(doc(owner(), `schools/${A}/ledger/e1`), { delta: 400 }));
    await assertFails(deleteDoc(doc(owner(), `schools/${A}/ledger/e1`)));
    await assertFails(updateDoc(doc(owner(), `schools/${A}/invoices/inv1`), { status: 'paid' }));
    await assertFails(updateDoc(doc(owner(), `schools/${A}/lessons/l1/attendees/stu1`), { status: 'present' }));
  });

  it('students cannot be created or edited with a balance, or linked to a login by a client', async () => {
    await assertSucceeds(setDoc(doc(admin(), `schools/${A}/students/new1`), { firstName: 'New', status: 'active' }));
    await assertFails(setDoc(doc(admin(), `schools/${A}/students/new2`), { firstName: 'New', summary: { sessionsAvailable: 50 } }));
    await assertSucceeds(updateDoc(doc(admin(), `schools/${A}/students/stu1`), { phone: '+6590000009' }));
    await assertFails(updateDoc(doc(admin(), `schools/${A}/students/stu1`), { 'summary.sessionsAvailable': 50 }));
    await assertFails(updateDoc(doc(admin(), `schools/${A}/students/stu1`), { uid: 'someone' }));
    await assertFails(deleteDoc(doc(owner(), `schools/${A}/students/stu2`)));
  });

  it('only the owner edits school settings, and never the payment gateways', async () => {
    await assertSucceeds(updateDoc(doc(owner(), `schools/${A}`), { name: 'Renamed' }));
    await assertFails(updateDoc(doc(owner(), `schools/${A}`), { 'gateways.hitpay.enabled': true }));
    await assertFails(updateDoc(doc(admin(), `schools/${A}`), { name: 'Admin rename' }));
    await assertSucceeds(setDoc(doc(admin(), `schools/${A}/packages/p2`), { name: 'Trial', active: true }));
  });
});

describe('teacher scoping', () => {
  it('sees own lessons and their attendees, not other teachers lessons, students or money', async () => {
    await assertSucceeds(getDoc(doc(teacher(), `schools/${A}/lessons/l1`)));
    await assertSucceeds(getDocs(query(collection(teacher(), `schools/${A}/lessons`), where('teacherId', '==', 't1'))));
    await assertSucceeds(getDoc(doc(teacher(), `schools/${A}/lessons/l1/attendees/stu1`)));
    await assertFails(getDoc(doc(teacher(), `schools/${A}/lessons/l2`)));
    await assertFails(getDoc(doc(teacher(), `schools/${A}/lessons/l2/attendees/stu2`)));
    await assertFails(getDocs(collection(teacher(), `schools/${A}/lessons`)));
    await assertFails(getDoc(doc(teacher(), `schools/${A}/students/stu1`)));
    await assertFails(getDoc(doc(teacher(), `schools/${A}/invoices/inv1`)));
    await assertFails(setDoc(doc(teacher(), `schools/${A}/packages/p9`), { name: 'x' }));
    await assertSucceeds(getDoc(doc(teacher(), `schools/${A}/packages/p1`)));
  });
});

describe('student scoping', () => {
  it('reads only their own record, invoices, ledger and lessons', async () => {
    await assertSucceeds(getDoc(doc(student(), `schools/${A}/students/stu1`)));
    await assertFails(getDoc(doc(student(), `schools/${A}/students/stu2`)));
    await assertSucceeds(getDoc(doc(student(), `schools/${A}/invoices/inv1`)));
    await assertFails(getDoc(doc(student(), `schools/${A}/invoices/inv2`)));
    await assertSucceeds(getDocs(query(collection(student(), `schools/${A}/invoices`), where('studentId', '==', 'stu1'))));
    await assertFails(getDocs(collection(student(), `schools/${A}/invoices`)));
    await assertSucceeds(getDocs(query(collection(student(), `schools/${A}/ledger`), where('studentId', '==', 'stu1'))));
    await assertSucceeds(getDocs(query(collection(student(), `schools/${A}/lessons`), where('studentIds', 'array-contains', 'stu1'))));
    await assertFails(getDoc(doc(student(), `schools/${A}/lessons/l2`)));
    await assertFails(updateDoc(doc(student(), `schools/${A}/students/stu1`), { firstName: 'Changed' }));
    await assertFails(getDocs(collection(student(), `schools/${A}/members`)));
  });

  it('members can read their own membership only', async () => {
    await assertSucceeds(getDoc(doc(owner(), `schools/${A}/members/owner-${A}`)));
    await assertFails(getDoc(doc(student(), `schools/${A}/members/owner-${A}`)));
  });
});

describe('storage', () => {
  it('invoice PDFs are never readable or writable by clients (signed URLs only)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadString(ref(ctx.storage(), `schools/${A}/invoices/inv1.pdf`), '%PDF-1.7 test');
    });
    await assertFails(getBytes(ref(env.authenticatedContext(`owner-${A}`, { r: { [A]: 'owner' } }).storage(), `schools/${A}/invoices/inv1.pdf`)));
    await assertFails(getBytes(ref(env.authenticatedContext('student-a', { r: { [A]: 'student' }, s: { [A]: 'stu1' } }).storage(), `schools/${A}/invoices/inv1.pdf`)));
    await assertFails(uploadString(ref(env.authenticatedContext(`owner-${A}`, { r: { [A]: 'owner' } }).storage(), `schools/${A}/x.pdf`), 'x'));
  });
});
