import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { wallClockToUtc } from '@lessonkaki/shared';
import { bookLesson, getAvailability } from '../src/booking';
import { handleHitPayWebhook, startCheckout, validSignature, type HitPayClient, type PaymentRequest } from '../src/checkout';
import type { Actor } from '../src/db';
import { db, sell, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const SALT = 'test-salt';
const sg = (date: string, time: string) => wallClockToUtc(date, time, 'Asia/Singapore');
const NOW = sg('2027-01-03', '09:00');

class FakeHitPay implements HitPayClient {
  requests: PaymentRequest[] = [];
  async createPaymentRequest(r: PaymentRequest) {
    this.requests.push(r);
    return { id: `req-${this.requests.length}`, url: `https://hitpay.example/checkout/${this.requests.length}` };
  }
}

async function setup(creditRequired?: 'newStudents' | 'all') {
  const t = await school();
  const host = `learn-${t.schoolId.replace(/_/g, '-')}.example.test`;
  await db.doc(`publicSchools/${host}`).set({ schoolId: t.schoolId, site: 'learn' });
  await db.doc(`schools/${t.schoolId}/packages/${t.pkg30}`).update({ sellsOnline: true });
  await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ email: 'stu@example.test' });
  await db.doc(`schools/${t.schoolId}/availability/${t.teacherId}`).set({
    weekly: [{ day: 'MO', start: '10:00', end: '12:00', inPerson: true, online: true }],
    minNoticeHours: 0,
    horizonDays: 14,
    subjectId: t.subjectId,
  });
  if (creditRequired) await db.doc(`schools/${t.schoolId}`).update({ booking: { creditRequired } });
  return { t, host };
}

const student = (t: TestSchool): Actor => ({ uid: 'stu-uid', role: 'student', studentId: t.studentId });
const body = (o: unknown) => Buffer.from(JSON.stringify(o));
const sign = (b: Buffer, salt = SALT) => createHmac('sha256', salt).update(b).digest('hex');

async function checkoutDone(t: TestSchool, host: string) {
  const client = new FakeHitPay();
  const { checkoutId, url } = await startCheckout(db, client, { schoolId: t.schoolId, packageId: t.pkg30, host }, student(t));
  return { checkoutId, url, client };
}

const completed = (t: TestSchool, checkoutId: string, amount = '300.00') =>
  body({ id: 'req-1', status: 'completed', amount, currency: 'SGD', reference_number: `${t.schoolId}.${checkoutId}`, payments: [{ id: 'pay-1', status: 'succeeded' }] });

describe('startCheckout', () => {
  it('creates a pending checkout and a HitPay request that returns to the booking page', async () => {
    const { t, host } = await setup();
    const { checkoutId, url, client } = await checkoutDone(t, host);
    expect(url).toBe('https://hitpay.example/checkout/1');
    expect(client.requests[0]).toMatchObject({
      amount: '300.00',
      currency: 'SGD',
      email: 'stu@example.test',
      referenceNumber: `${t.schoolId}.${checkoutId}`,
      redirectUrl: `https://${host}/book?checkout=${checkoutId}`,
    });
    const doc = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    expect(doc).toMatchObject({ studentId: t.studentId, packageId: t.pkg30, amountCents: 30000, status: 'pending', hitpay: { requestId: 'req-1' } });
  });

  it('refuses packages not sold online, non-students, and schools without HitPay', async () => {
    const { t, host } = await setup();
    await expect(startCheckout(db, new FakeHitPay(), { schoolId: t.schoolId, packageId: t.pkg90, host }, student(t))).rejects.toThrow(/not sold online/);
    await expect(startCheckout(db, new FakeHitPay(), { schoolId: t.schoolId, packageId: t.pkg30, host }, { uid: 'o', role: 'owner' })).rejects.toThrow(/Only students/);
    await expect(startCheckout(db, null, { schoolId: t.schoolId, packageId: t.pkg30, host }, student(t))).rejects.toThrow(/not set up/);
  });
});

describe('hitpayWebhook', () => {
  it('on a signed completed payment: sells the package, records the payment, marks the checkout paid, once', async () => {
    const { t, host } = await setup();
    const { checkoutId } = await checkoutDone(t, host);
    const b = completed(t, checkoutId);
    const keys = { [t.schoolId]: { apiKey: 'k', salt: SALT } };
    expect(await handleHitPayWebhook(db, keys, b, sign(b), NOW)).toBe('paid');
    const doc = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    expect(doc.status).toBe('paid');
    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${doc.invoiceId}`).get()).data()!;
    expect(inv).toMatchObject({ status: 'paid', paidCents: 30000, pendingCents: 0 });
    const payments = await db.collection(`schools/${t.schoolId}/payments`).where('invoiceId', '==', doc.invoiceId).get();
    expect(payments.docs.map((p) => p.get('method'))).toEqual(['card_hitpay']);
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    // HitPay retries: nothing more happens.
    expect(await handleHitPayWebhook(db, keys, b, sign(b), NOW)).toBe('duplicate');
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });

  it('rejects bad signatures and ignores wrong amounts or unfinished payments', async () => {
    const { t, host } = await setup();
    const { checkoutId } = await checkoutDone(t, host);
    const keys = { [t.schoolId]: { apiKey: 'k', salt: SALT } };
    const b = completed(t, checkoutId);
    expect(await handleHitPayWebhook(db, keys, b, sign(b, 'wrong'), NOW)).toBe('badSignature');
    expect(await handleHitPayWebhook(db, keys, b, undefined, NOW)).toBe('badSignature');
    const pending = body({ id: 'req-1', status: 'pending', amount: '300.00', reference_number: `${t.schoolId}.${checkoutId}` });
    expect(await handleHitPayWebhook(db, keys, pending, sign(pending), NOW)).toBe('ignored');
    const cheap = completed(t, checkoutId, '3.00');
    expect(await handleHitPayWebhook(db, keys, cheap, sign(cheap), NOW)).toBe('ignored');
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    expect(validSignature(Buffer.from('x'), sign(Buffer.from('x')), SALT)).toBe(true);
  });
});

describe('buy-first booking rule', () => {
  const book = (t: TestSchool) => bookLesson(db, { schoolId: t.schoolId, teacherId: t.teacherId, startAt: sg('2027-01-04', '10:00'), mode: 'inPerson' }, student(t), NOW);

  it("'newStudents': a new student with no sessions must buy first; a migrated one may still book", async () => {
    const { t } = await setup('newStudents');
    const avail = await getAvailability(db, { schoolId: t.schoolId }, student(t), NOW);
    expect(avail.credit).toEqual({ sessionsAvailable: 0, upcomingLessons: 0, mustBuy: true });
    await expect(book(t)).rejects.toThrow(/Buy a package first/);
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ legacyId: 'SYWH001' });
    await expect(book(t)).resolves.toMatchObject({ existing: false });
  });

  it("counts upcoming lessons against the sessions: one session, one booking", async () => {
    const { t } = await setup('all');
    await sell(t, t.pkg30); // 4 sessions
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ 'summary.sessionsAvailable': 1 }); // pretend 3 are used
    await expect(book(t)).resolves.toMatchObject({ existing: false });
    await expect(
      bookLesson(db, { schoolId: t.schoolId, teacherId: t.teacherId, startAt: sg('2027-01-04', '11:00'), mode: 'inPerson' }, student(t), NOW),
    ).rejects.toThrow(/Buy a package first/);
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ 'summary.sessionsAvailable': 4 }); // restore for the invariant check
  });

  it("'none' (the default) keeps booking on credit", async () => {
    const { t } = await setup();
    expect((await getAvailability(db, { schoolId: t.schoolId }, student(t), NOW)).credit?.mustBuy).toBe(false);
    await expect(book(t)).resolves.toMatchObject({ existing: false });
  });
});
