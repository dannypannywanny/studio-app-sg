// Buying a package online with HitPay (card or PayNow), before booking.
//
// startCheckout makes a checkouts/{id} doc and a HitPay payment request for the package price, and
// returns HitPay's checkout URL. HitPay sends the student back to the learn site, and separately
// calls hitpayWebhook when the payment completes. The webhook (signature checked with the school's
// salt) sells the package (invoice + lot + grant + settle owed lessons) and records the payment.
// Every step is idempotent, so HitPay's retries never double-sell.
//
// Keys live in Secret Manager (the HITPAY_KEYS secret, JSON keyed by schoolId), never in Firestore.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { sellPackage } from './credits';
import { notFound, now, schoolRef, type Actor } from './db';
import { recordPayment } from './money';

export interface HitPayKeys {
  apiKey: string;
  salt: string;
  mode?: 'live' | 'sandbox';
}
export type HitPayKeyRing = Record<string, HitPayKeys>;

export function parseKeyRing(raw: string | undefined | null): HitPayKeyRing {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HitPayKeyRing;
  } catch {
    console.error('HITPAY_KEYS is not valid JSON');
    return {};
  }
}

export interface PaymentRequest {
  amount: string;
  currency: string;
  email: string;
  name: string;
  purpose: string;
  referenceNumber: string;
  redirectUrl: string;
}

export interface HitPayClient {
  createPaymentRequest(req: PaymentRequest): Promise<{ id: string; url: string }>;
}

const HITPAY_URL = { live: 'https://api.hit-pay.com/v1/payment-requests', sandbox: 'https://api.sandbox.hit-pay.com/v1/payment-requests' };

export function hitpayClient(keys: HitPayKeys, fetchFn: typeof fetch = fetch): HitPayClient {
  return {
    async createPaymentRequest(r) {
      const body = new URLSearchParams({
        amount: r.amount,
        currency: r.currency,
        email: r.email,
        name: r.name,
        purpose: r.purpose,
        reference_number: r.referenceNumber,
        redirect_url: r.redirectUrl,
      });
      body.append('payment_methods[]', 'paynow_online');
      body.append('payment_methods[]', 'card');
      const res = await fetchFn(HITPAY_URL[keys.mode ?? 'live'], {
        method: 'POST',
        headers: { 'X-BUSINESS-API-KEY': keys.apiKey, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; message?: string };
      if (!res.ok || !json.id || !json.url) {
        console.error(`HitPay payment request failed: ${res.status} ${json.message ?? ''}`);
        throw new HttpsError('unavailable', 'Online payment is not available right now. Please try again shortly.');
      }
      return { id: json.id, url: json.url };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// startCheckout
// ---------------------------------------------------------------------------------------------

export interface StartCheckoutInput {
  schoolId: string;
  packageId: string;
  /** Learn site hostname, where HitPay sends the student back. */
  host: string;
}

export async function startCheckout(
  db: Firestore,
  client: HitPayClient | null,
  input: StartCheckoutInput,
  actor: Actor,
): Promise<{ checkoutId: string; url: string }> {
  if (actor.role !== 'student' || !actor.studentId) throw new HttpsError('permission-denied', 'Only students can buy here');
  if (!client) throw new HttpsError('failed-precondition', 'Online payment is not set up for this school yet');
  const school = schoolRef(db, input.schoolId);
  const [schoolSnap, pkgSnap, studentSnap, site] = await db.getAll(
    school,
    school.collection('packages').doc(input.packageId),
    school.collection('students').doc(actor.studentId),
    db.collection('publicSchools').doc(input.host),
  );
  if (!schoolSnap!.exists) notFound('School');
  if (!pkgSnap!.exists || pkgSnap!.get('active') === false || pkgSnap!.get('sellsOnline') !== true) {
    throw new HttpsError('failed-precondition', 'That package is not sold online');
  }
  if (!studentSnap!.exists || studentSnap!.get('status') === 'archived') notFound('Student');
  if (!site!.exists || site!.get('schoolId') !== input.schoolId) throw new HttpsError('failed-precondition', 'Unknown site');

  const amountCents = pkgSnap!.get('priceCents') as number;
  const currency = (schoolSnap!.get('currency') as string | undefined) ?? 'SGD';
  const ref = school.collection('checkouts').doc();
  await ref.create({
    studentId: actor.studentId,
    packageId: input.packageId,
    packageName: pkgSnap!.get('name'),
    amountCents,
    currency,
    status: 'pending',
    provider: 'hitpay',
    createdBy: actor.uid,
    createdAt: now(),
    updatedAt: now(),
  });
  const s = studentSnap!;
  const req = await client.createPaymentRequest({
    amount: (amountCents / 100).toFixed(2),
    currency,
    email: String(s.get('email') ?? ''),
    name: [s.get('preferredName') || s.get('firstName'), s.get('lastName')].filter(Boolean).join(' '),
    purpose: `${schoolSnap!.get('name')}: ${pkgSnap!.get('name')}`,
    referenceNumber: `${input.schoolId}.${ref.id}`,
    redirectUrl: `https://${input.host}/book?checkout=${ref.id}`,
  });
  await ref.update({ hitpay: { requestId: req.id, url: req.url }, updatedAt: now() });
  return { checkoutId: ref.id, url: req.url };
}

// ---------------------------------------------------------------------------------------------
// hitpayWebhook
// ---------------------------------------------------------------------------------------------

/** HMAC-SHA256 of the raw body with the salt, hex, compared in constant time. */
export function validSignature(rawBody: Buffer, signature: string | undefined, salt: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac('sha256', salt).update(rawBody).digest('hex'));
  const given = Buffer.from(signature.trim().toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type WebhookOutcome = 'paid' | 'failed' | 'duplicate' | 'ignored' | 'badSignature' | 'unknown';

interface WebhookPayload {
  id?: string;
  status?: string;
  amount?: string | number;
  reference_number?: string;
  payments?: { id?: string; status?: string }[];
}

export async function handleHitPayWebhook(
  db: Firestore,
  keys: HitPayKeyRing,
  rawBody: Buffer,
  signature: string | undefined,
  at: Date = new Date(),
): Promise<WebhookOutcome> {
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
  } catch {
    return 'ignored';
  }
  const [schoolId, checkoutId] = String(payload.reference_number ?? '').split('.');
  if (!schoolId || !checkoutId || !keys[schoolId]) return 'unknown';
  if (!validSignature(rawBody, signature, keys[schoolId]!.salt)) return 'badSignature';
  const school = schoolRef(db, schoolId);
  const ref = school.collection('checkouts').doc(checkoutId);
  if (payload.status !== 'completed') {
    // A failed attempt: note it so the studio can follow up. Nothing is sold; the student can retry.
    if (payload.status !== 'failed') return 'ignored';
    const pending = await ref.get();
    if (!pending.exists || pending.get('status') !== 'pending') return 'ignored';
    await ref.update({ status: 'failed', failedAt: Timestamp.fromDate(at), updatedAt: now() });
    return 'failed';
  }

  const snap = await ref.get();
  if (!snap.exists) return 'unknown';
  if (snap.get('status') === 'paid') return 'duplicate';
  const amountCents = snap.get('amountCents') as number;
  if (Math.round(Number(payload.amount) * 100) !== amountCents) {
    console.error(`hitpayWebhook: amount ${payload.amount} does not match checkout ${checkoutId} (${amountCents} cents)`);
    await ref.update({ status: 'mismatch', updatedAt: now() });
    return 'ignored';
  }

  const system: Actor = { uid: 'hitpay', role: 'system' };
  const requestId = payload.id ?? checkoutId;
  const paymentId = payload.payments?.find((p) => p.status === 'succeeded' || p.status === 'completed')?.id ?? requestId;
  const sale = await sellPackage(
    db,
    { schoolId, studentId: snap.get('studentId') as string, packageId: snap.get('packageId') as string, idempotencyKey: `checkout-${checkoutId}` },
    system,
    at,
  );
  await recordPayment(
    db,
    { schoolId, invoiceId: sale.invoiceId, amountCents, method: 'card_hitpay', paidAt: at, reference: paymentId, idempotencyKey: `hitpay-${requestId}` },
    system,
    at,
  );
  await ref.update({ status: 'paid', invoiceId: sale.invoiceId, paymentRef: paymentId, paidAt: Timestamp.fromDate(at), updatedAt: now() });
  return 'paid';
}
