// Package sales: invoice + lot + grant, then settle the oldest owed lessons onto the new lot.
// Credit writes go through CreditTx (creditTx.ts); attendance lives in attendance.ts.
import { applyTax, resolveTax, wallClockToUtc } from '@lessonkaki/shared';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { NO_EXPIRY } from '@lessonkaki/shared';
import { CreditTx, readOwed } from './creditTx';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// sellPackage: invoice + lot + grant, then settle the oldest owed lessons onto the new lot
// ---------------------------------------------------------------------------------------------

export interface SellPackageInput {
  schoolId: string;
  studentId: string;
  packageId: string;
  /** One per user action (the client makes it when the sell dialog opens). Retries return the first result. */
  idempotencyKey: string;
  /** Set by the HitPay webhook only: the student already paid, so sell even if the package was retired since. */
  paidOnline?: boolean;
  /** Expiry as a wall date in the school's zone (inclusive), null = never; omitted = the package's validity. */
  validUntil?: string | null;
  /** Off the package price: a percentage (0-100) or an amount in cents. */
  discount?: { kind: 'percent' | 'amount'; value: number } | null;
  /** Staff note, kept on the invoice and the package. */
  note?: string | null;
}

/** "Voice lessons with Daniel · 12 lessons": the package's subject and its teachers' first names. */
export async function packageLabel(
  tx: FirebaseFirestore.Transaction,
  school: FirebaseFirestore.DocumentReference,
  pkg: FirebaseFirestore.DocumentData,
): Promise<string> {
  const n = pkg.sessions as number;
  const count = `${n} ${n === 1 ? 'lesson' : 'lessons'}`;
  if (typeof pkg.subjectId !== 'string') return `${pkg.name as string}`;
  const subject = await tx.get(school.collection('subjects').doc(pkg.subjectId));
  if (!subject.exists) return `${pkg.name as string}`;
  const ids = (subject.get('teacherIds') as string[] | undefined) ?? [];
  const teachers = ids.length ? await tx.getAll(...ids.map((id) => school.collection('teachers').doc(id))) : [];
  const names = teachers
    .filter((t) => t.exists && t.get('active') !== false)
    .map((t) => String(t.get('displayName') ?? '').trim().split(/\s+/)[0])
    .filter(Boolean);
  return `${subject.get('name') as string}${names.length ? ` with ${names.join(' / ')}` : ''} · ${count}`;
}

export interface SellPackageResult {
  invoiceId: string;
  invoiceNumber: string;
  enrolmentId: string;
  settled: number;
  sessionsRemaining: number;
}

export function formatInvoiceNumber(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

export async function sellPackage(
  db: Firestore,
  input: SellPackageInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<SellPackageResult> {
  const school = schoolRef(db, input.schoolId);
  const idemRef = school.collection('idempotency').doc(`sellPackage_${input.idempotencyKey}`);
  const studentRef = school.collection('students').doc(input.studentId);
  const packageRef = school.collection('packages').doc(input.packageId);
  const counterRef = school.collection('counters').doc('invoice');

  return db.runTransaction(async (tx) => {
    // ---- reads ----
    const [idem, schoolSnap, studentSnap, pkgSnap, counterSnap] = await readAll(
      tx,
      idemRef,
      school,
      studentRef,
      packageRef,
      counterRef,
    );
    if (idem.exists) {
      if (idem.get('studentId') !== input.studentId || idem.get('packageId') !== input.packageId) {
        throw new HttpsError('already-exists', 'This idempotency key was already used for a different sale');
      }
      return idem.get('result') as SellPackageResult;
    }
    if (!schoolSnap.exists) notFound('School');
    if (!studentSnap.exists) notFound('Student');
    if (!pkgSnap.exists) notFound('Package');
    if (studentSnap.get('status') === 'archived') {
      throw new HttpsError('failed-precondition', 'This student is archived');
    }
    const pkg = pkgSnap.data()!;
    if (pkg.active === false && !input.paidOnline) throw new HttpsError('failed-precondition', 'This package is no longer sold');
    const sessions = pkg.sessions as number;
    if (!Number.isInteger(sessions) || sessions < 1) {
      throw new HttpsError('failed-precondition', 'Package has no session count');
    }

    const label = await packageLabel(tx, school, pkg);
    const ct = new CreditTx(tx, school, actor, at);
    const owed = await readOwed(ct, input.schoolId, input.studentId);

    // ---- writes ----
    const nowTs = Timestamp.fromDate(at);
    const validityDays = pkg.validityDays as number | null | undefined;
    const timeZone = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const validUntil =
      input.validUntil === undefined
        ? Timestamp.fromDate(validityDays ? new Date(at.getTime() + validityDays * DAY_MS) : NO_EXPIRY)
        : input.validUntil === null
          ? Timestamp.fromDate(NO_EXPIRY)
          : // Through the end of that day in the school's zone.
            Timestamp.fromDate(new Date(wallClockToUtc(input.validUntil, '00:00', timeZone).getTime() + DAY_MS - 1));
    if (validUntil.toMillis() < at.getTime()) throw new HttpsError('invalid-argument', 'The expiry date is in the past');
    const subtotalCents = pkg.priceCents as number;
    const d = input.discount;
    const discountCents = !d
      ? 0
      : Math.min(subtotalCents, Math.max(0, d.kind === 'percent' ? Math.round((subtotalCents * Math.min(d.value, 100)) / 100) : Math.round(d.value)));
    // Tax as the school has it set today; the invoice keeps its own copy so later setting changes don't touch it.
    const tax = resolveTax(schoolSnap.get('tax'));
    const { taxCents, totalCents: priceCents } = applyTax(subtotalCents - discountCents, tax);
    const note = input.note?.trim().slice(0, 1000) || null;
    const currency = (schoolSnap.get('currency') as string | undefined) ?? 'SGD';

    const n = counterSnap.exists ? (counterSnap.get('next') as number) : 1;
    const invoiceNumber = formatInvoiceNumber((schoolSnap.get('invoicePrefix') as string | undefined) ?? 'INV', n);
    tx.set(counterRef, { next: n + 1, updatedAt: now() });

    const invoiceRef = school.collection('invoices').doc();
    const lotRef = school.collection('enrolments').doc();

    tx.create(invoiceRef, {
      number: invoiceNumber,
      studentId: input.studentId,
      currency,
      lines: [
        {
          desc: label,
          qty: 1,
          unitCents: subtotalCents,
          packageId: input.packageId,
          enrolmentId: lotRef.id,
        },
      ],
      subtotalCents,
      discountCents,
      taxCents,
      tax: tax.enabled ? { rate: tax.rate, label: tax.label, inclusive: tax.inclusive, regNo: tax.regNo } : null,
      note,
      moneyCreditAppliedCents: 0,
      totalCents: priceCents,
      paidCents: 0,
      pendingCents: priceCents,
      status: 'sent',
      overdueSince: null,
      issueDate: nowTs,
      dueDate: Timestamp.fromDate(new Date(at.getTime() + 7 * DAY_MS)),
      createdBy: actor.uid,
      createdAt: now(),
      updatedAt: now(),
    });

    const lot = ct.newLot(
      lotRef,
      {
        studentId: input.studentId,
        packageId: input.packageId,
        packageName: label,
        note,
        invoiceId: invoiceRef.id,
        validFrom: nowTs,
        validUntil,
      },
      sessions,
      { type: 'grant', invoiceId: invoiceRef.id, idempotencyKey: `sellPackage:${input.idempotencyKey}:grant` },
    );
    const settled = ct.settleOwed(lot, owed, `sellPackage:${input.idempotencyKey}`, invoiceRef.id);
    ct.bump(input.studentId, { outstandingCents: priceCents });
    ct.flush();
    const remaining = lot.remaining;

    const result: SellPackageResult = {
      invoiceId: invoiceRef.id,
      invoiceNumber,
      enrolmentId: lotRef.id,
      settled,
      sessionsRemaining: remaining,
    };
    tx.create(idemRef, {
      studentId: input.studentId,
      packageId: input.packageId,
      result,
      actorUid: actor.uid,
      createdAt: now(),
    });
    audit(tx, school, actor, 'sellPackage', `invoices/${invoiceRef.id}`, { invoiceNumber, settled });
    return result;
  });
}
