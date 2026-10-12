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
    // School #1's theme, from replica/brand-tokens.md (singyourwayhome.sg). tokens.css stays the default.
    branding: {
      colors: {
        primary: '#6300E2',
        primaryHover: '#8E43F0',
        onPrimary: '#FFFFFF',
        accent: '#8693E1',
        text: '#150E1F',
        muted: '#584D66',
        background: '#F3F1F6',
        surface: '#FFFFFF',
      },
      fonts: { display: 'Playfair Display', body: 'Roboto' },
      // TODO: replace with a small optimised copy hosted with the app (the source PNG is 1.4 MB).
      logoUrl: 'https://singyourwayhome.sg/wp-content/uploads/2025/09/SYWH-Logo-Transparent-BG.png',
      buttonRadius: 28,
      siteUrl: 'https://singyourwayhome.sg',
    },
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
  batch.set(school.collection('locations').doc('studio'), {
    name: 'Studio',
    publicName: 'Studio',
    address: null,
    isOnline: false,
    active: true,
    createdAt: ts,
    updatedAt: ts,
  });
  batch.set(school.collection('locations').doc('online'), {
    name: 'Online (Zoom)',
    publicName: 'Online',
    address: null,
    isOnline: true,
    active: true,
    createdAt: ts,
    updatedAt: ts,
  });
  batch.set(school.collection('packages').doc('trial'), {
    name: 'Trial lesson',
    subjectId: 'voice',
    kind: 'trial',
    sessions: 1,
    priceCents: 5000,
    validityDays: 30,
    sellsOnline: true,
    oncePerStudent: true,
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

  // Learn site: host lookup, public profile, synthetic booking hours, and Ada as a student login.
  const learn = db.batch();
  learn.set(db.collection('publicSchools').doc('localhost'), { schoolId: SCHOOL_ID, site: 'learn', updatedAt: ts });
  learn.set(school.collection('public').doc('profile'), {
    name: 'Sing Your Way Home',
    logoUrl: '/schools/sywh/logo.webp',
    siteUrl: 'https://singyourwayhome.sg',
    contactEmail: 'hello@lessonkaki.test',
    whatsapp: null,
    teachers: { [TEACHER_ID]: { name: 'Studio Owner' } },
    updatedAt: ts,
  });
  const weekday = { start: '10:00', end: '21:00', inPerson: true, online: true, locationId: 'studio' };
  learn.set(school.collection('availability').doc(TEACHER_ID), {
    weekly: [
      ...(['MO', 'TU', 'WE', 'TH', 'FR'] as const).map((day) => ({ day, ...weekday })),
      { day: 'SA', start: '10:00', end: '14:00', inPerson: false, online: true, locationId: null },
    ],
    exceptions: [],
    lessonMin: 45,
    stepMin: 30,
    bufferMin: 15,
    minNoticeHours: 12,
    horizonDays: 28,
    subjectId: 'voice',
    updatedAt: ts,
  });
  await learn.commit();
  await setMemberRole(db, auth, { schoolId: SCHOOL_ID, email: 'ada@lessonkaki.test', role: 'student', studentId: 'student-ada' }, { uid: 'seed', role: 'system' });

  console.log(`Seeded school "${SCHOOL_ID}" in ${projectId}.`);
  console.log(`Owner ${OWNER_EMAIL} (uid ${uid}) claims: ${JSON.stringify(claims)}`);
  console.log('Sign in with pnpm dev:teach (http://localhost:5173).');
  console.log('Student ada@lessonkaki.test can sign in with pnpm dev:learn (http://localhost:5174).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
