// Seeds the local Firebase emulators with a synthetic school. Synthetic data only, never real students.
// Run with the emulators up: `pnpm emulators` in one terminal, then `pnpm seed`.
// Safe to re-run: config docs are overwritten, students are only created if missing.
import { getAuth } from 'firebase-admin/auth';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_POLICY } from '@lessonkaki/shared';
import { setMemberRole } from '../src/members';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-lessonkaki';
if (!projectId.startsWith('demo-')) {
  throw new Error(`Refusing to seed project "${projectId}": the seed only runs against demo-* emulator projects.`);
}

const SCHOOL_ID = 'sywh';
const OWNER_EMAIL = 'owner@lessonkaki.test';
const TEACHER_ID = 'owner-teacher';

async function main() {
  initializeApp({ projectId });
  const db = getFirestore();
  const auth = getAuth();
  const school = db.collection('schools').doc(SCHOOL_ID);
  const ts = FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.set(school, {
    name: 'Sing Your Way Home',
    legalName: 'Demo School Pte. Ltd.',
    // Synthetic UEN (a 2099 entity number, so it can't belong to anyone): lets demo invoices carry a PayNow QR.
    uen: 'T99LL9999Z',
    paynowName: 'Demo School',
    email: 'hello@lessonkaki.test',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
    hosts: { teach: 'localhost:5173', learn: null },
    branding: { logoPath: null, colors: null },
    gateways: { hitpay: { enabled: false, mode: 'sandbox' } },
    policy: DEFAULT_POLICY,
    pdpa: { dpoName: null, dpoEmail: null, noticeVersion: null },
    createdAt: ts,
    updatedAt: ts,
  });
  batch.set(school.collection('teachers').doc(TEACHER_ID), {
    displayName: 'Studio Owner',
    email: OWNER_EMAIL,
    subjectIds: ['voice'],
    payRateCents: null,
    active: true,
    createdAt: ts,
    updatedAt: ts,
  });
  batch.set(school.collection('subjects').doc('voice'), {
    name: 'Voice lessons',
    teacherIds: [TEACHER_ID],
    defaultDurationMin: 60,
    active: true,
    createdAt: ts,
    updatedAt: ts,
  });
  batch.set(school.collection('packages').doc('four-sessions'), {
    name: '4 Sessions',
    subjectId: 'voice',
    kind: 'paid',
    sessions: 4,
    priceCents: 30000,
    validityDays: 30,
    sellsOnline: false,
    oncePerStudent: false,
    active: true,
    createdAt: ts,
    updatedAt: ts,
  });
  await batch.commit();

  const students = [
    { id: 'student-ada', firstName: 'Ada', lastName: 'Testperson', email: 'ada@lessonkaki.test', phone: '+6590000001' },
    { id: 'student-ben', firstName: 'Ben', lastName: 'Example', email: 'ben@lessonkaki.test', phone: '+6590000002' },
  ];
  for (const { id, ...s } of students) {
    const ref = school.collection('students').doc(id);
    if ((await ref.get()).exists) continue;
    await ref.set({
      ...s,
      preferredName: null,
      status: 'active',
      studentCode: null,
      notes: '',
      summary: { sessionsAvailable: 0, sessionsOwed: 0 },
      createdAt: ts,
      updatedAt: ts,
    });
  }

  const { uid, claims } = await setMemberRole(
    db,
    auth,
    { schoolId: SCHOOL_ID, email: OWNER_EMAIL, role: 'owner', teacherId: TEACHER_ID },
    { uid: 'seed', role: 'system' },
  );

  console.log(`Seeded school "${SCHOOL_ID}" in ${projectId}.`);
  console.log(`Owner ${OWNER_EMAIL} (uid ${uid}) claims: ${JSON.stringify(claims)}`);
  console.log('Sign in with pnpm dev:teach (http://localhost:5173).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
