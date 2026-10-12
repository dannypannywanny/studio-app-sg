// Creates or updates a school from a business profile (functions/scripts/schools/<id>.json), with the
// owner's teacher profile, a subject, Studio + Online locations, and the owner login via setMemberRole.
//
//   # emulator (pnpm emulators running)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
//     pnpm --filter functions exec tsx scripts/setup-school.ts --file scripts/schools/sywh.json \
//     --owner-email you@example.com --teacher-name "Your Name"
//   # production (needs approval; ADC from `gcloud auth application-default login`)
//   pnpm --filter functions exec tsx scripts/setup-school.ts --project class-app-sg --file ... --owner-email ... --teacher-name ...
//
// Re-runnable: config is merged (fields edited in Settings and not in the profile are kept), createdAt is
// only set once, and setMemberRole is idempotent. Packages are not created here (see the migration).
import { readFileSync } from 'node:fs';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type DocumentReference } from 'firebase-admin/firestore';
import { DEFAULT_POLICY } from '@lessonkaki/shared';
import { setMemberRole } from '../src/members';
import { argValue, initTarget } from './target';

const OWNER_TEACHER_ID = 'owner-teacher';

interface Profile {
  schoolId: string;
  name: string;
  legalName: string;
  uen: string;
  paynowName: string;
  email: string;
  address: string;
  timezone: string;
  currency: string;
  hosts: { teach: string; learn: string | null };
  branding: Record<string, unknown>;
  studioAddress: string | null;
}

function required(name: string): string {
  const v = argValue(process.argv, name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

async function main() {
  const target = initTarget();
  const { _note, studioAddress, schoolId, ...config } = JSON.parse(readFileSync(required('file'), 'utf8')) as Profile & {
    _note?: string;
  };
  const ownerEmail = required('owner-email').trim().toLowerCase();
  const teacherName = required('teacher-name').trim();
  if (!/^[0-9]{8,9}[A-Z]$|^[ST][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z]$/.test(config.uen)) throw new Error('UEN format looks wrong');

  const db = getFirestore();
  const school = db.collection('schools').doc(schoolId);
  const ts = FieldValue.serverTimestamp();
  const exists = (await school.get()).exists;

  // Merge, then add only-on-create fields. Gateways stay disabled until HitPay is set up (M4).
  const batch = db.batch();
  batch.set(
    school,
    {
      ...config,
      ...(exists
        ? {}
        : {
            gateways: { hitpay: { enabled: false, mode: 'sandbox' } },
            policy: DEFAULT_POLICY,
            pdpa: { dpoName: null, dpoEmail: null, noticeVersion: null },
            createdAt: ts,
          }),
      updatedAt: ts,
    },
    { merge: true },
  );
  const upsert = async (ref: DocumentReference, data: Record<string, unknown>) => {
    const snap = await ref.get();
    batch.set(ref, { ...data, ...(snap.exists ? {} : { createdAt: ts }), updatedAt: ts }, { merge: true });
  };
  await upsert(school.collection('teachers').doc(OWNER_TEACHER_ID), {
    displayName: teacherName,
    email: ownerEmail,
    subjectIds: ['voice'],
    payRateCents: null,
    active: true,
  });
  await upsert(school.collection('subjects').doc('voice'), {
    name: 'Voice lessons',
    teacherIds: [OWNER_TEACHER_ID],
    defaultDurationMin: 60,
    active: true,
  });
  await upsert(school.collection('locations').doc('studio'), {
    name: 'Studio',
    publicName: 'Studio',
    address: studioAddress,
    isOnline: false,
    active: true,
  });
  await upsert(school.collection('locations').doc('online'), {
    name: 'Online (Zoom)',
    publicName: 'Online',
    address: null,
    isOnline: true,
    active: true,
  });
  await batch.commit();

  const { uid, claims } = await setMemberRole(
    db,
    getAuth(),
    { schoolId, email: ownerEmail, role: 'owner', teacherId: OWNER_TEACHER_ID },
    { uid: 'setup-school', role: 'system' },
  );

  console.log(`${exists ? 'Updated' : 'Created'} school "${schoolId}" in ${target.projectId}.`);
  console.log(`Owner login set (uid ${uid}); claims: ${JSON.stringify(claims)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
