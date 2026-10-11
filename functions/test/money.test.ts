import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setAttendance } from '../src/attendance';
import { markOverdue, recordPayment, voidInvoice, type PaymentMethod } from '../src/money';
import { DAY, db, ledger, lesson, lot, money, owner, sell, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();

const pay = (t: TestSchool, invoiceId: string, amountCents: number, method: PaymentMethod = 'paynow', key: string = randomUUID()) =>
  recordPayment(db, { schoolId: t.schoolId, invoiceId, amountCents, method, reference: 'ref-1', idempotencyKey: key }, owner);

const invoice = async (t: TestSchool, id: string) => (await db.doc(`schools/${t.schoolId}/invoices/${id}`).get()).data()!;

describe('recordPayment', () => {
  it('partial PayNow payment -> partial, then the rest -> paid', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30); // SGD 300
    expect(await money(t)).toEqual({ outstandingCents: 30000, moneyCreditCents: 0 });

    const first = await pay(t, sale.invoiceId, 10000);
    expect(first).toMatchObject({ invoiceStatus: 'partial', appliedCents: 10000, overpaymentCents: 0, pendingCents: 20000 });
    expect(await invoice(t, sale.invoiceId)).toMatchObject({ status: 'partial', paidCents: 10000, pendingCents: 20000 });
    expect(await money(t)).toEqual({ outstandingCents: 20000, moneyCreditCents: 0 });
    const p = (await db.doc(`schools/${t.schoolId}/payments/${first.paymentId}`).get()).data()!;
    expect(p).toMatchObject({ method: 'paynow', amountCents: 10000, invoiceId: sale.invoiceId, status: 'succeeded', reference: 'ref-1' });

    const second = await pay(t, sale.invoiceId, 20000, 'cash');
    expect(second.invoiceStatus).toBe('paid');
    expect(await invoice(t, sale.invoiceId)).toMatchObject({ status: 'paid', paidCents: 30000, pendingCents: 0 });
    expect(await money(t)).toEqual({ outstandingCents: 0, moneyCreditCents: 0 });
  });

  it('an overpayment becomes money credit', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const res = await pay(t, sale.invoiceId, 35000, 'bank');
    expect(res).toMatchObject({ invoiceStatus: 'paid', appliedCents: 30000, overpaymentCents: 5000 });
    expect(await money(t)).toEqual({ outstandingCents: 0, moneyCreditCents: 5000 });
    const credit = await db.collection(`schools/${t.schoolId}/moneyLedger`).where('studentId', '==', t.studentId).get();
    expect(credit.docs.map((d) => d.data())).toMatchObject([
      { type: 'overpayment', deltaCents: 5000, invoiceId: sale.invoiceId, paymentId: res.paymentId },
    ]);
  });

  it('is idempotent per key', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const a = await pay(t, sale.invoiceId, 10000, 'paynow', 'pay-key-0001');
    const b = await pay(t, sale.invoiceId, 10000, 'paynow', 'pay-key-0001');
    expect(b).toEqual(a);
    expect((await db.collection(`schools/${t.schoolId}/payments`).get()).size).toBe(1);
    await expect(pay(t, sale.invoiceId, 5000, 'paynow', 'pay-key-0001')).rejects.toThrow(/different payment/);
  });

  it('refuses paid and void invoices, and amounts that are not positive whole cents', async () => {
    const t = await school();
    const paid = await sell(t, t.pkg30);
    await pay(t, paid.invoiceId, 30000);
    await expect(pay(t, paid.invoiceId, 100)).rejects.toThrow(/already paid/);

    const other = await sell(t, t.pkg90);
    await voidInvoice(db, { schoolId: t.schoolId, invoiceId: other.invoiceId, reason: 'Sold by mistake' }, owner);
    await expect(pay(t, other.invoiceId, 100)).rejects.toThrow(/void/);
    await expect(pay(t, paid.invoiceId, 0)).rejects.toThrow(/positive/);
    await expect(pay(t, paid.invoiceId, 10.5)).rejects.toThrow(/positive/);
  });
});

describe('voidInvoice', () => {
  it('voids an unpaid sale and takes back its unused credits', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const res = await voidInvoice(db, { schoolId: t.schoolId, invoiceId: sale.invoiceId, reason: 'Wrong package' }, owner);
    expect(res).toEqual({ status: 'void', creditsRemoved: 4 });
    expect(await invoice(t, sale.invoiceId)).toMatchObject({ status: 'void', pendingCents: 0, voidReason: 'Wrong package' });
    expect(await lot(t, sale.enrolmentId)).toMatchObject({ status: 'void', sessionsRemaining: 0, sessionsTotal: 0 });
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    expect(await money(t)).toEqual({ outstandingCents: 0, moneyCreditCents: 0 });
    expect((await ledger(t)).find((e) => e.type === 'adjust')).toMatchObject({ delta: -4, reason: 'Invoice voided: Wrong package' });
    // Voiding twice is a no-op.
    expect(await voidInvoice(db, { schoolId: t.schoolId, invoiceId: sale.invoiceId, reason: 'again' }, owner)).toEqual({
      status: 'void',
      creditsRemoved: 0,
    });
  });

  it('refuses when credits were used, unless told to keep them', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const id = await lesson(t);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, status: 'present' }, owner);
    await expect(
      voidInvoice(db, { schoolId: t.schoolId, invoiceId: sale.invoiceId, reason: 'x' }, owner),
    ).rejects.toThrow(/already used/);
    const res = await voidInvoice(db, { schoolId: t.schoolId, invoiceId: sale.invoiceId, reason: 'Gift', keepCredits: true }, owner);
    expect(res).toEqual({ status: 'void', creditsRemoved: 0 });
    expect((await lot(t, sale.enrolmentId)).status).toBe('active');
    expect(await summary(t)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
  });

  it('refuses an invoice with payments', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    await pay(t, sale.invoiceId, 5000);
    await expect(voidInvoice(db, { schoolId: t.schoolId, invoiceId: sale.invoiceId, reason: 'x' }, owner)).rejects.toThrow(
      /payments/,
    );
  });
});

describe('markOverdue', () => {
  it('flags unpaid invoices past their due date once, and payment clears the flag', async () => {
    const t = await school();
    const old = await sell(t, t.pkg30, new Date(Date.now() - 10 * DAY)); // due 3 days ago
    const fresh = await sell(t, t.pkg90); // due in 7 days
    const paid = await sell(t, t.pkgNoExpiry, new Date(Date.now() - 10 * DAY));
    await pay(t, paid.invoiceId, 30000);

    const first = await markOverdue(db, t.schoolId);
    expect(first.flagged).toBe(1);
    expect((await invoice(t, old.invoiceId)).overdueSince).toBeTruthy();
    expect((await invoice(t, fresh.invoiceId)).overdueSince ?? null).toBeNull();
    expect((await invoice(t, paid.invoiceId)).overdueSince ?? null).toBeNull();
    expect((await markOverdue(db, t.schoolId)).flagged).toBe(0);

    await pay(t, old.invoiceId, 10000);
    expect((await invoice(t, old.invoiceId)).overdueSince).toBeTruthy(); // still owes money
    await pay(t, old.invoiceId, 20000);
    expect((await invoice(t, old.invoiceId)).overdueSince).toBeNull();
  });
});
