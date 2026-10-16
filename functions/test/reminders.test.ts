import { describe, expect, it } from 'vitest';
import type { MailSender, OutgoingMail } from '../src/alerts';
import { runLessonReminders, runPaymentReminders } from '../src/reminders';
import { DAY, db, lesson, sell, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const HOUR = 3_600_000;

function fakeSender() {
  const sent: OutgoingMail[] = [];
  const sender: MailSender = { send: async (m) => (sent.push(m), { id: String(sent.length) }) };
  return { sent, sender };
}

async function setup(reminders: Record<string, unknown>) {
  const t = await school();
  await db.doc(`schools/${t.schoolId}`).update({ reminders, name: 'Test Studio', 'hosts.learn': 'learn.example.test' });
  await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ email: 'ada@example.test', firstName: 'Ada' });
  return t;
}

// Only this test's school: other tests' schools are created without reminders, so they're skipped anyway.
const mine = (t: TestSchool, sent: OutgoingMail[]) => sent.filter((m) => m.idempotencyKey.includes(t.schoolId));

describe('lesson reminders', () => {
  it('emails each booked student once inside the window', async () => {
    const t = await setup({ lessons: true, lessonHoursBefore: 24 });
    const now = new Date();
    await lesson(t, new Date(now.getTime() + 20 * HOUR)); // inside 24h
    await lesson(t, new Date(now.getTime() + 30 * HOUR)); // outside
    const { sent, sender } = fakeSender();
    await runLessonReminders(db, sender, 'x@test', now);
    expect(mine(t, sent)).toHaveLength(1);
    expect(mine(t, sent)[0]).toMatchObject({ to: ['ada@example.test'] });
    expect(mine(t, sent)[0]!.text).toContain('Hi Ada');
    expect(mine(t, sent)[0]!.text).toContain('https://learn.example.test/');
    await runLessonReminders(db, sender, 'x@test', now);
    expect(mine(t, sent)).toHaveLength(1); // not again
  });

  it('sends nothing when the school has reminders off', async () => {
    const t = await setup({ lessons: false });
    await lesson(t, new Date(Date.now() + 2 * HOUR));
    const { sent, sender } = fakeSender();
    await runLessonReminders(db, sender, 'x@test');
    expect(mine(t, sent)).toHaveLength(0);
  });
});

describe('payment reminders', () => {
  it('one due-soon email, then overdue every N days up to the max', async () => {
    const t = await setup({ payments: true, dueSoonDays: 3, overdueEveryDays: 7, overdueMax: 2 });
    const sale = await sell(t, t.pkg30); // due in 7 days
    const inv = db.doc(`schools/${t.schoolId}/invoices/${sale.invoiceId}`);
    const due = ((await inv.get()).get('dueDate')).toDate().getTime();
    const { sent, sender } = fakeSender();
    const run = (ms: number) => runPaymentReminders(db, sender, 'x@test', new Date(ms));
    await run(due - 5 * DAY); // too early
    expect(mine(t, sent)).toHaveLength(0);
    await run(due - 2 * DAY);
    await run(due - DAY);
    expect(mine(t, sent).map((m) => m.subject)).toEqual([expect.stringContaining('is due on')]);
    await run(due + 2 * DAY);
    await run(due + 4 * DAY); // too soon for the next
    await run(due + 9 * DAY);
    await run(due + 16 * DAY); // max reached
    const subjects = mine(t, sent).map((m) => m.subject);
    expect(subjects.filter((s) => s.includes('overdue'))).toHaveLength(2);
    expect(mine(t, sent).at(-1)!.text).toContain(`https://learn.example.test/payments/${sale.invoiceId}`);
  });
});
