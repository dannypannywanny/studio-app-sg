// Buying a package (or event tickets, see events.ts) online with HitPay (whatever methods the school enabled there), before booking.
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
import { enqueueAlert } from './alerts';
import { sellPackage } from './credits';
import { completeEventCheckout, type EventMail } from './events';
import { notFound, now, schoolRef, type Actor } from './db';
import { previewDiscountCode } from './discountCodes';
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
      // No payment_methods[]: HitPay then offers every method the school has switched on in its dashboard
      // (card, PayNow, GrabPay, ShopeePay, Atome, ...).
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
  /** A discount code the student typed; checked here, counted when the payment completes. */
  code?: string | null;
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

  const listCents = pkgSnap!.get('priceCents') as number;
  // With a code: the price the student sees on the buy page (after the discount and the school's tax).
  // Without one the amount stays the package price, exactly as before.
  const quote = input.code?.trim() ? await previewDiscountCode(db, { schoolId: input.schoolId, packageId: input.packageId, code: input.code }) : null;
  const amountCents = quote ? quote.totalCents : listCents;
  if (amountCents < 1) throw new HttpsError('failed-precondition', 'This discount makes the package free; ask the studio to add it for you');
  const currency = (schoolSnap!.get('currency') as string | undefined) ?? 'SGD';
  const ref = school.collection('checkouts').doc();
  await ref.create({
    studentId: actor.studentId,
    packageId: input.packageId,
    packageName: pkgSnap!.get('name'),
    listCents,
    discountCode: quote?.code ?? null,
    discount: quote?.discount ?? null,
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
// Payment problem alerts
// ---------------------------------------------------------------------------------------------

/** The alert fields every checkout (package or event tickets) can fill. */
function checkoutAlertFields(c: FirebaseFirestore.DocumentSnapshot) {
  const item = c.get('kind') === 'event' ? `${c.get('eventTitle') as string} (${c.get('optionLabel') as string})` : (c.get('packageName') as string);
  const code = c.get('discountCode') as string | null | undefined;
  return {
    provider: (c.get('provider') as string | undefined) ?? 'hitpay',
    invoiceId: null,
    invoiceNumber: null,
    studentId: (c.get('studentId') as string | null | undefined) ?? null,
    bookingId: null,
    checkoutId: c.id,
    item: code ? `${item}, with code ${code}` : item,
    amountCents: c.get('amountCents') as number,
    currency: (c.get('currency') as string | undefined) ?? 'SGD',
    reason: null,
  };
}

/** A checkout still unpaid this long after it was opened counts as not completed. */
export const ABANDONED_AFTER_MIN = 30;
/** Older checkouts are never alerted on (so switching this on doesn't email about old history). */
const ABANDONED_LOOKBACK_MS = 24 * 3_600_000;

/**
 * Emails the owner about online payments started but not finished (HitPay sends no webhook when someone
 * just closes the page). One alert per buyer for their latest attempt: someone who retries three times
 * gets one email, nothing while they may still be paying, and nothing if they paid in the end.
 * Each checkout is marked `abandonAlertedAt` so it is never looked at twice; the checkout stays
 * 'pending', so a late payment still goes through the webhook as normal.
 */
export async function flagAbandonedCheckouts(db: Firestore, schoolId: string, at: Date = new Date()): Promise<number> {
  const school = schoolRef(db, schoolId);
  const snap = await school.collection('checkouts').where('createdAt', '>=', Timestamp.fromMillis(at.getTime() - ABANDONED_LOOKBACK_MS)).get();
  const cutoff = at.getTime() - ABANDONED_AFTER_MIN * 60_000;
  const byBuyer = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const d of snap.docs) {
    const key = (d.get('studentId') as string | null) ?? ((d.get('buyer.email') as string | undefined)?.toLowerCase() || d.id);
    byBuyer.set(key, [...(byBuyer.get(key) ?? []), d]);
  }
  let alerted = 0;
  for (const docs of byBuyer.values()) {
    const open = docs.filter((d) => d.get('status') === 'pending' && !d.get('abandonAlertedAt'));
    if (open.length === 0) continue;
    const latest = docs.reduce((a, b) => ((b.get('createdAt') as Timestamp).toMillis() > (a.get('createdAt') as Timestamp).toMillis() ? b : a));
    if ((latest.get('createdAt') as Timestamp).toMillis() > cutoff) continue; // may still be paying
    // Alert only when their latest attempt is the unfinished one; after a payment or a failure (which
    // has its own alert) the earlier open attempts are just marked.
    const alertOn = open.includes(latest) ? latest : null;
    await db.runTransaction(async (tx) => {
      const fresh = await Promise.all(open.map((d) => tx.get(d.ref)));
      const still = fresh.filter((d) => d.get('status') === 'pending' && !d.get('abandonAlertedAt'));
      for (const d of still) tx.update(d.ref, { abandonAlertedAt: Timestamp.fromDate(at) });
      const target = alertOn && still.find((d) => d.id === alertOn.id);
      if (target) {
        enqueueAlert(tx, school, `checkout_${target.id}_abandoned`, { type: 'payment.abandoned', ...checkoutAlertFields(target) }, { uid: 'system', role: 'system' }, at);
        alerted++;
      }
    });
  }
  return alerted;
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
  /** Sends event ticket confirmations; null = none (tests, no mail key). */
  mail: EventMail | null = null,
): Promise<WebhookOutcome> {
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
  } catch {
    return 'ignored';
  }
  const [schoolId, checkoutId] = String(payload.reference_number ?? '').split('.');
  if (!schoolId || !checkoutId || !keys[schoolId]) return 'unknown';
  if (!validSignature(rawBody, signature, keys[schoolId]!.salt)) {
    // Keep the rejected message (server-only collection, no rules access) so a key mix-up can be diagnosed.
    await schoolRef(db, schoolId).collection('webhookRejects').add({
      provider: 'hitpay',
      raw: rawBody.toString('utf8').slice(0, 20000),
      signature: signature ?? null,
      at: Timestamp.fromDate(at),
      expireAt: Timestamp.fromMillis(at.getTime() + 7 * 86_400_000),
    });
    return 'badSignature';
  }
  const school = schoolRef(db, schoolId);
  const ref = school.collection('checkouts').doc(checkoutId);
  if (payload.status !== 'completed') {
    // A failed attempt: note it and email the owner so the studio can follow up. Nothing is sold; the
    // student can retry.
    if (payload.status !== 'failed') return 'ignored';
    return db.runTransaction(async (tx) => {
      const pending = await tx.get(ref);
      if (!pending.exists || pending.get('status') !== 'pending') return 'ignored' as const;
      tx.update(ref, { status: 'failed', failedAt: Timestamp.fromDate(at), updatedAt: now() });
      enqueueAlert(tx, school, `checkout_${checkoutId}_failed`, { type: 'payment.failed', ...checkoutAlertFields(pending) }, { uid: 'hitpay', role: 'system' }, at);
      return 'failed' as const;
    });
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
  if (snap.get('kind') === 'event') {
    await completeEventCheckout(db, schoolId, checkoutId, { requestId, paymentId }, mail, at);
    return 'paid';
  }
  const sale = await sellPackage(
    db,
    { schoolId, studentId: snap.get('studentId') as string, packageId: snap.get('packageId') as string, idempotencyKey: `checkout-${checkoutId}`,
      paidOnline: true,
      discount: (snap.get('discount') as { kind: 'percent' | 'amount'; value: number } | null) ?? null,
      discountCode: (snap.get('discountCode') as string | null) ?? null,
    },
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
