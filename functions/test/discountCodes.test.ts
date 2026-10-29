import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sellPackage } from '../src/credits';
import { handleHitPayWebhook, startCheckout, type HitPayClient, type PaymentRequest } from '../src/checkout';
import type { Actor } from '../src/db';
import { previewDiscountCode, saveDiscountCode } from '../src/discountCodes';
import { db, owner, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const SALT = 'test-salt';

const save = (t: TestSchool, over: Partial<Parameters<typeof saveDiscountCode>[1]> = {}) =>
  saveDiscountCode(
    db,
    { schoolId: t.schoolId, code: '1010promo', kind: 'percent', value: 20, packageIds: [t.pkg30], validUntil: null, maxUses: null, active: true, ...over },
    owner,
  );
const codeDoc = async (t: TestSchool, code = '1010PROMO') => (await db.doc(`schools/${t.schoolId}/discountCodes/${code}`).get()).data()!;
const sellWith = (t: TestSchool, packageId: string, discountCode: string, key = `key-${Math.random().toString(36).slice(2)}`) =>
  sellPackage(db, { schoolId: t.schoolId, studentId: t.studentId, packageId, idempotencyKey: key, discountCode }, owner);

describe('saveDiscountCode', () => {
  it('stores the code upper-cased and updates it without resetting its use count', async () => {
    const t = await school();
    await save(t);
    expect(await codeDoc(t)).toMatchObject({ code: '1010PROMO', kind: 'percent', value: 20, packageIds: [t.pkg30], usedCount: 0, active: true });
    await sellWith(t, t.pkg30, '1010promo');
    await save(t, { value: 25 });
    expect(await codeDoc(t)).toMatchObject({ value: 25, usedCount: 1 });
  });

  it('rejects bad codes, bad percentages and unknown packages', async () => {
    const t = await school();
    await expect(save(t, { code: 'a b' })).rejects.toThrow(/letters, numbers/);
    await expect(save(t, { value: 150 })).rejects.toThrow(/between 1 and 100/);
    await expect(save(t, { packageIds: ['nope'] })).rejects.toThrow(/Package not found/);
  });
});

describe('previewDiscountCode', () => {
  it('quotes 20% off the package for a matching code, in any letter case', async () => {
    const t = await school();
    await save(t);
    const r = await previewDiscountCode(db, { schoolId: t.schoolId, packageId: t.pkg30, code: ' 1010Promo ' });
    expect(r).toMatchObject({ code: '1010PROMO', subtotalCents: 30000, discountCents: 6000, totalCents: 24000 });
  });

  it('refuses other packages, switched-off, expired, used-up and unknown codes', async () => {
    const t = await school();
    const q = (code = '1010promo', packageId = t.pkg30, at?: Date) => previewDiscountCode(db, { schoolId: t.schoolId, packageId, code }, at);
    await save(t);
    await expect(q('1010promo', t.pkg90)).rejects.toThrow(/does not apply/);
    await expect(q('nothere')).rejects.toThrow(/not valid/);
    await save(t, { active: false });
    await expect(q()).rejects.toThrow(/not valid/);
    await save(t, { validUntil: '2027-01-31' });
    await expect(q('1010promo', t.pkg30, new Date('2027-01-31T15:59:00Z'))).resolves.toBeTruthy(); // 23:59 in Singapore, still the last day
    await expect(q('1010promo', t.pkg30, new Date('2027-01-31T16:00:00Z'))).rejects.toThrow(/expired/);
    await save(t, { validUntil: null, maxUses: 1 });
    await sellWith(t, t.pkg30, '1010promo');
    await expect(q()).rejects.toThrow(/fully used/);
  });

  it('lets a code with no package list work on every package', async () => {
    const t = await school();
    await save(t, { packageIds: [] });
    await expect(previewDiscountCode(db, { schoolId: t.schoolId, packageId: t.pkg90, code: '1010promo' })).resolves.toMatchObject({ discountCents: 6000 });
  });
});

describe('sellPackage with a code', () => {
  it('discounts the invoice, records the code on it and counts the use once, even on a retry', async () => {
    const t = await school();
    await save(t);
    const first = await sellWith(t, t.pkg30, '1010promo', 'key-retry-1');
    const again = await sellWith(t, t.pkg30, '1010promo', 'key-retry-1');
    expect(again.invoiceId).toBe(first.invoiceId);
    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${first.invoiceId}`).get()).data()!;
    expect(inv).toMatchObject({ subtotalCents: 30000, discountCents: 6000, totalCents: 24000, discountCode: '1010PROMO' });
    expect((await codeDoc(t)).usedCount).toBe(1);
  });

  it('refuses a code that does not apply to the package, and counts nothing', async () => {
    const t = await school();
    await save(t);
    await expect(sellWith(t, t.pkg90, '1010promo')).rejects.toThrow(/does not apply/);
    expect((await codeDoc(t)).usedCount).toBe(0);
  });
});

describe('online checkout with a code', () => {
  class FakeHitPay implements HitPayClient {
    requests: PaymentRequest[] = [];
    async createPaymentRequest(r: PaymentRequest) {
      this.requests.push(r);
      return { id: 'req-1', url: 'https://hitpay.example/checkout/1' };
    }
  }
  const student = (t: TestSchool): Actor => ({ uid: 'stu-uid', role: 'student', studentId: t.studentId });

  async function setup() {
    const t = await school();
    const host = `learn-${t.schoolId.replace(/_/g, '-')}.example.test`;
    await db.doc(`publicSchools/${host}`).set({ schoolId: t.schoolId, site: 'learn' });
    await db.doc(`schools/${t.schoolId}/packages/${t.pkg30}`).update({ sellsOnline: true });
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ email: 'stu@example.test' });
    await save(t);
    return { t, host };
  }

  it('asks HitPay for the discounted amount and, once paid, sells at that price and counts the use', async () => {
    const { t, host } = await setup();
    const client = new FakeHitPay();
    const { checkoutId } = await startCheckout(db, client, { schoolId: t.schoolId, packageId: t.pkg30, host, code: '1010promo' }, student(t));
    expect(client.requests[0]!.amount).toBe('240.00');
    const b = Buffer.from(
      JSON.stringify({ id: 'req-1', status: 'completed', amount: '240.00', reference_number: `${t.schoolId}.${checkoutId}`, payments: [{ id: 'pay-1', status: 'succeeded' }] }),
    );
    const sig = createHmac('sha256', SALT).update(b).digest('hex');
    expect(await handleHitPayWebhook(db, { [t.schoolId]: { apiKey: 'k', salt: SALT } }, b, sig)).toBe('paid');
    const co = (await db.doc(`schools/${t.schoolId}/checkouts/${checkoutId}`).get()).data()!;
    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${co.invoiceId}`).get()).data()!;
    expect(inv).toMatchObject({ discountCents: 6000, totalCents: 24000, paidCents: 24000, discountCode: '1010PROMO' });
    expect((await codeDoc(t)).usedCount).toBe(1);
  });

  it('refuses a code that is not valid for the package before any payment request is made', async () => {
    const { t, host } = await setup();
    await save(t, { active: false });
    const client = new FakeHitPay();
    await expect(startCheckout(db, client, { schoolId: t.schoolId, packageId: t.pkg30, host, code: '1010promo' }, student(t))).rejects.toThrow(/not valid/);
    expect(client.requests).toHaveLength(0);
  });
});
