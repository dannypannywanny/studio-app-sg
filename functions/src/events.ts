// Event tickets (workshops, masterclasses) sold on the learn site to anyone, without an account.
//
// Staff create schools/{s}/events/{id} in the teach app: one page with one or more sessions (title,
// time, seats) and ticket options (one session, or a cheaper bundle of them), each with price tiers.
// startEventCheckout takes the buyer's option, name, email, phone and ticket count, holds the seats for
// EVENT_HOLD_MIN minutes in a checkouts/{id} doc (kind 'event'), and opens a HitPay payment request.
// When HitPay's webhook reports the payment (checkout.ts), completeEventCheckout links the buyer to a
// student record (an existing one with that email, else a new lead), raises a paid invoice for the
// tickets and emails a confirmation. Every step is idempotent, so HitPay's retries never double-sell.
//
// The event's time also blocks lesson booking for its hosts (eventsHeld, used by booking.ts).
import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type Query, type QuerySnapshot } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  DEFAULT_MAX_PER_ORDER,
  EVENT_HOLD_MIN,
  applyTax,
  currentTier,
  formatMoney,
  resolveTax,
  wallDateOf,
  type EventOption,
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

/** A session as stored on the event doc. */
export interface EventSessionDoc {
  key: string;
  title: string;
  summary?: string;
  startAt: Timestamp;
  endAt: Timestamp;
  capacity: number | null;
}

export interface StartEventCheckoutInput {
  eventId: string;
  /** Which ticket option (events/{id}.options[].key). */
  optionKey: string;
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
  /**
   * Buying as a signed-in student (claims.s for the site's school): name, email and phone come from
   * their record, the order is theirs from the start, and the privacy notice was agreed at sign-up.
   */
  studentId?: string | null;
}

/** Seats taken in one session: paid orders, plus unpaid ones still inside their hold. */
function seatsTaken(orders: QuerySnapshot, sessionKey: string, atMs: number): number {
  return orders.docs.reduce((n, d) => {
    const status = d.get('status') as string;
    const hold = (d.get('holdUntil') as Timestamp | undefined)?.toMillis() ?? 0;
    const counts = status === 'paid' || (status === 'pending' && hold > atMs);
    return counts && ((d.get('sessionKeys') as string[] | undefined) ?? []).includes(sessionKey) ? n + ((d.get('qty') as number) ?? 0) : n;
  }, 0);
}

interface Buyer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  marketing: boolean;
}

/** A guest types their details and agrees to the privacy notice. */
function checkGuest(input: StartEventCheckoutInput): void {
  if (!input.consent) throw new HttpsError('invalid-argument', 'Please agree to the privacy notice');
  if (!normalisePhone(input.phone)) throw new HttpsError('invalid-argument', 'Enter a phone number like 9123 4567 or +44 7700 900123');
  if (!input.firstName.trim()) throw new HttpsError('invalid-argument', 'Enter your first name');
}

function guestBuyer(input: StartEventCheckoutInput): Buyer {
  return {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: normalisePhone(input.phone)!,
    marketing: input.marketing === true,
  };
}

/** A signed-in student's details come from their record; a phone typed on the page fills a missing one. */
function studentBuyer(student: DocumentSnapshot, input: StartEventCheckoutInput): Buyer {
  if (!student.exists || student.get('status') === 'archived') throw new HttpsError('permission-denied', 'Your student account is not active. Buy as a guest instead.');
  const email = String(student.get('email') ?? '').trim().toLowerCase();
  if (!email) throw new HttpsError('failed-precondition', 'Your account has no email. Buy as a guest instead.');
  const phone = (student.get('phone') as string | null | undefined) || normalisePhone(input.phone ?? '');
  if (!phone) throw new HttpsError('invalid-argument', 'Enter a phone number like 9123 4567 or +44 7700 900123');
  return {
    firstName: String(student.get('preferredName') || student.get('firstName') || ''),
    lastName: String(student.get('lastName') ?? ''),
    email,
    phone,
    marketing: input.marketing === true,
  };
}

export async function startEventCheckout(
  db: Firestore,
  client: HitPayClient | null,
  input: StartEventCheckoutInput,
  at: Date = new Date(),
): Promise<{ checkoutId: string; url: string }> {
  const asStudent = input.studentId ?? null;
  if (!asStudent) checkGuest(input);
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
    const buyer = asStudent ? studentBuyer(await tx.get(school.collection('students').doc(asStudent)), input) : guestBuyer(input);
    if (ev.get('status') === 'cancelled') throw new HttpsError('failed-precondition', 'This event has been cancelled');
    const timeZone = (ev.get('timeZone') as string | undefined) ?? (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const option = ((ev.get('options') as EventOption[] | undefined) ?? []).find((o) => o.key === input.optionKey);
    if (!option) throw new HttpsError('invalid-argument', 'Pick which ticket you want');
    const sessions = (ev.get('sessions') as EventSessionDoc[] | undefined) ?? [];
    const mine = option.sessionKeys.map((k) => sessions.find((x) => x.key === k)).filter((x): x is EventSessionDoc => !!x);
    if (mine.some((x) => x.startAt.toMillis() <= at.getTime())) throw new HttpsError('failed-precondition', 'Ticket sales for this have closed');
    const onSale = currentTier(option.prices, at, timeZone);
    if (!onSale) throw new HttpsError('failed-precondition', 'Ticket sales for this event have closed');
    const maxPerOrder = (ev.get('maxPerOrder') as number | undefined) ?? DEFAULT_MAX_PER_ORDER;
    if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > maxPerOrder) {
      throw new HttpsError('invalid-argument', `You can buy 1 to ${maxPerOrder} tickets at a time`);
    }
    const capped = mine.filter((x) => typeof x.capacity === 'number');
    if (capped.length) {
      const orders = await tx.get(school.collection('checkouts').where('eventId', '==', input.eventId));
      for (const x of capped) {
        const left = x.capacity! - seatsTaken(orders, x.key, at.getTime());
        if (left < input.qty) {
          const what = mine.length > 1 ? ` in ${x.title}` : '';
          throw new HttpsError('resource-exhausted', left > 0 ? `Only ${left} ${left === 1 ? 'seat is' : 'seats are'} left${what}` : `Sorry, ${x.title} is sold out`);
        }
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
      optionKey: option.key,
      optionLabel: option.label,
      sessionKeys: option.sessionKeys,
      qty: input.qty,
      tierLabel: onSale.tier.label,
      unitCents: onSale.tier.priceCents,
      subtotalCents,
      taxCents,
      amountCents: totalCents,
      currency,
      buyer,
      consentAt: asStudent ? null : Timestamp.fromDate(at),
      studentId: asStudent,
      status: 'pending',
      holdUntil: Timestamp.fromMillis(at.getTime() + EVENT_HOLD_MIN * 60_000),
      provider: 'hitpay',
      createdBy: asStudent ? 'student' : 'public',
      createdAt: now(),
      updatedAt: now(),
    });
    return { totalCents, currency, buyer, title: `${ev.get('title') as string} (${option.label})`, schoolName: schoolSnap.get('name') as string };
  });

  const req = await client.createPaymentRequest({
    amount: (order.totalCents / 100).toFixed(2),
    currency: order.currency,
    email: order.buyer.email,
    name: [order.buyer.firstName, order.buyer.lastName].filter(Boolean).join(' '),
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
): Promise<{ status: string; qty: number; optionLabel: string | null; email: string | null }> {
  const site = await db.collection('publicSchools').doc(input.host).get();
  if (!site.exists) notFound('Order');
  const snap = await schoolRef(db, site.get('schoolId') as string).collection('checkouts').doc(input.orderId).get();
  if (!snap.exists || snap.get('kind') !== 'event' || snap.get('eventId') !== input.eventId) notFound('Order');
  const email = String(snap.get('buyer.email') ?? '');
  // Masked ("da***@gmail.com") so a shared link doesn't give the address away.
  return {
    status: snap.get('status') as string,
    qty: snap.get('qty') as number,
    optionLabel: (snap.get('optionLabel') as string | undefined) ?? null,
    email: email ? email.replace(/^(.{0,2})[^@]*/, '$1***') : null,
  };
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
    // Bought signed in: that student. Otherwise anyone on file with the buyer's email.
    const ownerId = snap.get('studentId') as string | null;
    const owner = ownerId ? await tx.get(school.collection('students').doc(ownerId)) : null;
    const onFile =
      owner?.exists && owner.get('status') !== 'archived'
        ? [owner]
        : (await tx.get(school.collection('students').where('email', '==', buyer.email))).docs.filter((d) => d.get('status') !== 'archived');
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
      lines: [
        {
          desc: `${title}: ${snap.get('optionLabel')} · ${snap.get('tierLabel')} ticket`,
          qty,
          unitCents: snap.get('unitCents'),
          eventId: snap.get('eventId'),
          optionKey: snap.get('optionKey'),
        },
      ],
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
    if (ev.exists) {
      const sold = Object.fromEntries(((snap.get('sessionKeys') as string[] | undefined) ?? []).map((k) => [`soldBySession.${k}`, FieldValue.increment(qty)]));
      tx.update(eventRef, { ...sold, soldQty: FieldValue.increment(qty), updatedAt: now() });
    }
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
  /** The sessions this ticket admits to, in time order. */
  sessions: { title: string; start: Date; end: Date }[];
  timeZone: string;
  venue: string | null;
  qty: number;
  amountCents: number;
  currency: string;
  contactEmail: string | null;
}

export function renderConfirmation(o: ConfirmationFacts): { subject: string; text: string; html: string } {
  const tickets = `${o.qty} ${o.qty === 1 ? 'ticket' : 'tickets'}`;
  const one = o.sessions.length === 1;
  // One session: its day and time. Several: the day, then each session's time on its own line.
  const day = (d: Date) => new Intl.DateTimeFormat('en-SG', { timeZone: o.timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const when = one ? whenLabel(o.sessions[0]!.start, o.sessions[0]!.end, o.timeZone) : day(o.sessions[0]!.start);
  const lineup = one ? [] : o.sessions.map((x) => `${x.title}: ${whenLabel(x.start, x.end, o.timeZone).split(', ').slice(-1)[0]}`);
  const where = o.venue ?? 'To be confirmed. We will email you the address before the day.';
  const paid = formatMoney(o.amountCents, o.currency);
  const first = o.sessions[0]!;
  const last = o.sessions[o.sessions.length - 1]!;
  const cal = calendarLink(one ? `${o.title}: ${first.title}` : o.title, first.start, last.end, o.venue);
  const subject = `You're in: ${one ? first.title : o.title}`;
  const text = [
    `Hi ${o.firstName},`,
    '',
    `Thanks for booking. Here ${o.qty === 1 ? 'is your ticket' : `are your ${tickets}`} for ${one ? first.title : o.title}.`,
    '',
    `When: ${when}`,
    ...lineup.map((l) => `  ${l}`),
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
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${o.qty === 1 ? 'Your ticket' : `Your ${tickets}`} for <strong>${esc(one ? first.title : o.title)}</strong>${one && first.title !== o.title ? ` at ${esc(o.title)}` : ''}.</p>
<table style="font-size:15px;line-height:1.4;border-collapse:collapse;margin:0 0 20px">${row('When', when)}${lineup.map((l) => row('', l)).join('')}${row('Where', where)}${row('Paid', paid)}</table>
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
    sessions: ((ev!.get('sessions') as EventSessionDoc[] | undefined) ?? [])
      .filter((x) => ((snap.get('sessionKeys') as string[] | undefined) ?? []).includes(x.key))
      .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis())
      .map((x) => ({ title: x.title, start: x.startAt.toDate(), end: x.endAt.toDate() })),
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
