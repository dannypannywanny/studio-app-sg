// Scheduled student reminders (see shared/reminders.ts for the settings).
//
// Lessons (hourly): every booked student on a scheduled lesson starting within `lessonHoursBefore` hours gets one
// email; the attendee doc records reminderSentAt so a later run (or a retry) never sends it again.
// Payments (daily): an open invoice gets one "due soon" email `dueSoonDays` before the due date, then an overdue
// email every `overdueEveryDays` until `overdueMax`. The invoice records what was sent (reminders.*).
// Resend's idempotency key is derived from the doc and the reminder, so a crash between send and mark is safe.
import { Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { formatDate, formatDateTime, formatMoney, resolveReminders, type ReminderSettings } from '@lessonkaki/shared';
import type { MailSender } from './alerts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface SchoolCtx {
  id: string;
  name: string;
  from: string;
  tz: string;
  learn: string | null;
  replyTo: string | null;
  settings: ReminderSettings;
}

function ctxOf(s: DocumentSnapshot, defaultFrom: string): SchoolCtx {
  const learn = (s.get('hosts.learn') as string | null | undefined) ?? null;
  return {
    id: s.id,
    name: (s.get('name') as string | undefined) ?? 'Your studio',
    from: (s.get('mail.from') as string | undefined) || defaultFrom,
    tz: (s.get('timezone') as string | undefined) ?? 'Asia/Singapore',
    learn: learn ? `https://${learn}` : null,
    replyTo: (s.get('email') as string | undefined) ?? null,
    settings: resolveReminders(s.get('reminders')),
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function render(school: SchoolCtx, subject: string, lines: string[], cta: { label: string; href: string } | null) {
  const text = [...lines, ...(cta ? ['', `${cta.label}: ${cta.href}`] : []), '', `— ${school.name}`].join('\n');
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.55;color:#161616;max-width:520px">` +
    lines.map((l) => (l ? `<p style="margin:0 0 10px">${esc(l)}</p>` : '')).join('') +
    (cta
      ? `<p style="margin:18px 0"><a href="${esc(cta.href)}" style="background:#c9ad92;color:#161616;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>`
      : '') +
    `<p style="margin:18px 0 0;color:#5c5c60">— ${esc(school.name)}</p></div>`;
  return { subject, text, html };
}

export function lessonReminderEmail(
  school: SchoolCtx,
  p: { firstName: string; startAt: Date; durationMin: number; teacher: string | null; where: string },
) {
  const when = formatDateTime(p.startAt, school.tz);
  return render(
    school,
    `Reminder: your lesson on ${when}`,
    [
      `Hi ${p.firstName},`,
      `This is a reminder of your ${p.durationMin}-minute lesson on ${when}${p.teacher ? ` with ${p.teacher}` : ''} (${p.where}).`,
      'If you need to cancel or move it, please do so as early as you can.',
    ],
    school.learn ? { label: 'See my lessons', href: `${school.learn}/` } : null,
  );
}

export function paymentReminderEmail(
  school: SchoolCtx,
  p: { firstName: string; number: string; pendingCents: number; currency: string; dueDate: Date; overdue: boolean; invoiceId: string },
) {
  const amount = formatMoney(p.pendingCents, p.currency);
  const due = formatDate(p.dueDate, school.tz);
  return render(
    school,
    p.overdue ? `Invoice ${p.number} is overdue (${amount})` : `Invoice ${p.number} is due on ${due}`,
    [
      `Hi ${p.firstName},`,
      p.overdue
        ? `Invoice ${p.number} for ${amount} was due on ${due} and is still unpaid.`
        : `A friendly reminder that invoice ${p.number} for ${amount} is due on ${due}.`,
      'You can pay by PayNow using the QR code on the invoice. If you have already paid, thank you, and please ignore this email.',
    ],
    school.learn ? { label: 'View invoice', href: `${school.learn}/payments/${p.invoiceId}` } : null,
  );
}

async function schoolsWith(db: Firestore, field: 'reminders.lessons' | 'reminders.payments', defaultFrom: string) {
  return (await db.collection('schools').where(field, '==', true).get()).docs.map((s) => ctxOf(s, defaultFrom));
}

export async function runLessonReminders(db: Firestore, sender: MailSender, defaultFrom: string, at = new Date()) {
  let sent = 0;
  for (const school of await schoolsWith(db, 'reminders.lessons', defaultFrom)) {
    const ref = db.collection('schools').doc(school.id);
    const lessons = await ref
      .collection('lessons')
      .where('startAt', '>', Timestamp.fromDate(at))
      .where('startAt', '<=', Timestamp.fromMillis(at.getTime() + school.settings.lessonHoursBefore * HOUR))
      .get();
    for (const l of lessons.docs) {
      if (l.get('status') !== 'scheduled') continue;
      const attendees = (await l.ref.collection('attendees').where('status', '==', 'booked').get()).docs.filter((a) => !a.get('reminderSentAt'));
      if (!attendees.length) continue;
      const [teacher, place] = await Promise.all([
        ref.collection('teachers').doc(l.get('teacherId') as string).get(),
        l.get('locationId') ? ref.collection('locations').doc(l.get('locationId') as string).get() : Promise.resolve(null),
      ]);
      for (const a of attendees) {
        const student = await ref.collection('students').doc(a.id).get();
        const email = (student.get('email') as string | undefined)?.trim();
        if (!email || student.get('status') === 'archived') {
          await a.ref.update({ reminderSentAt: Timestamp.fromDate(at), reminderSkipped: 'no email' });
          continue;
        }
        const mail = lessonReminderEmail(school, {
          firstName: (student.get('preferredName') as string) || (student.get('firstName') as string) || 'there',
          startAt: (l.get('startAt') as Timestamp).toDate(),
          durationMin: l.get('durationMin') as number,
          teacher: (teacher.get('publicName') as string) || ((teacher.get('displayName') as string | undefined)?.split(' ')[0] ?? null),
          where: l.get('isOnline') ? 'online' : ((place?.get('address') as string | undefined) ?? (place?.get('name') as string | undefined) ?? 'at the studio'),
        });
        await sender.send({ from: school.from, to: [email], ...mail, idempotencyKey: `remind-lesson/${school.id}/${l.id}/${a.id}` });
        await a.ref.update({ reminderSentAt: Timestamp.fromDate(at) });
        sent++;
      }
    }
  }
  return { sent };
}

export async function runPaymentReminders(db: Firestore, sender: MailSender, defaultFrom: string, at = new Date()) {
  let sent = 0;
  for (const school of await schoolsWith(db, 'reminders.payments', defaultFrom)) {
    const ref = db.collection('schools').doc(school.id);
    const s = school.settings;
    const open = await ref.collection('invoices').where('status', 'in', ['sent', 'partial']).get();
    for (const inv of open.docs) {
      const pending = inv.get('pendingCents') as number;
      if (!pending) continue;
      const due = (inv.get('dueDate') as Timestamp).toDate();
      const r = (inv.get('reminders') ?? {}) as { dueSoonAt?: Timestamp; overdueCount?: number; lastOverdueAt?: Timestamp };
      const overdue = due.getTime() + DAY <= at.getTime();
      let kind: 'dueSoon' | 'overdue' | null = null;
      if (!overdue && !r.dueSoonAt && due.getTime() - at.getTime() <= s.dueSoonDays * DAY) kind = 'dueSoon';
      if (overdue && (r.overdueCount ?? 0) < s.overdueMax && (!r.lastOverdueAt || at.getTime() - r.lastOverdueAt.toMillis() >= s.overdueEveryDays * DAY - HOUR)) {
        kind = 'overdue';
      }
      if (!kind) continue;
      const student = await ref.collection('students').doc(inv.get('studentId') as string).get();
      const email = (student.get('email') as string | undefined)?.trim();
      const stamp = Timestamp.fromDate(at);
      const mark =
        kind === 'dueSoon'
          ? { 'reminders.dueSoonAt': stamp }
          : { 'reminders.lastOverdueAt': stamp, 'reminders.overdueCount': (r.overdueCount ?? 0) + 1 };
      if (!email || student.get('status') === 'archived') {
        await inv.ref.update(mark);
        continue;
      }
      const mail = paymentReminderEmail(school, {
        firstName: (student.get('preferredName') as string) || (student.get('firstName') as string) || 'there',
        number: inv.get('number') as string,
        pendingCents: pending,
        currency: (inv.get('currency') as string | undefined) ?? 'SGD',
        dueDate: due,
        overdue: kind === 'overdue',
        invoiceId: inv.id,
      });
      const n = kind === 'dueSoon' ? 'soon' : `overdue${(r.overdueCount ?? 0) + 1}`;
      await sender.send({ from: school.from, to: [email], ...mail, idempotencyKey: `remind-pay/${school.id}/${inv.id}/${n}` });
      await inv.ref.update(mark);
      sent++;
    }
  }
  return { sent };
}
