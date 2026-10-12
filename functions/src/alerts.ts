// Owner email alerts (replaces Classcard's booking / cancellation / payment emails).
//
// Outbox: the function that makes a change also writes `schools/{s}/alerts/{alertId}` in the same
// transaction (enqueueAlert: one write, no reads, so it can't fail or slow the money/credit change).
// The alertId is derived from the change (payment id, attendee rev, ...), so one change = one alert doc.
// A Firestore trigger then calls deliverAlert, which renders and sends it with Resend:
//   - status pending -> sent | skipped | failed; anything but pending is never sent again;
//   - Resend's Idempotency-Key is `${schoolId}/${alertId}`, so a retry after a crash between "sent" and
//     "marked sent" doesn't email twice (Resend keeps keys 24h);
//   - transient errors (network, 429, 5xx) throw so the trigger retries; after MAX_ATTEMPTS, or on a
//     permanent error (bad key, unverified domain), the doc is marked failed and left for a human.
//
// The doc holds ids, times and amounts only. Names are read at send time, and emails carry no student
// data beyond name, lesson time and amount.
import { Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  ALERT_TYPES,
  formatDate,
  formatDateTime,
  formatMoney,
  resolveAlertSettings,
  type AlertType,
} from '@lessonkaki/shared';
import type { Charge } from './attendance';
import { now, schoolRef, type Actor } from './db';

export const MAX_ATTEMPTS = 5;
/** Alert docs are deleted by a Firestore TTL policy on `expireAt` (set up once per project). */
const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export type BookingSource = 'admin' | 'portal' | 'booking';

/** How a booking was paid, when the booking itself takes payment (online booking, M5). */
export interface BookingPayment {
  status: 'paid' | 'unpaid';
  amountCents: number;
  currency: string;
  invoiceId: string | null;
}

interface PaymentFields {
  invoiceId: string;
  invoiceNumber: string;
  studentId: string;
  amountCents: number;
  currency: string;
  method: string;
  pendingCents: number;
  overpaymentCents: number;
}

export type AlertEvent =
  | {
      type: 'lesson.booked';
      lessonId: string;
      studentIds: string[];
      startAt: Date;
      source: BookingSource;
      /** null = the lesson will use credits when attendance is marked (or be owed). */
      payment?: BookingPayment | null;
    }
  | { type: 'series.booked'; seriesId: string; studentIds: string[]; firstStartAt: Date; lessons: number; byDay: string[] }
  | { type: 'attendee.cancelled'; lessonId: string; studentId: string; startAt: Date; late: boolean; charge: Charge; byStudent: boolean }
  | { type: 'attendee.removed'; lessonId: string; studentId: string; startAt: Date; charge: Charge }
  | { type: 'lesson.cancelled'; lessonId: string; studentIds: string[]; startAt: Date; restored: number; reason: string | null }
  | {
      type: 'series.cancelled';
      seriesId: string;
      studentIds: string[];
      fromDate: string;
      cancelled: number;
      deleted: number;
      restored: number;
      reason: string | null;
    }
  | ({ type: 'payment.recorded'; paymentId: string } & PaymentFields)
  | ({ type: 'payment.succeeded'; paymentId: string; provider: string } & PaymentFields)
  | {
      type: 'payment.failed' | 'payment.abandoned';
      provider: string;
      invoiceId: string | null;
      invoiceNumber: string | null;
      /** A public booking may not have a student yet; then the guest's name comes from the booking. */
      studentId: string | null;
      bookingId: string | null;
      amountCents: number;
      currency: string;
      reason: string | null;
    };

/**
 * Writes the alert in the caller's transaction. `set`, not `create`: the id is unique per change, and if
 * it ever collided the change must still go through (the trigger only fires on create, so no resend).
 */
export function enqueueAlert(tx: Transaction, school: DocumentReference, alertId: string, event: AlertEvent, actor: Actor, at: Date): void {
  const { type, ...data } = event;
  tx.set(school.collection('alerts').doc(alertId), {
    type,
    category: ALERT_TYPES[type],
    data,
    actorUid: actor.uid,
    actorRole: actor.role,
    status: 'pending',
    attempts: 0,
    createdAt: now(),
    expireAt: Timestamp.fromMillis(at.getTime() + RETENTION_DAYS * DAY_MS),
  });
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface OutgoingMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface MailSender {
  send(mail: OutgoingMail): Promise<{ id: string }>;
}

export class SendError extends Error {
  constructor(
    message: string,
    /** Retrying won't help (bad key, unverified sender, invalid address). */
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

const RESEND_URL = 'https://api.resend.com/emails';

/** Resend over plain fetch (no SDK dependency). */
export function resendSender(apiKey: string, fetchFn: typeof fetch = fetch): MailSender {
  return {
    async send(mail) {
      let res: Response;
      try {
        res = await fetchFn(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': mail.idempotencyKey,
          },
          body: JSON.stringify({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
        });
      } catch (err) {
        throw new SendError(`Resend unreachable: ${(err as Error).message}`, false);
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (res.ok && body.id) return { id: body.id };
      // 409: the same key is still in flight (or reused); 429: rate limit. Both clear up on a retry.
      const permanent = res.status < 500 && res.status !== 409 && res.status !== 429;
      throw new SendError(`Resend ${res.status} ${body.name ?? ''}: ${body.message ?? 'no message'}`, permanent);
    },
  };
}

export type DeliverOutcome = 'sent' | 'skipped' | 'failed' | 'noop';

export interface DeliverOptions {
  /** Sender when the school has no verified `mail.from` of its own. */
  defaultFrom: string;
}

/** Sends one alert (the trigger's body). Throws only to ask for a retry. */
export async function deliverAlert(
  db: Firestore,
  sender: MailSender | null,
  schoolId: string,
  alertId: string,
  opts: DeliverOptions,
): Promise<DeliverOutcome> {
  const school = schoolRef(db, schoolId);
  const ref = school.collection('alerts').doc(alertId);
  const [alertSnap, schoolSnap] = await Promise.all([ref.get(), school.get()]);
  if (!alertSnap.exists || alertSnap.get('status') !== 'pending') return 'noop';
  const alert = alertSnap.data()!;
  const settings = resolveAlertSettings(schoolSnap.get('alerts'), schoolSnap.get('email') as string | undefined);

  const skip = async (reason: string): Promise<DeliverOutcome> => {
    await ref.update({ status: 'skipped', skipReason: reason, updatedAt: now() });
    return 'skipped';
  };
  const category = alert.category as keyof typeof settings.events;
  if (!settings.events[category]) return skip('turned off in Settings');
  if (settings.skipStaffActions && (alert.actorRole === 'owner' || alert.actorRole === 'admin')) {
    return skip('staff action');
  }
  if (settings.to.length === 0) return skip('no recipients');

  const attempts = ((alert.attempts as number | undefined) ?? 0) + 1;
  const fail = async (error: string): Promise<DeliverOutcome> => {
    console.error(`alert ${schoolId}/${alertId} failed: ${error}`);
    await ref.update({ status: 'failed', attempts, lastError: error, updatedAt: now() });
    return 'failed';
  };
  if (!sender) return fail('Email is not set up (no RESEND_API_KEY)');

  const content = await renderAlert(db, schoolId, alert.type as AlertType, alert.data as Record<string, unknown>, schoolSnap.data() ?? {});
  try {
    const { id } = await sender.send({
      from: (schoolSnap.get('mail.from') as string | undefined) || opts.defaultFrom,
      to: settings.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      idempotencyKey: `${schoolId}/${alertId}`,
    });
    await ref.update({ status: 'sent', attempts, providerId: id, sentTo: settings.to.length, sentAt: now(), updatedAt: now() });
    return 'sent';
  } catch (err) {
    const permanent = err instanceof SendError ? err.permanent : false;
    const message = (err as Error).message;
    if (permanent || attempts >= MAX_ATTEMPTS) return fail(message);
    await ref.update({ attempts, lastError: message, updatedAt: now() });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

export interface RenderedAlert {
  subject: string;
  /** Plain lines; the html is the same lines, escaped. */
  lines: string[];
  link: { label: string; url: string } | null;
  text: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const METHOD_LABELS: Record<string, string> = { paynow: 'PayNow', bank: 'bank transfer', cash: 'cash', card_hitpay: 'card (HitPay)' };
const DAY_LABELS: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

function toDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate();
  if (v instanceof Date) return v;
  return new Date(v as string);
}

interface StudentInfo {
  name: string;
  available: number;
}

async function readStudents(db: Firestore, schoolId: string, ids: string[]): Promise<Map<string, StudentInfo>> {
  const out = new Map<string, StudentInfo>();
  if (ids.length === 0) return out;
  const refs = [...new Set(ids)].map((id) => schoolRef(db, schoolId).collection('students').doc(id));
  for (const snap of await db.getAll(...refs)) {
    if (!snap.exists) continue;
    const first = (snap.get('preferredName') as string | undefined) || (snap.get('firstName') as string | undefined) || '';
    const name = `${first} ${(snap.get('lastName') as string | undefined) ?? ''}`.trim() || 'A student';
    out.set(snap.id, { name, available: (snap.get('summary.sessionsAvailable') as number | undefined) ?? 0 });
  }
  return out;
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? 'no students') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function chargeLine(charge: Charge, late: boolean): string | null {
  switch (charge) {
    case 'restored':
      return 'The credit went back to the student.';
    case 'restoredExpired':
      return 'The credit went back, but its package has expired.';
    case 'debited':
      return 'Late cancel: one credit was used.';
    case 'owed':
      return 'Late cancel: recorded as an owed lesson (no credits left).';
    default:
      return late ? 'Late cancel.' : null;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Builds the email for one alert. Reads student names (and a guest's name for booking payments). */
export async function renderAlert(
  db: Firestore,
  schoolId: string,
  type: AlertType,
  data: Record<string, unknown>,
  school: Record<string, unknown>,
): Promise<RenderedAlert> {
  const tz = (school.timezone as string | undefined) ?? 'Asia/Singapore';
  const schoolName = (school.name as string | undefined) ?? 'your studio';
  const teachHost = (school.hosts as { teach?: string | null } | undefined)?.teach ?? null;
  const when = (v: unknown) => formatDateTime(toDate(v), tz);
  const money = (cents: unknown, currency: unknown) => formatMoney(cents as number, (currency as string | undefined) ?? 'SGD');

  const studentIds = (data.studentIds as string[] | undefined) ?? [];
  const students = await readStudents(db, schoolId, [...studentIds, ...(typeof data.studentId === 'string' ? [data.studentId] : [])]);
  const nameOf = (id: string) => students.get(id)?.name ?? 'A student';
  const names = joinNames(studentIds.map(nameOf));

  let subject: string;
  const lines: string[] = [];
  let path: { label: string; path: string } | null = null;

  switch (type) {
    case 'lesson.booked': {
      subject = `Booked: ${names}, ${when(data.startAt)}`;
      lines.push(`Lesson: ${when(data.startAt)}`);
      const payment = data.payment as BookingPayment | null | undefined;
      if (payment) {
        lines.push(
          payment.status === 'paid'
            ? `${names}: paid ${money(payment.amountCents, payment.currency)} online.`
            : `${names}: not paid yet, ${money(payment.amountCents, payment.currency)} due.`,
        );
      } else {
        for (const id of studentIds) {
          const s = students.get(id);
          if (!s) continue;
          lines.push(
            s.available > 0
              ? `${s.name}: ${plural(s.available, 'credit', 'credits')} left (one is used when attendance is marked).`
              : `${s.name}: no credits left, so the lesson will be recorded as owed.`,
          );
        }
      }
      if (data.source === 'booking') lines.push('Booked on the online booking page.');
      else if (data.source === 'portal') lines.push('Booked by the student in the portal.');
      path = { label: 'Open the lesson', path: `lessons/${data.lessonId as string}` };
      break;
    }
    case 'series.booked': {
      const days = (data.byDay as string[]).map((d) => DAY_LABELS[d] ?? d).join(', ');
      subject = `Weekly lessons booked: ${names}`;
      lines.push(`Every ${days}, starting ${when(data.firstStartAt)}.`);
      lines.push(`${plural(data.lessons as number, 'lesson is', 'lessons are')} on the calendar so far; more are added as the weeks go by.`);
      path = { label: 'Open the calendar', path: 'calendar' };
      break;
    }
    case 'attendee.cancelled': {
      const name = nameOf(data.studentId as string);
      const late = data.late === true;
      subject = `${late ? 'Late cancel' : 'Cancelled'}: ${name}, ${when(data.startAt)}`;
      lines.push(`${name} ${data.byStudent ? 'cancelled the lesson' : 'was cancelled from the lesson'} on ${when(data.startAt)}.`);
      const c = chargeLine(data.charge as Charge, late);
      if (c) lines.push(c);
      path = { label: 'Open the lesson', path: `lessons/${data.lessonId as string}` };
      break;
    }
    case 'attendee.removed': {
      const name = nameOf(data.studentId as string);
      subject = `Removed from lesson: ${name}, ${when(data.startAt)}`;
      lines.push(`${name} was taken off the lesson on ${when(data.startAt)}.`);
      const c = chargeLine(data.charge as Charge, false);
      if (c) lines.push(c);
      path = { label: 'Open the lesson', path: `lessons/${data.lessonId as string}` };
      break;
    }
    case 'lesson.cancelled': {
      subject = `Lesson cancelled: ${when(data.startAt)} (${names})`;
      lines.push(`The lesson on ${when(data.startAt)} with ${names} was cancelled.`);
      const restored = data.restored as number;
      if (restored > 0) lines.push(`${plural(restored, 'credit was', 'credits were')} given back.`);
      if (data.reason) lines.push(`Reason: ${data.reason as string}`);
      path = { label: 'Open the lesson', path: `lessons/${data.lessonId as string}` };
      break;
    }
    case 'series.cancelled': {
      const n = (data.cancelled as number) + (data.deleted as number);
      subject = `Weekly lessons ended: ${names}`;
      lines.push(`Weekly lessons with ${names} are cancelled from ${formatDate(new Date(`${data.fromDate as string}T12:00:00Z`), tz)} on.`);
      lines.push(`${plural(n, 'upcoming lesson was', 'upcoming lessons were')} taken off the calendar.`);
      const restored = data.restored as number;
      if (restored > 0) lines.push(`${plural(restored, 'credit was', 'credits were')} given back.`);
      if (data.reason) lines.push(`Reason: ${data.reason as string}`);
      path = { label: 'Open the calendar', path: 'calendar' };
      break;
    }
    case 'payment.recorded':
    case 'payment.succeeded': {
      const name = nameOf(data.studentId as string);
      const amount = money(data.amountCents, data.currency);
      subject = `${type === 'payment.succeeded' ? 'Payment received' : 'Payment recorded'}: ${amount} from ${name}`;
      lines.push(`${amount} by ${METHOD_LABELS[data.method as string] ?? (data.method as string)} for invoice ${data.invoiceNumber as string}.`);
      const pending = data.pendingCents as number;
      lines.push(pending > 0 ? `${money(pending, data.currency)} is still due on this invoice.` : 'The invoice is now paid in full.');
      const over = data.overpaymentCents as number;
      if (over > 0) lines.push(`${money(over, data.currency)} extra was kept as credit for the next invoice.`);
      path = { label: 'Open the invoice', path: `invoices/${data.invoiceId as string}` };
      break;
    }
    case 'payment.failed':
    case 'payment.abandoned': {
      let who = typeof data.studentId === 'string' ? nameOf(data.studentId) : null;
      if (!who && typeof data.bookingId === 'string') {
        const booking = await schoolRef(db, schoolId).collection('bookings').doc(data.bookingId).get();
        who = (booking.get('guest.name') as string | undefined) ?? null;
      }
      who ??= 'A guest';
      const amount = money(data.amountCents, data.currency);
      subject = `${type === 'payment.failed' ? 'Payment failed' : 'Payment not completed'}: ${amount} from ${who}`;
      lines.push(
        type === 'payment.failed'
          ? `An online payment of ${amount} from ${who} did not go through.`
          : `${who} started paying ${amount} online but did not finish.`,
      );
      if (data.invoiceNumber) lines.push(`Invoice: ${data.invoiceNumber as string}`);
      if (data.reason) lines.push(`Reason given: ${data.reason as string}`);
      path = data.invoiceId ? { label: 'Open the invoice', path: `invoices/${data.invoiceId as string}` } : null;
      break;
    }
  }

  const link = path && teachHost ? { label: path.label, url: `https://${teachHost}/${path.path}` } : null;
  const footer = `You get these emails because they are switched on in ${schoolName}'s LessonKaki settings.`;
  const text = [...lines, ...(link ? ['', `${link.label}: ${link.url}`] : []), '', footer].join('\n');
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f1a24">',
    ...lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`),
    link ? `<p style="margin:16px 0"><a href="${esc(link.url)}">${esc(link.label)}</a></p>` : '',
    `<p style="margin:24px 0 0;font-size:12px;color:#6b6475">${esc(footer)}</p>`,
    '</div>',
  ].join('');
  return { subject, lines, link, text, html };
}
