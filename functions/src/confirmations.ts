// Booking confirmations to students (schools/{id}.reminders.confirmations, off until the owner turns it on).
//
// Staff booking someone into a lesson already writes a `lesson.booked` alert (see alerts.ts) for the owner.
// The same alert drives this: each booked student gets one email with the time, teacher and place. What was
// done per student is recorded on the alert doc (`confirmations.<studentId>`), so a retry of the trigger
// never emails anyone twice, and Resend's idempotency key covers a crash between send and record.
// Only staff bookings (source 'admin'): students who book themselves already see the result on the page.
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { formatDateTime, resolveReminders } from '@lessonkaki/shared';
import type { MailSender } from './alerts';
import { ctxOf, render, type SchoolCtx } from './reminders';
import { now, schoolRef } from './db';

export function bookingConfirmationEmail(
  school: SchoolCtx,
  p: { firstName: string; startAt: Date; durationMin: number; teacher: string | null; where: string; trial: boolean; meetingUrl: string | null },
) {
  const when = formatDateTime(p.startAt, school.tz);
  const what = p.trial ? 'trial lesson' : 'lesson';
  return render(
    school,
    `Your ${what} is booked: ${when}`,
    [
      `Hi ${p.firstName},`,
      `Your ${p.durationMin}-minute ${what} is booked for ${when}${p.teacher ? ` with ${p.teacher}` : ''} (${p.where}).`,
      ...(p.meetingUrl ? [`Join online: ${p.meetingUrl}`] : []),
      `If you need to move or cancel it, just reply to this email${school.learn ? ' or manage it on your student page' : ''}.`,
    ],
    school.learn ? { label: 'See my lessons', href: `${school.learn}/` } : null,
  );
}

export type ConfirmOutcome = 'sent' | 'off' | 'noop';

/** Sends the student confirmations for one `lesson.booked` alert. Throws only to ask for a retry. */
export async function deliverStudentConfirmations(
  db: Firestore,
  sender: MailSender | null,
  schoolId: string,
  alertId: string,
  defaultFrom: string,
): Promise<ConfirmOutcome> {
  const school = schoolRef(db, schoolId);
  const alertRef = school.collection('alerts').doc(alertId);
  const [alertSnap, schoolSnap] = await Promise.all([alertRef.get(), school.get()]);
  if (!alertSnap.exists || alertSnap.get('type') !== 'lesson.booked' || alertSnap.get('data.source') !== 'admin') return 'noop';
  if (!resolveReminders(schoolSnap.get('reminders')).confirmations) return 'off';
  if (!sender) {
    console.warn(`confirmations ${schoolId}/${alertId}: no RESEND_API_KEY`);
    return 'noop';
  }

  const ctx = ctxOf(schoolSnap, defaultFrom);
  const lessonId = alertSnap.get('data.lessonId') as string;
  const lesson = await school.collection('lessons').doc(lessonId).get();
  if (!lesson.exists || lesson.get('status') !== 'scheduled') return 'noop';
  const startAt = toDate(lesson.get('startAt'));
  if (startAt <= new Date()) return 'noop';

  const done = (alertSnap.get('confirmations') ?? {}) as Record<string, string>;
  const trialIds = (lesson.get('trialStudentIds') as string[] | undefined) ?? [];
  const studentIds = (alertSnap.get('data.studentIds') as string[]).filter((id) => !done[id]);
  if (!studentIds.length) return 'noop';

  const [teacher, place] = await Promise.all([
    school.collection('teachers').doc(lesson.get('teacherId') as string).get(),
    lesson.get('locationId') ? school.collection('locations').doc(lesson.get('locationId') as string).get() : Promise.resolve(null),
  ]);
  const where = lesson.get('isOnline')
    ? 'online'
    : ((place?.get('address') as string | undefined) ?? (place?.get('name') as string | undefined) ?? 'at the studio');
  const teacherName = (teacher.get('publicName') as string) || ((teacher.get('displayName') as string | undefined)?.split(' ')[0] ?? null);

  let sent = 0;
  for (const id of studentIds) {
    const [student, attendee] = await Promise.all([
      school.collection('students').doc(id).get(),
      lesson.ref.collection('attendees').doc(id).get(),
    ]);
    const email = (student.get('email') as string | undefined)?.trim();
    const record = (v: string) => alertRef.update({ [`confirmations.${id}`]: v, updatedAt: now() });
    if (attendee.get('status') !== 'booked') {
      await record('skipped: no longer booked');
      continue;
    }
    if (!email || student.get('status') === 'archived') {
      await record('skipped: no email');
      continue;
    }
    const mail = bookingConfirmationEmail(ctx, {
      firstName: (student.get('preferredName') as string) || (student.get('firstName') as string) || 'there',
      startAt,
      durationMin: lesson.get('durationMin') as number,
      teacher: teacherName,
      where,
      trial: trialIds.includes(id),
      meetingUrl: lesson.get('isOnline') ? ((lesson.get('meetingUrl') as string | null) ?? null) : null,
    });
    await sender.send({ from: ctx.from, to: [email], ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}), ...mail, idempotencyKey: `confirm-lesson/${schoolId}/${alertId}/${id}` });
    await record('sent');
    sent++;
  }
  return sent ? 'sent' : 'noop';
}

const toDate = (v: unknown): Date => (v instanceof Timestamp ? v.toDate() : new Date(v as string));
