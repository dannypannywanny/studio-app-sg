import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveAlertSettings } from '@lessonkaki/shared';
import {
  MAX_ATTEMPTS,
  SendError,
  deliverAlert,
  renderAlert,
  resendSender,
  type MailSender,
  type OutgoingMail,
} from '../src/alerts';
import { addAttendee, cancelAttendance, cancelLesson, removeAttendee } from '../src/attendance';
import type { Actor } from '../src/db';
import { recordPayment } from '../src/money';
import { createSeries, editLesson } from '../src/series';
import { DAY, db, lesson, owner, sell, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const FROM = 'Test <alerts@example.com>';
const OWNER_EMAIL = 'owner@example.com';

/** Records what would be sent; like Resend, a repeated idempotency key sends nothing new. */
class FakeSender implements MailSender {
  sent: OutgoingMail[] = [];
  failures: SendError[] = [];
  private keys = new Map<string, string>();
  async send(mail: OutgoingMail) {
    const fail = this.failures.shift();
    if (fail) throw fail;
    const known = this.keys.get(mail.idempotencyKey);
    if (known) return { id: known };
    const id = `email_${this.sent.length + 1}`;
    this.keys.set(mail.idempotencyKey, id);
    this.sent.push(mail);
    return { id };
  }
}

async function withAlerts(t: TestSchool, alerts: Record<string, unknown> = { to: [OWNER_EMAIL] }) {
  await db.doc(`schools/${t.schoolId}`).update({ alerts, hosts: { teach: 'teach.example.com', learn: null } });
  return t;
}

async function alertDocs(t: TestSchool) {
  const snap = await db.collection(`schools/${t.schoolId}/alerts`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown> & { id: string });
}

const deliver = (t: TestSchool, sender: MailSender | null, id: string) => deliverAlert(db, sender, t.schoolId, id, { defaultFrom: FROM });

/** Delivers every alert, like the trigger would. */
async function deliverAll(t: TestSchool, sender: MailSender | null) {
  const out: string[] = [];
  for (const a of await alertDocs(t)) out.push(await deliver(t, sender, a.id));
  return out;
}

const student: Actor = { uid: 'student-uid', role: 'student', studentId: 'student1' };
const soon = (days: number) => new Date(Date.now() + days * DAY);

describe('payment recorded', () => {
  it('writes one alert in the payment transaction and sends exactly one email to the owner', async () => {
    const t = await withAlerts(await school());
    const { invoiceId } = await sell(t, t.pkg30);
    const input = { schoolId: t.schoolId, invoiceId, amountCents: 10000, method: 'paynow' as const, idempotencyKey: randomUUID() };
    const { paymentId } = await recordPayment(db, input, owner);
    await recordPayment(db, input, owner); // a retried call: same result, no second alert

    const alerts = await alertDocs(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: `payment_${paymentId}`,
      type: 'payment.recorded',
      category: 'payments',
      status: 'pending',
      actorRole: 'owner',
      data: { invoiceId, amountCents: 10000, pendingCents: 20000, method: 'paynow', studentId: t.studentId },
    });

    const sender = new FakeSender();
    expect(await deliverAll(t, sender)).toEqual(['sent']);
    expect(await deliverAll(t, sender)).toEqual(['noop']); // a duplicate trigger delivery
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toEqual([OWNER_EMAIL]);
    expect(mail.from).toBe(FROM);
    expect(mail.idempotencyKey).toBe(`${t.schoolId}/payment_${paymentId}`);
    expect(mail.subject).toMatch(/^Payment recorded: S?\$100\.00 from Test Student$/);
    expect(mail.text).toMatch(/S?\$200\.00 is still due/);
    expect(mail.text).toContain(`https://teach.example.com/invoices/${invoiceId}`);
    expect((await alertDocs(t))[0]).toMatchObject({ status: 'sent', attempts: 1, providerId: 'email_1', sentTo: 1 });
  });

  it('says when the invoice is paid in full and when extra became money credit', async () => {
    const t = await withAlerts(await school());
    const { invoiceId } = await sell(t, t.pkg30);
    await recordPayment(db, { schoolId: t.schoolId, invoiceId, amountCents: 35000, method: 'bank', idempotencyKey: randomUUID() }, owner);
    const sender = new FakeSender();
    await deliverAll(t, sender);
    expect(sender.sent[0]!.text).toContain('paid in full');
    expect(sender.sent[0]!.text).toMatch(/S?\$50\.00 extra was kept as credit/);
  });
});

describe('cancellations', () => {
  it('cancelling an attendee sends exactly one email; cancelling again sends nothing', async () => {
    const t = await withAlerts(await school());
    const lessonId = await lesson(t, soon(5));
    const before = (await alertDocs(t)).map((a) => a.id);
    const input = { schoolId: t.schoolId, lessonId, studentId: t.studentId };
    await cancelAttendance(db, input, student);
    await cancelAttendance(db, input, student);

    const alerts = (await alertDocs(t)).filter((a) => !before.includes(a.id));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'attendee.cancelled', data: { late: false, byStudent: true, charge: 'none' } });

    const sender = new FakeSender();
    await deliver(t, sender, alerts[0]!.id);
    await deliver(t, sender, alerts[0]!.id);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toEqual([OWNER_EMAIL]);
    expect(sender.sent[0]!.subject).toMatch(/^Cancelled: Test Student, /);
    expect(sender.sent[0]!.text).toContain('Test Student cancelled the lesson');
  });

  it('a late cancel that uses a credit says so; re-booking and cancelling again is a new alert', async () => {
    const t = await withAlerts(await school({ lateCancelReturnsCredit: false }));
    await sell(t, t.pkg30);
    const lessonId = await lesson(t, new Date(Date.now() + 2 * 3_600_000));
    const input = { schoolId: t.schoolId, lessonId, studentId: t.studentId };
    await cancelAttendance(db, input, owner);
    await addAttendee(db, input, owner);
    await cancelAttendance(db, { ...input, mode: 'onTime' }, owner);

    const types = (await alertDocs(t)).map((a) => a.type).sort();
    expect(types).toEqual(['attendee.cancelled', 'attendee.cancelled', 'lesson.booked', 'lesson.booked']);
    const sender = new FakeSender();
    await deliverAll(t, sender);
    const late = sender.sent.find((m) => m.subject.startsWith('Late cancel'))!;
    expect(late.text).toContain('Late cancel: one credit was used.');
    expect(late.text).toContain('was cancelled from the lesson');
    expect(sender.sent.find((m) => m.subject.startsWith('Cancelled:'))!.text).not.toContain('credit was used');
  });

  it('removing a student and cancelling a lesson each alert once', async () => {
    const t = await withAlerts(await school());
    const lessonId = await lesson(t, soon(3));
    await removeAttendee(db, { schoolId: t.schoolId, lessonId, studentId: t.studentId }, owner);
    const other = await lesson(t, soon(4));
    await cancelLesson(db, { schoolId: t.schoolId, lessonId: other, reason: 'Teacher unwell' }, owner);
    await cancelLesson(db, { schoolId: t.schoolId, lessonId: other }, owner);

    const alerts = await alertDocs(t);
    expect(alerts.filter((a) => a.type === 'attendee.removed')).toHaveLength(1);
    expect(alerts.filter((a) => a.type === 'lesson.cancelled')).toHaveLength(1);
    const sender = new FakeSender();
    await deliverAll(t, sender);
    expect(sender.sent.find((m) => m.subject.startsWith('Lesson cancelled'))!.text).toContain('Reason: Teacher unwell');
  });
});

describe('bookings', () => {
  it('a future lesson alerts with the credit position; a lesson entered after the fact does not', async () => {
    const t = await withAlerts(await school());
    await lesson(t, soon(-2));
    expect(await alertDocs(t)).toHaveLength(0);

    await lesson(t, soon(2));
    await sell(t, t.pkg30);
    await lesson(t, soon(3));
    const sender = new FakeSender();
    await deliverAll(t, sender);
    expect(sender.sent).toHaveLength(2);
    // Credits are read at send time, so both emails see the package sold before delivery.
    const texts = sender.sent.map((m) => m.text).join('\n');
    expect(texts).toContain('Test Student: 4 credits left');

    const t2 = await withAlerts(await school());
    await lesson(t2, soon(2));
    const s2 = new FakeSender();
    await deliverAll(t2, s2);
    expect(s2.sent[0]!.text).toContain('Test Student: no credits left, so the lesson will be recorded as owed.');
  });

  it('a weekly series is one alert, not one per lesson; ending it is one more', async () => {
    const t = await withAlerts(await school());
    const { lessonIds } = await createSeries(
      db,
      {
        schoolId: t.schoolId,
        teacherId: t.teacherId,
        subjectId: t.subjectId,
        startDate: soon(2).toISOString().slice(0, 10),
        time: '19:00',
        durationMin: 60,
        byDay: ['MO', 'WE'],
        studentIds: [t.studentId],
        isOnline: false,
      },
      owner,
    );
    expect(lessonIds.length).toBeGreaterThan(10);
    await editLesson(db, { schoolId: t.schoolId, lessonId: lessonIds[0]!, scope: 'all', cancel: { reason: null } }, owner);
    expect((await alertDocs(t)).map((a) => a.type).sort()).toEqual(['series.booked', 'series.cancelled']);
    const sender = new FakeSender();
    await deliverAll(t, sender);
    const booked = sender.sent.find((m) => m.subject === 'Weekly lessons booked: Test Student')!;
    expect(booked.text).toContain('Every Mon, Wed');
    expect(sender.sent.find((m) => m.subject === 'Weekly lessons ended: Test Student')!.text).toContain('taken off the calendar');
  });
});

describe('settings', () => {
  it('a category switched off is skipped and nothing is sent', async () => {
    const t = await withAlerts(await school(), { to: [OWNER_EMAIL], events: { payments: false } });
    const { invoiceId } = await sell(t, t.pkg30);
    await recordPayment(db, { schoolId: t.schoolId, invoiceId, amountCents: 100, method: 'cash', idempotencyKey: randomUUID() }, owner);
    const sender = new FakeSender();
    expect(await deliverAll(t, sender)).toEqual(['skipped']);
    expect(sender.sent).toHaveLength(0);
    expect((await alertDocs(t))[0]).toMatchObject({ status: 'skipped', skipReason: 'turned off in Settings' });
  });

  it('"skip staff actions" keeps what students do and drops what staff do', async () => {
    const t = await withAlerts(await school(), { to: [OWNER_EMAIL], skipStaffActions: true });
    const lessonId = await lesson(t, soon(5));
    await cancelAttendance(db, { schoolId: t.schoolId, lessonId, studentId: t.studentId }, student);
    const sender = new FakeSender();
    expect((await deliverAll(t, sender)).sort()).toEqual(['sent', 'skipped']);
    expect(sender.sent[0]!.subject).toMatch(/^Cancelled/);
  });

  it('defaults: everything on, to the school contact email; no address at all = skipped', async () => {
    expect(resolveAlertSettings(undefined, 'Hello@Example.com')).toEqual({
      to: ['hello@example.com'],
      events: { bookings: true, cancellations: true, payments: true, paymentProblems: true },
      skipStaffActions: false,
    });
    expect(resolveAlertSettings({ to: ['a@x.co', 'nope', 'A@x.co ', 'b@x.co'] }).to).toEqual(['a@x.co', 'b@x.co']);
    expect(resolveAlertSettings({ to: [] }, 'hello@example.com').to).toEqual([]);

    const t = await school(); // no alerts settings and no contact email
    const { invoiceId } = await sell(t, t.pkg30);
    await recordPayment(db, { schoolId: t.schoolId, invoiceId, amountCents: 100, method: 'cash', idempotencyKey: randomUUID() }, owner);
    expect(await deliverAll(t, new FakeSender())).toEqual(['skipped']);
  });

  it("uses the school's own verified sender when it has one", async () => {
    const t = await withAlerts(await school());
    await db.doc(`schools/${t.schoolId}`).update({ 'mail.from': 'Studio <notifications@studio.example>' });
    await lesson(t, soon(1));
    const sender = new FakeSender();
    await deliverAll(t, sender);
    expect(sender.sent[0]!.from).toBe('Studio <notifications@studio.example>');
  });
});

describe('delivery failures', () => {
  async function onePending() {
    const t = await withAlerts(await school());
    await lesson(t, soon(1));
    return { t, id: (await alertDocs(t))[0]!.id };
  }

  it('a transient error throws (so the trigger retries) and the retry sends once', async () => {
    const { t, id } = await onePending();
    const sender = new FakeSender();
    sender.failures.push(new SendError('Resend 500', false));
    await expect(deliver(t, sender, id)).rejects.toThrow('Resend 500');
    expect((await alertDocs(t))[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Resend 500' });
    expect(await deliver(t, sender, id)).toBe('sent');
    expect(sender.sent).toHaveLength(1);
    expect((await alertDocs(t))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('a permanent error, or too many attempts, marks it failed without throwing', async () => {
    const first = await onePending();
    const sender = new FakeSender();
    sender.failures.push(new SendError('Resend 403 domain not verified', true));
    expect(await deliver(first.t, sender, first.id)).toBe('failed');
    expect(await deliver(first.t, sender, first.id)).toBe('noop');
    expect(sender.sent).toHaveLength(0);

    const second = await onePending();
    for (let i = 0; i < MAX_ATTEMPTS; i++) sender.failures.push(new SendError('Resend 503', false));
    for (let i = 1; i < MAX_ATTEMPTS; i++) await expect(deliver(second.t, sender, second.id)).rejects.toThrow();
    expect(await deliver(second.t, sender, second.id)).toBe('failed');
    expect((await alertDocs(second.t))[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
  });

  it('no API key configured: marked failed; the booking itself went through', async () => {
    const { t, id } = await onePending();
    expect(await deliver(t, null, id)).toBe('failed');
    expect((await alertDocs(t))[0]!.lastError).toMatch(/RESEND_API_KEY/);
  });

  it('deliveries racing on one alert still produce one email (Resend idempotency key)', async () => {
    const { t, id } = await onePending();
    const sender = new FakeSender();
    await Promise.all([1, 2, 3].map(() => deliver(t, sender, id)));
    expect(sender.sent).toHaveLength(1);
  });
});

describe('later producers (M4 HitPay, M5 online booking) already render', () => {
  it('failed / abandoned online payments, with a guest name from the booking', async () => {
    const t = await withAlerts(await school());
    await db.doc(`schools/${t.schoolId}/bookings/b1`).set({ guest: { name: 'Gwen <Guest>' }, status: 'held' });
    const base = { provider: 'hitpay', invoiceId: null, invoiceNumber: null, amountCents: 9000, currency: 'SGD', reason: 'Card declined' };
    const config = (await db.doc(`schools/${t.schoolId}`).get()).data()!;
    const failed = await renderAlert(db, t.schoolId, 'payment.failed', { ...base, studentId: t.studentId, bookingId: null }, config);
    expect(failed.subject).toMatch(/^Payment failed: S?\$90\.00 from Test Student$/);
    expect(failed.text).toContain('Reason given: Card declined');
    const abandoned = await renderAlert(db, t.schoolId, 'payment.abandoned', { ...base, studentId: null, bookingId: 'b1' }, config);
    expect(abandoned.subject).toMatch(/^Payment not completed: S?\$90\.00 from Gwen <Guest>$/);
    expect(abandoned.html).toContain('Gwen &lt;Guest&gt;');
    expect(abandoned.html).not.toContain('<Guest>');
  });

  it('a paid online booking and a HitPay payment', async () => {
    const t = await withAlerts(await school());
    const config = (await db.doc(`schools/${t.schoolId}`).get()).data()!;
    const booked = await renderAlert(
      db,
      t.schoolId,
      'lesson.booked',
      {
        lessonId: 'l1',
        studentIds: [t.studentId],
        startAt: new Date('2026-10-14T11:00:00Z'),
        source: 'booking',
        payment: { status: 'paid', amountCents: 9000, currency: 'SGD', invoiceId: 'i1' },
      },
      config,
    );
    expect(booked.subject).toMatch(/^Booked: Test Student, Wed, 14 Oct 2026, 7:00\Wpm$/);
    expect(booked.lines.join('\n')).toMatch(/Test Student: paid S?\$90\.00 online\./);
    expect(booked.lines).toContain('Booked on the online booking page.');
    const paid = await renderAlert(
      db,
      t.schoolId,
      'payment.succeeded',
      {
        paymentId: 'p1',
        provider: 'hitpay',
        invoiceId: 'i1',
        invoiceNumber: 'INV-00001',
        studentId: t.studentId,
        amountCents: 9000,
        currency: 'SGD',
        method: 'card_hitpay',
        pendingCents: 0,
        overpaymentCents: 0,
      },
      config,
    );
    expect(paid.subject).toMatch(/^Payment received: S?\$90\.00 from Test Student$/);
    expect(paid.text).toContain('by card (HitPay) for invoice INV-00001');
  });
});

describe('resendSender', () => {
  const mail: OutgoingMail = { from: FROM, to: [OWNER_EMAIL], subject: 's', text: 't', html: '<p>t</p>', idempotencyKey: 'sch/a1' };

  it('posts to Resend with the API key and the idempotency key', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resendSender('re_test', fetchFn).send(mail)).toEqual({ id: 'abc' });
    const headers = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe('https://api.resend.com/emails');
    expect(headers.Authorization).toBe('Bearer re_test');
    expect(headers['Idempotency-Key']).toBe('sch/a1');
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ from: FROM, to: [OWNER_EMAIL], subject: 's' });
  });

  it('sorts errors into permanent and retryable', async () => {
    const permanent = async (status: number) => {
      const fetchFn = (async () => new Response(JSON.stringify({ name: 'x', message: 'm' }), { status })) as unknown as typeof fetch;
      return resendSender('k', fetchFn)
        .send(mail)
        .catch((e: SendError) => e.permanent);
    };
    expect(await permanent(403)).toBe(true);
    expect(await permanent(422)).toBe(true);
    expect(await permanent(409)).toBe(false);
    expect(await permanent(429)).toBe(false);
    expect(await permanent(500)).toBe(false);
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(resendSender('k', down).send(mail)).rejects.toMatchObject({ permanent: false });
  });
});
