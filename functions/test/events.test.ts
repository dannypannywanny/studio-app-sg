import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildEventOptions, wallClockToUtc } from '@lessonkaki/shared';
import { getAvailability } from '../src/booking';
import { handleHitPayWebhook, type HitPayClient, type PaymentRequest } from '../src/checkout';
import type { MailSender, OutgoingMail } from '../src/alerts';
import { eventOrderStatus, renderConfirmation, startEventCheckout, type StartEventCheckoutInput } from '../src/events';
import { db, money, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const SALT = 'test-salt';
const TZ = 'Asia/Singapore';
const sg = (date: string, time: string) => wallClockToUtc(date, time, TZ);
const EARLY = sg('2026-11-10', '12:00');
const LATE = sg('2026-11-20', '12:00');

class FakeHitPay implements HitPayClient {
  requests: PaymentRequest[] = [];
  async createPaymentRequest(r: PaymentRequest) {
    this.requests.push(r);
    return { id: `req-${this.requests.length}`, url: `https://hitpay.example/checkout/${this.requests.length}` };
  }
}

class FakeMail implements MailSender {
  sent: OutgoingMail[] = [];
  async send(m: OutgoingMail) {
    this.sent.push(m);
    return { id: `mail-${this.sent.length}` };
  }
}

/** Two classes on one afternoon, each S$88 (S$68 early bird), both for S$148 (S$118). */
async function setup(capacity: number | null = 3) {
  const t = await school();
  const host = `learn-${t.schoolId.replace(/_/g, '-')}.example.test`;
  await db.doc(`publicSchools/${host}`).set({ schoolId: t.schoolId, site: 'learn' });
  const session = (key: string, title: string, from: string, to: string) => ({
    key,
    title,
    startAt: Timestamp.fromDate(sg('2026-11-28', from)),
    endAt: Timestamp.fromDate(sg('2026-11-28', to)),
    capacity,
  });
  await db.doc(`schools/${t.schoolId}/events/masterclass`).set({
    title: 'Masterclass afternoon',
    startAt: Timestamp.fromDate(sg('2026-11-28', '15:00')),
    endAt: Timestamp.fromDate(sg('2026-11-28', '17:30')),
    timeZone: TZ,
    venue: null,
    maxPerOrder: 4,
    sessions: [session('fundamentals', 'The Fundamentals of Vocal Technique', '15:00', '16:00'), session('mandopop', 'Mando Pop to English Pop', '16:30', '17:30')],
    options: buildEventOptions(
      [
        { key: 'fundamentals', title: 'The Fundamentals of Vocal Technique', priceCents: 8800, earlyCents: 6800 },
        { key: 'mandopop', title: 'Mando Pop to English Pop', priceCents: 8800, earlyCents: 6800 },
      ],
      { label: 'Both classes', priceCents: 14800, earlyCents: 11800 },
      '2026-11-14',
    ),
    currency: 'SGD',
    teacherIds: [t.teacherId],
    published: true,
    status: 'scheduled',
    soldQty: 0,
  });
  return { t, host };
}

const buyer = (host: string, over: Partial<StartEventCheckoutInput> = {}): StartEventCheckoutInput => ({
  eventId: 'masterclass',
  optionKey: 'mandopop',
  qty: 2,
  firstName: 'Ada',
  lastName: 'Lim',
  email: 'Ada@Example.test',
  phone: '9123 4567',
  consent: true,
  marketing: false,
  host,
  ...over,
});

const body = (o: unknown) => Buffer.from(JSON.stringify(o));
const sign = (b: Buffer) => createHmac('sha256', SALT).update(b).digest('hex');
const paid = (t: TestSchool, checkoutId: string, amount: string, req = 'req-1') =>
  body({ id: req, status: 'completed', amount, currency: 'SGD', reference_number: `${t.schoolId}.${checkoutId}`, payments: [{ id: `pay-${req}`, status: 'succeeded' }] });
const keys = (t: TestSchool) => ({ [t.schoolId]: { apiKey: 'k', salt: SALT } });

describe('startEventCheckout', () => {
  it('charges the early bird until its last day, then the standard price, and returns to the event page', async () => {
    const { t, host } = await setup();
    const client = new FakeHitPay();
    const early = await startEventCheckout(db, client, buyer(host), EARLY);
    expect(client.requests[0]).toMatchObject({ amount: '136.00', email: 'ada@example.test', redirectUrl: `https://${host}/events/masterclass?order=${early.checkoutId}` });
    await startEventCheckout(db, client, buyer(host, { qty: 1 }), LATE);
    expect(client.requests[1]!.amount).toBe('88.00');
    const doc = (await db.doc(`schools/${t.schoolId}/checkouts/${early.checkoutId}`).get()).data()!;
    expect(doc).toMatchObject({ kind: 'event', status: 'pending', qty: 2, unitCents: 6800, amountCents: 13600, buyer: { phone: '+6591234567' } });
  });

  it('charges the bundle price for both classes', async () => {
    const { host } = await setup();
    const client = new FakeHitPay();
    await startEventCheckout(db, client, buyer(host, { optionKey: 'all', qty: 1 }), EARLY);
    expect(client.requests[0]!.amount).toBe('118.00');
    await expect(startEventCheckout(db, client, buyer(host, { optionKey: 'nope' }), EARLY)).rejects.toThrow(/Pick which ticket/);
  });

  it('holds seats per class while people pay; a bundle takes a seat in each', async () => {
    const { t, host } = await setup(3);
    const client = new FakeHitPay();
    const first = await startEventCheckout(db, client, buyer(host, { optionKey: 'all' }), EARLY);
    await expect(startEventCheckout(db, client, buyer(host, { optionKey: 'fundamentals' }), EARLY)).rejects.toThrow(/Only 1 seat is left/);
    await expect(startEventCheckout(db, client, buyer(host), EARLY)).rejects.toThrow(/Only 1 seat is left/);
    // The hold runs out: the seats are free again.
    await db.doc(`schools/${t.schoolId}/checkouts/${first.checkoutId}`).update({ holdUntil: Timestamp.fromDate(new Date(EARLY.getTime() - 1)) });
    await expect(startEventCheckout(db, client, buyer(host, { qty: 3 }), EARLY)).resolves.toBeTruthy();
    await expect(startEventCheckout(db, client, buyer(host, { qty: 1 }), EARLY)).rejects.toThrow(/Mando Pop to English Pop is sold out/);
    // The other class still has room.
    await expect(startEventCheckout(db, client, buyer(host, { optionKey: 'fundamentals', qty: 3 }), EARLY)).resolves.toBeTruthy();
  });

  it('refuses too many tickets, unpublished events, past events, and missing consent', async () => {
    const { t, host } = await setup(null);
    const client = new FakeHitPay();
    await expect(startEventCheckout(db, client, buyer(host, { qty: 5 }), EARLY)).rejects.toThrow(/1 to 4 tickets/);
    await expect(startEventCheckout(db, client, buyer(host, { consent: false }), EARLY)).rejects.toThrow(/privacy notice/);
    await expect(startEventCheckout(db, client, buyer(host, { optionKey: 'fundamentals' }), sg('2026-11-28', '15:00'))).rejects.toThrow(/closed/);
    // The later class still sells between the two.
    await expect(startEventCheckout(db, client, buyer(host), sg('2026-11-28', '16:10'))).resolves.toBeTruthy();
    await expect(startEventCheckout(db, null, buyer(host), EARLY)).rejects.toThrow(/not set up/);
    await db.doc(`schools/${t.schoolId}/events/masterclass`).update({ published: false });
    await expect(startEventCheckout(db, client, buyer(host), EARLY)).rejects.toThrow(/not found/);
  });
});

describe('paying for tickets', () => {
  it('makes the buyer a lead, raises a paid invoice, counts the seats and emails a confirmation, once', async () => {
    const { t, host } = await setup();
    const { checkoutId } = await startEventCheckout(db, new FakeHitPay(), buyer(host), EARLY);
    const mail = new FakeMail();
    const b = paid(t, checkoutId, '136.00');
    expect(await handleHitPayWebhook(db, keys(t), b, sign(b), EARLY, { sender: mail, defaultFrom: 'x@example.test' })).toBe('paid');
    expect(await handleHitPayWebhook(db, keys(t), b, sign(b), EARLY, { sender: mail, defaultFrom: 'x@example.test' })).toBe('duplicate');

    const order = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    expect(order.status).toBe('paid');
    const lead = (await db.doc(`schools/${t.schoolId}/students/${order.studentId}`).get()).data()!;
    expect(lead).toMatchObject({ status: 'lead', email: 'ada@example.test', signupSource: 'event', referralSource: 'Masterclass afternoon' });
    expect(await money(t, order.studentId)).toEqual({ outstandingCents: 0, moneyCreditCents: 0 });
    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${order.invoiceId}`).get()).data()!;
    expect(inv).toMatchObject({ status: 'paid', totalCents: 13600, lines: [{ qty: 2, unitCents: 6800 }] });
    const ev = (await db.doc(`schools/${t.schoolId}/events/masterclass`).get()).data()!;
    expect(ev.soldBySession).toEqual({ mandopop: 2 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: ['ada@example.test'], subject: "You're in: Mando Pop to English Pop" });
    expect(mail.sent[0]!.text).toMatch(/Saturday,? 28 November 2026, 4:30 pm to 5:30 pm/);
    expect(await eventOrderStatus(db, { host, eventId: 'masterclass', orderId: checkoutId })).toEqual({ status: 'paid', qty: 2, optionLabel: 'Mando Pop to English Pop', email: 'ad***@example.test' });
  });

  it('uses the record already on file for that email', async () => {
    const { t, host } = await setup();
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ email: 'ada@example.test', summary: { sessionsAvailable: 0, sessionsOwed: 0, outstandingCents: 0, moneyCreditCents: 0 } });
    const { checkoutId } = await startEventCheckout(db, new FakeHitPay(), buyer(host, { qty: 1 }), EARLY);
    const b = paid(t, checkoutId, '68.00');
    expect(await handleHitPayWebhook(db, keys(t), b, sign(b), EARLY)).toBe('paid');
    const order = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    expect(order.studentId).toBe(t.studentId);
    expect((await db.collection(`schools/${t.schoolId}/students`).get()).size).toBe(1);
  });

  it('a signed-in student buys with the details on their record, and the tickets go on their account', async () => {
    const { t, host } = await setup();
    const student = db.doc(`schools/${t.schoolId}/students/${t.studentId}`);
    await student.update({ firstName: 'Ben', lastName: 'Tan', preferredName: null, email: 'ben@example.test', phone: '+6591112222', summary: { sessionsAvailable: 0, sessionsOwed: 0, outstandingCents: 0, moneyCreditCents: 0 } });
    // Another record shares the guest email the page might still hold: it must not get the order.
    await db.collection(`schools/${t.schoolId}/students`).add({ firstName: 'Ada', email: 'ada@example.test', status: 'active' });
    const client = new FakeHitPay();
    const asStudent = buyer(host, { firstName: '', lastName: '', email: '', phone: '', consent: false, qty: 1, studentId: t.studentId });
    const { checkoutId } = await startEventCheckout(db, client, asStudent, EARLY);
    expect(client.requests[0]).toMatchObject({ email: 'ben@example.test', name: 'Ben Tan' });
    const pending = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    expect(pending).toMatchObject({ studentId: t.studentId, createdBy: 'student', consentAt: null, buyer: { email: 'ben@example.test', phone: '+6591112222' } });

    const b = paid(t, checkoutId, '68.00');
    expect(await handleHitPayWebhook(db, keys(t), b, sign(b), EARLY)).toBe('paid');
    const order = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    expect(order.studentId).toBe(t.studentId);
    const invoice = (await db.doc(`schools/${t.schoolId}/invoices/${order.invoiceId}`).get()).data()!;
    expect(invoice).toMatchObject({ studentId: t.studentId, status: 'paid' });
    expect(await money(t, t.studentId)).toEqual({ outstandingCents: 0, moneyCreditCents: 0 });
  });

  it('a signed-in student without a phone on file gives one; an archived student cannot buy as a student', async () => {
    const { t, host } = await setup();
    const student = db.doc(`schools/${t.schoolId}/students/${t.studentId}`);
    await student.update({ email: 'ben@example.test', phone: null });
    const asStudent = (phone: string) => buyer(host, { firstName: '', lastName: '', email: '', phone, consent: false, qty: 1, studentId: t.studentId });
    await expect(startEventCheckout(db, new FakeHitPay(), asStudent(''), EARLY)).rejects.toThrow(/phone number/);
    const { checkoutId } = await startEventCheckout(db, new FakeHitPay(), asStudent('9123 4567'), EARLY);
    expect((await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).get('buyer.phone')).toBe('+6591234567');
    await student.update({ status: 'archived' });
    await expect(startEventCheckout(db, new FakeHitPay(), asStudent('9123 4567'), EARLY)).rejects.toThrow(/not active/);
  });
});

describe('booking around events', () => {
  it("takes the host's time during the event", async () => {
    const { t } = await setup();
    await db.doc(`schools/${t.schoolId}/availability/${t.teacherId}`).set({
      weekly: [{ day: 'SA', start: '13:00', end: '19:00', inPerson: true, online: true }],
      minNoticeHours: 0,
      horizonDays: 28,
      lessonMin: 60,
      stepMin: 60,
      subjectId: t.subjectId,
    });
    const avail = await getAvailability(db, { schoolId: t.schoolId }, { uid: 'o', role: 'owner' }, EARLY);
    const start = sg('2026-11-28', '15:00').getTime();
    const end = sg('2026-11-28', '17:00').getTime();
    const onDay = avail.slots.map((s) => new Date(s.startAt).getTime()).filter((ms) => ms >= sg('2026-11-28', '00:00').getTime() && ms < sg('2026-11-29', '00:00').getTime());
    expect(onDay.length).toBeGreaterThan(0);
    expect(onDay.filter((ms) => ms < end && ms + 3_600_000 > start)).toEqual([]);
  });
});

describe('renderConfirmation', () => {
  it('lists each class of a bundle with its time', () => {
    const mail = renderConfirmation({
      schoolName: 'Studio',
      firstName: 'Ada',
      title: 'Masterclass afternoon',
      sessions: [
        { title: 'Fundamentals', start: sg('2026-11-28', '15:00'), end: sg('2026-11-28', '16:00') },
        { title: 'Mando Pop', start: sg('2026-11-28', '16:30'), end: sg('2026-11-28', '17:30') },
      ],
      timeZone: TZ,
      venue: 'Studio A',
      qty: 1,
      amountCents: 11800,
      currency: 'SGD',
      contactEmail: null,
    });
    expect(mail.subject).toBe("You're in: Masterclass afternoon");
    expect(mail.text).toContain('Fundamentals: 3:00 pm to 4:00 pm');
    expect(mail.text).toContain('Mando Pop: 4:30 pm to 5:30 pm');
  });

  it('says the venue is to be confirmed until it is set', () => {
    const mail = renderConfirmation({
      schoolName: 'Studio',
      firstName: 'Ada',
      title: 'Masterclass',
      sessions: [{ title: 'Masterclass', start: sg('2026-11-28', '15:00'), end: sg('2026-11-28', '17:00') }],
      timeZone: TZ,
      venue: null,
      qty: 1,
      amountCents: 6800,
      currency: 'SGD',
      contactEmail: null,
    });
    expect(mail.text).toContain('Where: To be confirmed');
    expect(mail.text).toMatch(/Saturday,? 28 November 2026, 3:00 pm to 5:00 pm/);
  });
});
