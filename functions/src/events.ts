// Event tickets (workshops, masterclasses) sold on the learn site to anyone, without an account.
//
// Staff create schools/{s}/events/{id} in the teach app (title, time, venue, capacity, price tiers).
// startEventCheckout takes the buyer's name, email, phone and ticket count, holds the seats for
// EVENT_HOLD_MIN minutes in a checkouts/{id} doc (kind 'event'), and opens a HitPay payment request.
// When HitPay's webhook reports the payment (checkout.ts), completeEventCheckout links the buyer to a
// student record (an existing one with that email, else a new lead), raises a paid invoice for the
// tickets and emails a confirmation. Every step is idempotent, so HitPay's retries never double-sell.
//
// The event's time also blocks lesson booking for its hosts (eventsHeld, used by booking.ts).
import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Query, type QuerySnapshot } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  DEFAULT_MAX_PER_ORDER,
  EVENT_HOLD_MIN,
  applyTax,
  currentTier,
  formatMoney,
  resolveTax,
  wallDateOf,
  type EventPriceTier,
} from '@lessonkaki/shared';
import type { MailSender } from './alerts';
import type { HitPayClient } from './checkout';
import { formatInvoiceNumber } from './credits';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';
import { recordPayment } from './money';
import { normalisePhone } from './signup';

/** Ticket checkouts per school per hour before the form says to try later (stops a bot holding every seat). */
export const MAX_EVENT_CHECKOUTS_PER_HOUR = 40;
const HOUR_MS = 3_600_000;
/** Longest event the booking check looks back for. */
const MAX_EVENT_MS = 24 * HOUR_MS;

export interface StartEventCheckoutInput {
  eventId: string;
  qty: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** Ticked "I agree to the privacy notice". */
  consent: boolean;
  /** Ticked "Tell me about future events". */
  marketing: boolean;
  /** Learn site hostname: decides the school and where HitPay sends the buyer back. */
  host: string;
}

/** Seats taken: paid orders, plus unpaid ones still inside their hold. */
function seatsTaken(orders: QuerySnapshot, atMs: number): number {
  return orders.docs.reduce((n, d) => {
    const status = d.get('status') as string;
    const hold = (d.get('holdUntil') as Timestamp | undefined)?.toMillis() ?? 0;
    return status === 'paid' || (status === 'pending' && hold > atMs) ? n + ((d.get('qty') as number) ?? 0) : n;
  }, 0);
}

export async function startEventCheckout(
  db: Firestore,
  client: HitPayClient | null,
  input: StartEventCheckoutInput,
  at: Date = new Date(),
): Promise<{ checkoutId: string; url: string }> {
  if (!input.consent) throw new HttpsError('invalid-argument', 'Please agree to the privacy notice');
  const phone = normalisePhone(input.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Enter a phone number like 9123 4567 or +44 7700 900123');
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email.trim().toLowerCase();
  if (!firstName) throw new HttpsError('invalid-argument', 'Enter your first name');

  const site = await db.collection('publicSchools').doc(input.host).get();
  if (!site.exists || site.get('site') !== 'learn') throw new HttpsError('failed-precondition', 'This site is not set up for tickets');
  const schoolId = site.get('schoolId') as string;
  if (!client) throw new HttpsError('failed-precondition', 'Online payment is not set up for this school yet');
  const school = schoolRef(db, schoolId);
  const eventRef = school.collection('events').doc(input.eventId);
  const counter = school.collection('counters').doc('eventCheckouts');
  const ref = school.collection('checkouts').doc();

  const order = await db.runTransaction(async (tx) => {
    const [schoolSnap, ev, c] = await readAll(tx, school, eventRef, counter);
    if (!ev.exists || ev.get('published') !== true) notFound('Event');
    if (ev.get('status') === 'cancelled') throw new HttpsError('failed-precondition', 'This event has been cancelled');
    if ((ev.get('startAt') as Timestamp).toMillis() <= at.getTime()) throw new HttpsError('failed-precondition', 'Ticket sales for this event have closed');
    const timeZone = (ev.get('timeZone') as string | undefined) ?? (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const onSale = currentTier((ev.get('prices') as EventPriceTier[] | undefined) ?? [], at, timeZone);
    if (!onSale) throw new HttpsError('failed-precondition', 'Ticket sales for this event have closed');
    const maxPerOrder = (ev.get('maxPerOrder') as number | undefined) ?? DEFAULT_MAX_PER_ORDER;
    if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > maxPerOrder) {
      throw new HttpsError('invalid-argument', `You can buy 1 to ${maxPerOrder} tickets at a time`);
    }
    const capacity = ev.get('capacity');
    if (typeof capacity === 'number') {
      const orders = await tx.get(school.collection('checkouts').where('eventId', '==', input.eventId));
      const left = capacity - seatsTaken(orders, at.getTime());
      if (left < input.qty) {
        throw new HttpsError('resource-exhausted', left > 0 ? `Only ${left} ${left === 1 ? 'seat is' : 'seats are'} left` : 'Sorry, this event is sold out');
      }
    }
    const start = (c.get('windowStart') as Timestamp | undefined)?.toMillis() ?? 0;
    const inWindow = at.getTime() - start < HOUR_MS;
    const count = inWindow ? ((c.get('count') as number | undefined) ?? 0) : 0;
    if (count >= MAX_EVENT_CHECKOUTS_PER_HOUR) throw new HttpsError('resource-exhausted', 'Too many orders right now. Please try again shortly.');

    // The charge includes tax the way the school has it set, so the invoice made on payment matches it.
    const subtotalCents = onSale.tier.priceCents * input.qty;
    const { taxCents, totalCents } = applyTax(subtotalCents, resolveTax(schoolSnap.get('tax')));
    const currency = (ev.get('currency') as string | undefined) ?? (schoolSnap.get('currency') as string | undefined) ?? 'SGD';
    tx.set(counter, { windowStart: Timestamp.fromMillis(inWindow ? start : at.getTime()), count: count + 1 });
    tx.create(ref, {
      kind: 'event',
      eventId: input.eventId,
      eventTitle: ev.get('title'),
      qty: input.qty,
      tierLabel: onSale.tier.label,
      unitCents: onSale.tier.priceCents,
      subtotalCents,
      taxCents,
      amountCents: totalCents,
      currency,
      buyer: { firstName, lastName, email, phone, marketing: input.marketing === true },
      consentAt: Timestamp.fromDate(at),
      studentId: null,
      status: 'pending',
      holdUntil: Timestamp.fromMillis(at.getTime() + EVENT_HOLD_MIN * 60_000),
      provider: 'hitpay',
      createdBy: 'public',
      createdAt: now(),
      updatedAt: now(),
    });
    return { totalCents, currency, title: ev.get('title') as string, schoolName: schoolSnap.get('name') as string };
  });

  const req = await client.createPaymentRequest({
    amount: (order.totalCents / 100).toFixed(2),
    currency: order.currency,
    email,
    name: [firstName, lastName].filter(Boolean).join(' '),
    purpose: `${order.schoolName}: ${order.title} x${input.qty}`,
    referenceNumber: `${schoolId}.${ref.id}`,
    redirectUrl: `https://${input.host}/events/${input.eventId}?order=${ref.id}`,
  });
  await ref.update({ hitpay: { requestId: req.id, url: req.url }, updatedAt: now() });
  return { checkoutId: ref.id, url: req.url };
}

/** What the buyer's return page shows: whether it went through, without their details. */
export async function eventOrderStatus(
  db: Firestore,
  input: { host: string; eventId: string; orderId: string },
): Promise<{ status: string; qty: number; email: string | null }> {
  const site = await db.collection('publicSchools').doc(input.host).get();
  if (!site.exists) notFound('Order');
  const snap = await schoolRef(db, site.get('schoolId') as string).collection('checkouts').doc(input.orderId).get();
  if (!snap.exists || snap.get('kind') !== 'event' || snap.get('eventId') !== input.eventId) notFound('Order');
  const email = String(snap.get('buyer.email') ?? '');
  // Masked ("da***@gmail.com") so a shared link doesn't give the address away.
  return { status: snap.get('status') as string, qty: snap.get('qty') as number, email: email ? email.replace(/^(.{0,2})[^@]*/, '$1***') : null };
}

// ---------------------------------------------------------------------------------------------
// Payment arrived (called from handleHitPayWebhook)
// ---------------------------------------------------------------------------------------------

export interface EventMail {
  sender: MailSender | null;
  defaultFrom: string;
}

/**
 * Sells the tickets on a checkout HitPay says is paid: buyer -> student (existing, or a new lead),
 * invoice for the tickets, the payment, then the confirmation email. Safe to run again.
 */
export async function completeEventCheckout(
  db: Firestore,
  schoolId: string,
  checkoutId: string,
  payment: { requestId: string; paymentId: string },
  mail: EventMail | null,
  at: Date,
): Promise<void> {
  const school = schoolRef(db, schoolId);
  const ref = school.collection('checkouts').doc(checkoutId);
  const system: Actor = { uid: 'hitpay', role: 'system' };

  const { invoiceId, amountCents } = await db.runTransaction(async (tx) => {
    const [snap, schoolSnap] = await readAll(tx, ref, school);
    if (!snap.exists) notFound('Checkout');
    if (snap.get('invoiceId')) return { invoiceId: snap.get('invoiceId') as string, amountCents: snap.get('amountCents') as number };
    const eventRef = school.collection('events').doc(snap.get('eventId') as string);
    const counterRef = school.collection('counters').doc('invoice');
    const [ev, counterSnap] = await readAll(tx, eventRef, counterRef);
    const buyer = snap.get('buyer') as { firstName: string; lastName: string; email: string; phone: string; marketing: boolean };
    const onFile = (await tx.get(school.collection('students').where('email', '==', buyer.email))).docs.filter((d) => d.get('status') !== 'archived');
    const timeZone = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const title = (snap.get('eventTitle') as string | undefined) ?? 'Event';
    const qty = snap.get('qty') as number;
    const total = snap.get('amountCents') as number;

    // ---- writes ----
    // Someone already on file keeps their record; a newcomer becomes a lead so the studio can follow up.
    let studentId: string;
    if (onFile.length) {
      studentId = onFile[0]!.id;
      tx.update(onFile[0]!.ref, { 'summary.outstandingCents': FieldValue.increment(total), updatedAt: now() });
    } else {
      const studentRef = school.collection('students').doc();
      studentId = studentRef.id;
      tx.create(studentRef, {
        firstName: buyer.firstName,
        lastName: buyer.lastName,
        preferredName: null,
        email: buyer.email,
        phone: buyer.phone,
        status: 'lead',
        lead: { stage: 'new', followUpOn: null, lostReason: null, closedAt: null },
        studentCode: null,
        legacyId: null,
        referralSource: title,
        signupSource: 'event',
        consent: {
          pdpaNoticeVersion: (schoolSnap.get('pdpa.noticeVersion') as string | undefined) ?? null,
          acceptedAt: snap.get('consentAt') ?? Timestamp.fromDate(at),
          marketing: buyer.marketing,
        },
        createdOn: wallDateOf(at, timeZone),
        notes: `Bought ${qty} ${qty === 1 ? 'ticket' : 'tickets'} for ${title}.`,
        // The invoice below is paid straight after, which brings this back to 0.
        summary: { sessionsAvailable: 0, sessionsOwed: 0, outstandingCents: total, moneyCreditCents: 0 },
        createdAt: now(),
        updatedAt: now(),
      });
    }

    const n = counterSnap.exists ? (counterSnap.get('next') as number) : 1;
    const invoiceNumber = formatInvoiceNumber((schoolSnap.get('invoicePrefix') as string | undefined) ?? 'INV', n);
    tx.set(counterRef, { next: n + 1, updatedAt: now() });
    // Tax as it was when the buyer was charged (copied on the checkout).
    const tax = resolveTax(schoolSnap.get('tax'));
    const nowTs = Timestamp.fromDate(at);
    const invoiceRef = school.collection('invoices').doc();
    tx.create(invoiceRef, {
      number: invoiceNumber,
      studentId,
      currency: snap.get('currency') ?? 'SGD',
      lines: [{ desc: `${title} · ${snap.get('tierLabel')} ticket`, qty, unitCents: snap.get('unitCents'), eventId: snap.get('eventId') }],
      subtotalCents: snap.get('subtotalCents'),
      discountCents: 0,
      taxCents: (snap.get('taxCents') as number | undefined) ?? 0,
      tax: tax.enabled && snap.get('taxCents') ? { rate: tax.rate, label: tax.label, inclusive: tax.inclusive, regNo: tax.regNo } : null,
      note: null,
      moneyCreditAppliedCents: 0,
      totalCents: total,
      paidCents: 0,
      pendingCents: total,
      status: 'sent',
      overdueSince: null,
      issueDate: nowTs,
      dueDate: nowTs,
      createdBy: system.uid,
      createdAt: now(),
      updatedAt: now(),
    });
    if (ev.exists) tx.update(eventRef, { soldQty: FieldValue.increment(qty), updatedAt: now() });
    tx.update(ref, { studentId, invoiceId: invoiceRef.id, updatedAt: now() });
    audit(tx, school, system, 'sellEventTickets', `invoices/${invoiceRef.id}`, { eventId: snap.get('eventId'), qty, invoiceNumber });
    return { invoiceId: invoiceRef.id, amountCents: total };
  });

  await recordPayment(
    db,
    { schoolId, invoiceId, amountCents, method: 'card_hitpay', paidAt: at, reference: payment.paymentId, idempotencyKey: `hitpay-${payment.requestId}` },
    system,
    at,
  );
  await ref.update({ status: 'paid', paymentRef: payment.paymentId, paidAt: Timestamp.fromDate(at), updatedAt: now() });
  if (mail?.sender) {
    try {
      await sendEventConfirmation(db, schoolId, checkoutId, mail.sender, mail.defaultFrom);
    } catch (err) {
      // The sale stands; the attendee list shows the email didn't go, and staff can resend it.
      console.error(`event confirmation for ${checkoutId} failed`, err);
      await ref.update({ confirmationError: String((err as Error).message ?? err).slice(0, 300), updatedAt: now() });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Confirmation email
// ---------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function whenLabel(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-SG', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(start);
  const t = (d: Date) =>
    new Intl.DateTimeFormat('en-SG', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d).replace(/\s?([ap])\.?m\.?$/i, ' $1m').toLowerCase();
  return `${day}, ${t(start)} to ${t(end)}`;
}

/** Google Calendar "add event" link (the event only, nothing about the buyer). */
export function calendarLink(title: string, start: Date, end: Date, venue: string | null): string {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${f(start)}/${f(end)}`, ...(venue ? { location: venue } : {}) });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export interface ConfirmationFacts {
  schoolName: string;
  firstName: string;
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  venue: string | null;
  qty: number;
  amountCents: number;
  currency: string;
  contactEmail: string | null;
}

export function renderConfirmation(o: ConfirmationFacts): { subject: string; text: string; html: string } {
  const tickets = `${o.qty} ${o.qty === 1 ? 'ticket' : 'tickets'}`;
  const when = whenLabel(o.start, o.end, o.timeZone);
  const where = o.venue ?? 'To be confirmed. We will email you the address before the day.';
  const paid = formatMoney(o.amountCents, o.currency);
  const cal = calendarLink(o.title, o.start, o.end, o.venue);
  const subject = `You're in: ${o.title}`;
  const text = [
    `Hi ${o.firstName},`,
    '',
    `Thanks for booking. Here ${o.qty === 1 ? 'is your ticket' : `are your ${tickets}`} for ${o.title}.`,
    '',
    `When: ${when}`,
    `Where: ${where}`,
    `Paid: ${paid}`,
    '',
    `Add it to your calendar: ${cal}`,
    '',
    ...(o.contactEmail ? [`Questions? Email ${o.contactEmail}.`] : []),
    o.schoolName,
  ].join('\n');
  const row = (k: string, v: string) => `<tr><td style="padding:6px 16px 6px 0;color:#55555a;vertical-align:top">${k}</td><td style="padding:6px 0">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#161616">
<div style="max-width:480px;margin:0 auto;background:#fbfbf9;border-radius:20px;padding:28px">
<p style="margin:0 0 4px;font-size:13px;color:#55555a">${esc(o.schoolName)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">You're in, ${esc(o.firstName)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${o.qty === 1 ? 'Your ticket' : `Your ${tickets}`} for <strong>${esc(o.title)}</strong>.</p>
<table style="font-size:15px;line-height:1.4;border-collapse:collapse;margin:0 0 20px">${row('When', when)}${row('Where', where)}${row('Paid', paid)}</table>
<p style="margin:0 0 20px"><a href="${esc(cal)}" style="display:inline-block;background:#161616;color:#f4f4f2;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px">Add to calendar</a></p>
${o.contactEmail ? `<p style="margin:0;font-size:13px;line-height:1.5;color:#55555a">Questions? Email <a href="mailto:${esc(o.contactEmail)}" style="color:#161616">${esc(o.contactEmail)}</a>.</p>` : ''}
</div></body></html>`;
  return { subject, text, html };
}

/** Emails the buyer their confirmation (once; `force` sends again, e.g. after a venue change). */
export async function sendEventConfirmation(
  db: Firestore,
  schoolId: string,
  checkoutId: string,
  sender: MailSender,
  defaultFrom: string,
  force = false,
): Promise<void> {
  const school = schoolRef(db, schoolId);
  const ref = school.collection('checkouts').doc(checkoutId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('kind') !== 'event') notFound('Order');
  if (snap.get('status') !== 'paid' && !snap.get('invoiceId')) throw new HttpsError('failed-precondition', 'This order is not paid');
  if (snap.get('confirmationSentAt') && !force) return;
  const [schoolSnap, ev, profile] = await db.getAll(school, school.collection('events').doc(snap.get('eventId') as string), school.collection('public').doc('profile'));
  if (!ev!.exists) notFound('Event');
  const mail = renderConfirmation({
    schoolName: schoolSnap!.get('name') as string,
    firstName: snap.get('buyer.firstName') as string,
    title: ev!.get('title') as string,
    start: (ev!.get('startAt') as Timestamp).toDate(),
    end: (ev!.get('endAt') as Timestamp).toDate(),
    timeZone: (ev!.get('timeZone') as string | undefined) ?? 'Asia/Singapore',
    venue: String(ev!.get('venue') ?? '').trim() || null,
    qty: snap.get('qty') as number,
    amountCents: snap.get('amountCents') as number,
    currency: (snap.get('currency') as string | undefined) ?? 'SGD',
    contactEmail: (profile!.get('contactEmail') as string | undefined) ?? null,
  });
  const from = (schoolSnap!.get('mail.from') as string | undefined) || defaultFrom;
  const sends = (snap.get('confirmationSends') as number | undefined) ?? 0;
  await sender.send({ from, to: [snap.get('buyer.email') as string], ...mail, idempotencyKey: `event-confirm/${checkoutId}/${sends}` });
  await ref.update({ confirmationSentAt: now(), confirmationSends: sends + 1, confirmationError: FieldValue.delete(), updatedAt: now() });
}

// ---------------------------------------------------------------------------------------------
// Lesson booking: an event's hosts are busy during it
// ---------------------------------------------------------------------------------------------

/** [start, end) of events (not cancelled) hosted by `teacherId` overlapping [fromMs, toMs). */
export async function eventsHeld(
  read: { query(q: Query): Promise<QuerySnapshot> },
  school: DocumentReference,
  teacherId: string,
  fromMs: number,
  toMs: number,
): Promise<{ eventId: string; startMs: number; endMs: number }[]> {
  // By time only (single-field index); events are few, so the host filter runs here.
  const snap = await read.query(
    school
      .collection('events')
      .where('startAt', '>', Timestamp.fromMillis(fromMs - MAX_EVENT_MS))
      .where('startAt', '<', Timestamp.fromMillis(toMs)),
  );
  return snap.docs
    .filter((d) => d.get('status') !== 'cancelled' && ((d.get('teacherIds') as string[] | undefined) ?? []).includes(teacherId))
    .map((d) => ({ eventId: d.id, startMs: (d.get('startAt') as Timestamp).toMillis(), endMs: (d.get('endAt') as Timestamp).toMillis() }))
    .filter((e) => e.endMs > fromMs);
}
