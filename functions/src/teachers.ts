// Teacher logins: what a teacher may see, and teacher pay.
//
// teacherRoster: teachers can't read student records (PDPA: data minimisation), so this returns just the name
// and staff notes of students on the teacher's own lessons (last 180 days and next 90).
//
// teacherPay: per teacher over a period. teachers/{id}.pay = { method, rateCents?, percent? }:
//  - perLesson: rateCents per lesson taught (a lesson counts if anyone was present, absent or late-cancelled
//    and charged; on-time cancels and studio cancels don't);
//  - hourly: rateCents per hour of those lessons;
//  - percent: percent of the value of the credits those lessons used (the package's invoice total / sessions).
import { HttpsError } from 'firebase-functions/v2/https';
import { Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { notFound, schoolRef, type Actor } from './db';

const DAY = 86_400_000;
const PAID_STATUSES = new Set(['present', 'absent', 'lateCancelled']);

export type PayMethod = 'perLesson' | 'hourly' | 'percent';
export interface PaySettings {
  method: PayMethod;
  rateCents: number;
  percent: number;
}

export function resolvePay(raw: unknown): PaySettings | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.method !== 'perLesson' && r.method !== 'hourly' && r.method !== 'percent') return null;
  const rate = typeof r.rateCents === 'number' && r.rateCents >= 0 ? Math.round(r.rateCents) : 0;
  const pct = typeof r.percent === 'number' && r.percent >= 0 && r.percent <= 100 ? r.percent : 0;
  return { method: r.method, rateCents: rate, percent: pct };
}

function ownTeacher(actor: Actor, teacherId: string | null | undefined): string | null {
  if (actor.role === 'teacher') {
    if (!actor.teacherId) throw new HttpsError('permission-denied', 'This login is not linked to a teacher');
    if (teacherId && teacherId !== actor.teacherId) throw new HttpsError('permission-denied', 'Teachers see only their own');
    return actor.teacherId;
  }
  return teacherId ?? null;
}

export async function teacherRoster(db: Firestore, input: { schoolId: string }, actor: Actor, at = new Date()) {
  const teacherId = ownTeacher(actor, null);
  if (!teacherId) throw new HttpsError('invalid-argument', 'Only for teacher logins');
  const school = schoolRef(db, input.schoolId);
  const lessons = await school
    .collection('lessons')
    .where('teacherId', '==', teacherId)
    .where('startAt', '>=', Timestamp.fromMillis(at.getTime() - 180 * DAY))
    .where('startAt', '<', Timestamp.fromMillis(at.getTime() + 90 * DAY))
    .get();
  const ids = [...new Set(lessons.docs.flatMap((l) => (l.get('studentIds') as string[]) ?? []))];
  const snaps = ids.length ? await db.getAll(...ids.map((id) => school.collection('students').doc(id))) : [];
  return {
    students: snaps
      .filter((s) => s.exists)
      .map((s) => ({
        id: s.id,
        firstName: (s.get('firstName') as string) ?? '',
        lastName: (s.get('lastName') as string) ?? '',
        preferredName: (s.get('preferredName') as string | null) ?? null,
        notes: (s.get('notes') as string | undefined) ?? '',
        status: (s.get('status') as string) ?? 'active',
      })),
  };
}

export interface PayRow {
  teacherId: string;
  name: string;
  pay: PaySettings | null;
  lessons: number;
  minutes: number;
  creditValueCents: number;
  amountCents: number;
  /** Credits whose value couldn't be worked out (no invoice), for percent pay. */
  unvalued: number;
}

export async function teacherPay(
  db: Firestore,
  input: { schoolId: string; from: string; to: string; teacherId?: string | null },
  actor: Actor,
): Promise<{ rows: PayRow[] }> {
  const teacherId = ownTeacher(actor, input.teacherId);
  const school = schoolRef(db, input.schoolId);
  const from = Timestamp.fromDate(new Date(input.from));
  const to = Timestamp.fromDate(new Date(input.to));
  if (to.toMillis() <= from.toMillis() || to.toMillis() - from.toMillis() > 400 * DAY) throw new HttpsError('invalid-argument', 'Pick a period up to a year');
  let q = school.collection('lessons').where('startAt', '>=', from).where('startAt', '<', to);
  if (teacherId) q = q.where('teacherId', '==', teacherId);
  const lessons = (await q.get()).docs.filter((l) => l.get('status') !== 'cancelled');

  const teacherIds = [...new Set(lessons.map((l) => l.get('teacherId') as string).concat(teacherId ? [teacherId] : []))];
  const teacherSnaps = teacherIds.length ? await db.getAll(...teacherIds.map((id) => school.collection('teachers').doc(id))) : [];
  const teachers = new Map(teacherSnaps.map((t) => [t.id, t]));

  // Charged attendees per lesson, and the value of each credit used.
  const lotValue = new Map<string, number | null>();
  async function valueOf(enrolmentId: string): Promise<number | null> {
    if (lotValue.has(enrolmentId)) return lotValue.get(enrolmentId)!;
    const lot = await school.collection('enrolments').doc(enrolmentId).get();
    let v: number | null = null;
    const invoiceId = lot.get('invoiceId') as string | null | undefined;
    const sessions = (lot.get('sessionsTotal') as number | undefined) ?? 0;
    if (invoiceId && sessions > 0) {
      const inv = await school.collection('invoices').doc(invoiceId).get();
      if (inv.exists && inv.get('status') !== 'void') v = Math.round((inv.get('totalCents') as number) / sessions);
    }
    lotValue.set(enrolmentId, v);
    return v;
  }

  const rows = new Map<string, PayRow>();
  const rowOf = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      const t: DocumentSnapshot | undefined = teachers.get(id);
      r = { teacherId: id, name: (t?.get('displayName') as string) ?? 'Teacher', pay: resolvePay(t?.get('pay')), lessons: 0, minutes: 0, creditValueCents: 0, amountCents: 0, unvalued: 0 };
      rows.set(id, r);
    }
    return r;
  };
  if (teacherId) rowOf(teacherId);

  for (const l of lessons) {
    const attendees = (await l.ref.collection('attendees').get()).docs;
    const charged = attendees.filter((a) => PAID_STATUSES.has(a.get('status') as string) && (a.get('status') !== 'lateCancelled' || a.get('ledgerEntryId')));
    if (!charged.length) continue;
    const r = rowOf(l.get('teacherId') as string);
    r.lessons += 1;
    r.minutes += (l.get('durationMin') as number) ?? 0;
    for (const a of charged) {
      const lot = a.get('enrolmentId') as string | null;
      const v = lot ? await valueOf(lot) : null;
      if (v === null) r.unvalued += a.get('ledgerEntryId') ? 1 : 0;
      else r.creditValueCents += v;
    }
  }
  for (const r of rows.values()) {
    if (!r.pay) continue;
    if (r.pay.method === 'perLesson') r.amountCents = r.lessons * r.pay.rateCents;
    if (r.pay.method === 'hourly') r.amountCents = Math.round((r.minutes / 60) * r.pay.rateCents);
    if (r.pay.method === 'percent') r.amountCents = Math.round((r.creditValueCents * r.pay.percent) / 100);
  }
  if (teacherId && !teachers.get(teacherId)?.exists) notFound('Teacher');
  return { rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
