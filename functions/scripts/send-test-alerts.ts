// Sends two real alert emails through Resend from a throwaway emulator school: one for a recorded
// payment, one for a cancelled attendee. Emulator only (refuses a real project), made-up student.
//
//   # in one terminal: pnpm emulators   (or any running Firestore emulator)
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 RESEND_API_KEY=re_... \
//     pnpm --filter functions exec tsx scripts/send-test-alerts.ts --to you@example.com
//
// With Resend's test sender (onboarding@resend.dev), --to must be the Resend account's own address.
// --from 'Name <notifications@your-domain>' tries a verified domain instead.
import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_POLICY } from '@lessonkaki/shared';
import { deliverAlert, resendSender } from '../src/alerts';
import { cancelAttendance } from '../src/attendance';
import { sellPackage } from '../src/credits';
import type { Actor } from '../src/db';
import { createLesson } from '../src/lessons';
import { recordPayment } from '../src/money';
import { argValue, initTarget } from './target';

async function main() {
  const target = initTarget();
  if (target.production) throw new Error('This script only runs against the emulator.');
  const key = process.env.RESEND_API_KEY;
  const to = argValue(process.argv, 'to');
  if (!key || !to) throw new Error('Set RESEND_API_KEY and pass --to you@example.com');
  const from = argValue(process.argv, 'from') ?? 'LessonKaki <onboarding@resend.dev>';

  const db = getFirestore();
  const schoolId = `alerttest_${randomUUID().slice(0, 6)}`;
  const school = db.collection('schools').doc(schoolId);
  const owner: Actor = { uid: 'test-owner', role: 'owner' };
  const batch = db.batch();
  batch.set(school, { name: 'Alert Test Studio', timezone: 'Asia/Singapore', currency: 'SGD', policy: DEFAULT_POLICY, alerts: { to: [to] } });
  batch.set(school.collection('teachers').doc('t1'), { displayName: 'Teacher', active: true });
  batch.set(school.collection('subjects').doc('voice'), { name: 'Voice', active: true });
  batch.set(school.collection('packages').doc('p4'), { name: '4 Sessions', sessions: 4, priceCents: 30000, validityDays: 90, active: true });
  batch.set(school.collection('students').doc('s1'), {
    firstName: 'Tess',
    lastName: 'Tester',
    status: 'active',
    summary: { sessionsAvailable: 0, sessionsOwed: 0 },
  });
  await batch.commit();

  const { invoiceId } = await sellPackage(db, { schoolId, studentId: 's1', packageId: 'p4', idempotencyKey: randomUUID() }, owner);
  const { lessonId } = await createLesson(
    db,
    {
      schoolId,
      teacherId: 't1',
      subjectId: 'voice',
      startAt: new Date(Date.now() + 3 * 86_400_000),
      durationMin: 60,
      studentIds: ['s1'],
      isOnline: false,
    },
    owner,
  );
  // Only the two alerts under test: set aside the booking alert createLesson wrote.
  for (const d of (await school.collection('alerts').get()).docs) await d.ref.update({ status: 'skipped', skipReason: 'test script' });

  await recordPayment(db, { schoolId, invoiceId, amountCents: 30000, method: 'paynow', idempotencyKey: randomUUID() }, owner);
  await cancelAttendance(db, { schoolId, lessonId, studentId: 's1' }, { uid: 'test-student', role: 'student', studentId: 's1' });

  const sender = resendSender(key);
  const pending = (await school.collection('alerts').where('status', '==', 'pending').get()).docs;
  for (const d of pending) {
    const outcome = await deliverAlert(db, sender, schoolId, d.id, { defaultFrom: from });
    const after = (await d.ref.get()).data()!;
    const detail = after.providerId ? ` (Resend id ${after.providerId as string})` : after.lastError ? `: ${after.lastError as string}` : '';
    console.log(`${d.get('type') as string}: ${outcome}${detail}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
