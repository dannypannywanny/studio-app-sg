// Package sales: invoice + lot + grant, then settle the oldest owed lessons onto the new lot.
// Credit writes go through CreditTx (creditTx.ts); attendance lives in attendance.ts.
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
    if (pkg.active === false) throw new HttpsError('failed-precondition', 'This package is no longer sold');
    const sessions = pkg.sessions as number;
    if (!Number.isInteger(sessions) || sessions < 1) {
      throw new HttpsError('failed-precondition', 'Package has no session count');
    }

    const ct = new CreditTx(tx, school, actor, at);
    const owed = await readOwed(ct, input.schoolId, input.studentId);

    // ---- writes ----
    const nowTs = Timestamp.fromDate(at);
    const validityDays = pkg.validityDays as number | null | undefined;
    const validUntil = Timestamp.fromDate(validityDays ? new Date(at.getTime() + validityDays * DAY_MS) : NO_EXPIRY);
    const priceCents = pkg.priceCents as number;
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
          desc: pkg.name as string,
          qty: 1,
          unitCents: priceCents,
          packageId: input.packageId,
          enrolmentId: lotRef.id,
        },
      ],
      subtotalCents: priceCents,
      discountCents: 0,
      moneyCreditAppliedCents: 0,
      totalCents: priceCents,
      paidCents: 0,
      pendingCents: priceCents,
      status: 'sent',
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
        packageName: pkg.name as string,
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
