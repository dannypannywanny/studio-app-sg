import { describe, expect, it } from 'vitest';
import type { MailSender, OutgoingMail } from '../src/alerts';
import { deliverStudentConfirmations } from '../src/confirmations';
import { db, lesson, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const HOUR = 3_600_000;

function fakeSender() {
  const sent: OutgoingMail[] = [];
  const sender: MailSender = { send: async (m) => (sent.push(m), { id: String(sent.length) }) };
  return { sent, sender };
}

async function setup(reminders: Record<string, unknown>) {
  const t = await school();
  await db.doc(`schools/${t.schoolId}`).update({ reminders, name: 'Test Studio', email: 'hello@example.test', 'hosts.learn': 'learn.example.test' });
  await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ email: 'ada@example.test', firstName: 'Ada' });
  return t;
}

async function bookedAlertId(t: TestSchool, lessonId: string) {
  const snap = await db.collection(`schools/${t.schoolId}/alerts`).where('type', '==', 'lesson.booked').get();
  return snap.docs.find((d) => d.get('data.lessonId') === lessonId)!.id;
}

describe('booking confirmations to students', () => {
  it('emails the booked student once, with time, place and reply-to', async () => {
    const t = await setup({ confirmations: true });
    const lessonId = await lesson(t, new Date(Date.now() + 30 * HOUR));
    const alertId = await bookedAlertId(t, lessonId);
    const { sent, sender } = fakeSender();
    expect(await deliverStudentConfirmations(db, sender, t.schoolId, alertId, 'x@test')).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['ada@example.test'], replyTo: 'hello@example.test' });
    expect(sent[0]!.subject).toContain('Your lesson is booked');
    expect(sent[0]!.text).toContain('Hi Ada');
    expect(sent[0]!.text).toContain('https://learn.example.test/');
    // A retry of the trigger sends nothing more.
    expect(await deliverStudentConfirmations(db, sender, t.schoolId, alertId, 'x@test')).toBe('noop');
    expect(sent).toHaveLength(1);
    expect((await db.doc(`schools/${t.schoolId}/alerts/${alertId}`).get()).get('confirmations')).toEqual({ [t.studentId]: 'sent' });
  });

  it('says "trial lesson" for a lead booked on a trial', async () => {
    const t = await setup({ confirmations: true });
    const lessonId = await lesson(t, new Date(Date.now() + 30 * HOUR));
    await db.doc(`schools/${t.schoolId}/lessons/${lessonId}`).update({ trialStudentIds: [t.studentId] });
    const { sent, sender } = fakeSender();
    await deliverStudentConfirmations(db, sender, t.schoolId, await bookedAlertId(t, lessonId), 'x@test');
    expect(sent[0]!.subject).toContain('Your trial lesson is booked');
  });

  it('sends nothing when the school has confirmations off', async () => {
    const t = await setup({ lessons: true });
    const lessonId = await lesson(t, new Date(Date.now() + 30 * HOUR));
    const { sent, sender } = fakeSender();
    expect(await deliverStudentConfirmations(db, sender, t.schoolId, await bookedAlertId(t, lessonId), 'x@test')).toBe('off');
    expect(sent).toHaveLength(0);
  });

  it('skips (and records) a student with no email', async () => {
    const t = await setup({ confirmations: true });
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ email: '' });
    const lessonId = await lesson(t, new Date(Date.now() + 30 * HOUR));
    const alertId = await bookedAlertId(t, lessonId);
    const { sent, sender } = fakeSender();
    await deliverStudentConfirmations(db, sender, t.schoolId, alertId, 'x@test');
    expect(sent).toHaveLength(0);
    expect((await db.doc(`schools/${t.schoolId}/alerts/${alertId}`).get()).get('confirmations')).toEqual({ [t.studentId]: 'skipped: no email' });
  });
});
