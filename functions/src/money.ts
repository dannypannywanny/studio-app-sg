// Money: offline payments (PayNow, bank transfer, cash), money credit from overpayments, voiding
// invoices, and the overdue flag. Amounts are integer cents. Every write happens in one transaction with
// the student's summary.outstandingCents / moneyCreditCents, which reconcileStudent checks.
//
// Invoice status: sent -> partial -> paid as payments come in; sent/partial -> void (only while nothing
// has been paid; refunds and credit notes arrive in M7).
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { NO_EXPIRY, applyTax, wallClockToUtc, type InvoiceStatus } from '@lessonkaki/shared';
import { enqueueAlert } from './alerts';
import { CreditTx, readOwed } from './creditTx';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';

export const PAYMENT_METHODS = ['paynow', 'bank', 'cash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Status after a payment: what is still pending decides it. */
export function statusAfterPayment(pendingCents: number): InvoiceStatus {
  return pendingCents === 0 ? 'paid' : 'partial';
}

// ---------------------------------------------------------------------------------------------
// recordPayment
// ---------------------------------------------------------------------------------------------

export interface RecordPaymentInput {
  schoolId: string;
  invoiceId: string;
  amountCents: number;
  /** Staff choose from PAYMENT_METHODS; 'card_hitpay' comes only from the HitPay webhook. */
  method: PaymentMethod | 'card_hitpay';
  /** When the money arrived (defaults to now). */
  paidAt?: Date;
  /** Bank / PayNow reference, receipt number. */
  reference?: string | null;
  idempotencyKey: string;
}

export interface RecordPaymentResult {
  paymentId: string;
  invoiceStatus: InvoiceStatus;
  appliedCents: number;
  overpaymentCents: number;
  pendingCents: number;
}

export async function recordPayment(
  db: Firestore,
  input: RecordPaymentInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<RecordPaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new HttpsError('invalid-argument', 'The amount must be a positive number of cents');
  }
  const school = schoolRef(db, input.schoolId);
  const idemRef = school.collection('idempotency').doc(`recordPayment_${input.idempotencyKey}`);
  const invoiceRef = school.collection('invoices').doc(input.invoiceId);

  return db.runTransaction(async (tx) => {
    const [idem, invoiceSnap] = await readAll(tx, idemRef, invoiceRef);
    if (idem.exists) {
      if (idem.get('invoiceId') !== input.invoiceId || idem.get('amountCents') !== input.amountCents) {
        throw new HttpsError('already-exists', 'This idempotency key was already used for a different payment');
      }
      return idem.get('result') as RecordPaymentResult;
    }
    if (!invoiceSnap.exists) notFound('Invoice');
    const inv = invoiceSnap.data()!;
    const status = inv.status as InvoiceStatus;
    if (status === 'void') throw new HttpsError('failed-precondition', 'This invoice is void');
    if (status === 'paid') throw new HttpsError('failed-precondition', 'This invoice is already paid');
    if (status === 'draft') throw new HttpsError('failed-precondition', 'Send the invoice before recording payments');

    const pending = inv.pendingCents as number;
    const applied = Math.min(input.amountCents, pending);
    const over = input.amountCents - applied;
    const pendingAfter = pending - applied;
    const invoiceStatus = statusAfterPayment(pendingAfter);
    const paidAt = Timestamp.fromDate(input.paidAt ?? at);
    const studentId = inv.studentId as string;

    const paymentRef = school.collection('payments').doc();
    tx.create(paymentRef, {
      invoiceId: input.invoiceId,
      invoiceNumber: inv.number,
      studentId,
      amountCents: input.amountCents,
      appliedCents: applied,
      overpaymentCents: over,
      currency: inv.currency ?? 'SGD',
      method: input.method,
      reference: input.reference ?? null,
      gatewayRef: null,
      status: 'succeeded',
      refundCents: 0,
      paidAt,
      recordedBy: actor.uid,
      idempotencyKey: input.idempotencyKey,
      createdAt: now(),
    });
    tx.update(invoiceRef, {
      paidCents: (inv.paidCents as number) + applied,
      pendingCents: pendingAfter,
      status: invoiceStatus,
      ...(invoiceStatus === 'paid' ? { paidAt, overdueSince: null } : {}),
      updatedAt: now(),
    });

    const ct = new CreditTx(tx, school, actor, at);
    if (over > 0) {
      tx.create(school.collection('moneyLedger').doc(), {
        studentId,
        deltaCents: over,
        type: 'overpayment',
        invoiceId: input.invoiceId,
        paymentId: paymentRef.id,
        creditNoteId: null,
        reason: null,
        actorUid: actor.uid,
        idempotencyKey: `recordPayment:${input.idempotencyKey}:overpayment`,
        createdAt: now(),
      });
    }
    ct.bump(studentId, { outstandingCents: -applied, moneyCreditCents: over });
    ct.flush();

    const result: RecordPaymentResult = {
      paymentId: paymentRef.id,
      invoiceStatus,
      appliedCents: applied,
      overpaymentCents: over,
      pendingCents: pendingAfter,
    };
    tx.create(idemRef, { invoiceId: input.invoiceId, amountCents: input.amountCents, result, actorUid: actor.uid, createdAt: now() });
    enqueueAlert(
      tx,
      school,
      `payment_${paymentRef.id}`,
      {
        type: 'payment.recorded',
        paymentId: paymentRef.id,
        invoiceId: input.invoiceId,
        invoiceNumber: inv.number as string,
        studentId,
        amountCents: input.amountCents,
        currency: (inv.currency as string | undefined) ?? 'SGD',
        method: input.method,
        pendingCents: pendingAfter,
        overpaymentCents: over,
      },
      actor,
      at,
    );
    audit(tx, school, actor, 'recordPayment', `invoices/${input.invoiceId}`, {
      method: input.method,
      amountCents: input.amountCents,
      appliedCents: applied,
      overpaymentCents: over,
      status: invoiceStatus,
    });
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// voidInvoice
// ---------------------------------------------------------------------------------------------

export interface VoidInvoiceInput {
  schoolId: string;
  invoiceId: string;
  reason: string;
  /** Void the invoice but leave the credits it granted with the student (e.g. a gift). */
  keepCredits?: boolean;
}

export async function voidInvoice(
  db: Firestore,
  input: VoidInvoiceInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<{ status: 'void'; creditsRemoved: number }> {
  const reason = input.reason.trim();
  if (!reason) throw new HttpsError('invalid-argument', 'Give a reason for voiding');
  const school = schoolRef(db, input.schoolId);
  const invoiceRef = school.collection('invoices').doc(input.invoiceId);

  return db.runTransaction(async (tx) => {
    const invoiceSnap = await tx.get(invoiceRef);
    if (!invoiceSnap.exists) notFound('Invoice');
    const inv = invoiceSnap.data()!;
    if (inv.status === 'void') return { status: 'void' as const, creditsRemoved: 0 };
    if ((inv.paidCents as number) > 0) {
      throw new HttpsError('failed-precondition', 'This invoice has payments recorded, so it cannot be voided');
    }
    const ct = new CreditTx(tx, school, actor, at);
    const lots = (await tx.get(school.collection('enrolments').where('invoiceId', '==', input.invoiceId))).docs.map((d) =>
      ct.useLot(d),
    );

    let creditsRemoved = 0;
    if (!input.keepCredits) {
      const used = lots.reduce((n, l) => n + l.used, 0);
      if (used > 0) {
        throw new HttpsError(
          'failed-precondition',
          `${used} credit${used === 1 ? ' was' : 's were'} already used from this invoice. ` +
            'Void it and keep the credits, or adjust credits by hand.',
        );
      }
      for (const lot of lots) {
        if (lot.status === 'void') continue;
        if (lot.remaining > 0) {
          creditsRemoved += lot.remaining;
          ct.adjust(lot, -lot.remaining, `Invoice voided: ${reason}`, `voidInvoice:${input.invoiceId}:${lot.id}`);
        }
        ct.voidLot(lot);
      }
    }
    ct.bump(inv.studentId as string, { outstandingCents: -(inv.pendingCents as number) });
    ct.flush();
    tx.update(invoiceRef, {
      status: 'void',
      pendingCents: 0,
      overdueSince: null,
      voidReason: reason,
      voidedBy: actor.uid,
      voidedAt: Timestamp.fromDate(at),
      updatedAt: now(),
    });
    audit(tx, school, actor, 'voidInvoice', `invoices/${input.invoiceId}`, {
      reason,
      keepCredits: !!input.keepCredits,
      creditsRemoved,
    });
    return { status: 'void' as const, creditsRemoved };
  });
}

// ---------------------------------------------------------------------------------------------
// markOverdue: daily, flags unpaid invoices past their due date (overdueSince)
// ---------------------------------------------------------------------------------------------

export async function markOverdue(db: Firestore, schoolId: string, at: Date = new Date()): Promise<{ flagged: number }> {
  const school = schoolRef(db, schoolId);
  const due = await school
    .collection('invoices')
    .where('status', 'in', ['sent', 'partial'])
    .where('dueDate', '<', Timestamp.fromDate(at))
    .get();
  const fresh = due.docs.filter((d) => d.get('overdueSince') == null);
  if (fresh.length === 0) return { flagged: 0 };
  const actor: Actor = { uid: 'system:markOverdue', role: 'system' };
  // Batches of 400 keep well under the per-commit limit.
  for (let i = 0; i < fresh.length; i += 400) {
    const batch = db.batch();
    for (const d of fresh.slice(i, i + 400)) batch.update(d.ref, { overdueSince: Timestamp.fromDate(at), updatedAt: now() });
    batch.create(school.collection('auditLog').doc(), {
      actorUid: actor.uid,
      action: 'markOverdue',
      target: 'invoices',
      detail: { invoiceIds: fresh.slice(i, i + 400).map((d) => d.id) },
      at: now(),
    });
    await batch.commit();
  }
  return { flagged: fresh.length };
}

export async function markOverdueAll(db: Firestore, at: Date = new Date()): Promise<{ flagged: number }> {
  let flagged = 0;
  for (const s of (await db.collection('schools').get()).docs) flagged += (await markOverdue(db, s.id, at)).flagged;
  return { flagged };
}

// ---------------------------------------------------------------------------------------------
// editInvoice: the details staff fix after a sale (number, due date, discount, package expiry, notes)
// ---------------------------------------------------------------------------------------------

export interface EditInvoiceInput {
  schoolId: string;
  invoiceId: string;
  number?: string;
  /** Wall date (school zone). */
  dueDate?: string;
  /** Replaces the discount; null removes it. */
  discount?: { kind: 'percent' | 'amount'; value: number } | null;
  /** Expiry of the package(s) this invoice sold: wall date (inclusive) or null = never. */
  validUntil?: string | null;
  /** Staff notes (never on the PDF). */
  note?: string | null;
}

const DAY = 86_400_000;

export async function editInvoice(db: Firestore, input: EditInvoiceInput, actor: Actor, at: Date = new Date()) {
  const school = schoolRef(db, input.schoolId);
  const invoiceRef = school.collection('invoices').doc(input.invoiceId);
  return db.runTransaction(async (tx) => {
    const [invSnap, schoolSnap] = await readAll(tx, invoiceRef, school);
    if (!invSnap.exists) notFound('Invoice');
    const inv = invSnap.data()!;
    if (inv.status === 'void') throw new HttpsError('failed-precondition', 'This invoice is void');
    const tz = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const update: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.number !== undefined) {
      const number = input.number.trim();
      if (!number) throw new HttpsError('invalid-argument', 'The invoice number cannot be empty');
      if (number !== inv.number) {
        const dup = await tx.get(school.collection('invoices').where('number', '==', number).limit(1));
        if (!dup.empty) throw new HttpsError('already-exists', `Invoice ${number} already exists`);
        update.number = number;
        changed.push('number');
      }
    }

    const lots =
      input.validUntil !== undefined ? (await tx.get(school.collection('enrolments').where('invoiceId', '==', input.invoiceId))).docs : [];
    // A package extended with sessions coming back pays the student's owed lessons first, like a sale.
    const ct = new CreditTx(tx, school, actor, at);
    const reviving = lots.some((l) => l.get('status') !== 'void' && ((l.get('sessionsExpired') as number | undefined) ?? 0) > 0);
    const owed = reviving ? await readOwed(ct, input.schoolId, inv.studentId as string) : [];

    if (input.dueDate !== undefined) {
      const due = wallClockToUtc(input.dueDate, '00:00', tz);
      update.dueDate = Timestamp.fromDate(due);
      // The daily overdue job flags it again if it's still late.
      if (due.getTime() + DAY > at.getTime()) update.overdueSince = null;
      changed.push('dueDate');
    }

    let pendingDelta = 0;
    if (input.discount !== undefined) {
      const subtotal = (inv.subtotalCents as number | undefined) ?? (inv.totalCents as number);
      const d = input.discount;
      const discountCents = !d
        ? 0
        : Math.min(subtotal, Math.max(0, d.kind === 'percent' ? Math.round((subtotal * Math.min(d.value, 100)) / 100) : Math.round(d.value)));
      const credit = ((inv.moneyCreditAppliedCents as number | undefined) ?? 0) + ((inv.creditedCents as number | undefined) ?? 0);
      // Tax at the rate the invoice was issued with.
      const t = inv.tax as { rate: number; inclusive: boolean } | null | undefined;
      const taxed = applyTax(subtotal - discountCents, { enabled: !!t, rate: t?.rate ?? 0, inclusive: t?.inclusive ?? false });
      const total = Math.max(0, taxed.totalCents - credit);
      const paid = (inv.paidCents as number | undefined) ?? 0;
      if (total < paid) {
        throw new HttpsError('failed-precondition', 'More has been paid than the new total. Record a refund first, or use a smaller discount.');
      }
      const pending = total - paid;
      pendingDelta = pending - (inv.pendingCents as number);
      const status: InvoiceStatus = pending === 0 ? 'paid' : paid > 0 ? 'partial' : 'sent';
      Object.assign(update, {
        discountCents,
        taxCents: taxed.taxCents,
        totalCents: total,
        pendingCents: pending,
        status,
        ...(pending === 0 ? { overdueSince: null, paidAt: inv.paidAt ?? Timestamp.fromDate(at) } : {}),
      });
      changed.push('discount');
    }

    if (input.note !== undefined) {
      update.note = input.note?.trim().slice(0, 2000) || null;
      changed.push('note');
    }

    // ---- writes ----
    if (pendingDelta) ct.bump(inv.studentId as string, { outstandingCents: pendingDelta });
    let revived = 0;
    let settled = 0;
    if (input.validUntil !== undefined) {
      const until =
        input.validUntil === null ? NO_EXPIRY : new Date(wallClockToUtc(input.validUntil, '00:00', tz).getTime() + DAY - 1);
      for (const l of lots) {
        if (l.get('status') === 'void') continue;
        // Extending to a future date gives back what expired on the package (whether it is filed as
        // expired, or as completed because nothing was left), then settles owed lessons it now covers.
        const expired = (l.get('sessionsExpired') as number | undefined) ?? 0;
        if (expired > 0 && until.getTime() >= at.getTime()) {
          const lot = ct.useLot(l);
          lot.validUntilMs = until.getTime();
          revived += ct.unexpire(lot, `editInvoice:${l.id}:unexpire:${until.getTime()}`, 'Package extended');
          settled += ct.settleOwed(lot, owed, `editInvoice:${l.id}:${until.getTime()}`, input.invoiceId);
        }
        tx.update(l.ref, { validUntil: Timestamp.fromDate(until), updatedAt: now() });
      }
      changed.push('validUntil');
    }
    ct.flush();
    if (Object.keys(update).length) tx.update(invoiceRef, { ...update, updatedAt: now() });
    audit(tx, school, actor, 'editInvoice', `invoices/${input.invoiceId}`, { changed, ...(revived ? { revived, settled } : {}) });
    return { changed, revived, settled };
  });
}

// ---------------------------------------------------------------------------------------------
// issueCreditNote: take an amount off an invoice (refund / goodwill). If the student has already paid more
// than the new total, the difference becomes money credit (moneyLedger 'creditNote') or a recorded refund
// (a payments doc with status 'refund' and a negative amount).
// ---------------------------------------------------------------------------------------------

export interface CreditNoteInput {
  schoolId: string;
  invoiceId: string;
  amountCents: number;
  reason: string;
  /** What happens to money already paid above the new total. */
  excess: 'credit' | 'refund';
  refundMethod?: PaymentMethod | null;
  idempotencyKey: string;
}

export async function issueCreditNote(db: Firestore, input: CreditNoteInput, actor: Actor, at: Date = new Date()) {
  const reason = input.reason.trim();
  if (!reason) throw new HttpsError('invalid-argument', 'Give a reason for the credit note');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpsError('invalid-argument', 'The amount must be positive');
  const school = schoolRef(db, input.schoolId);
  const idemRef = school.collection('idempotency').doc(`creditNote_${input.idempotencyKey}`);
  const invoiceRef = school.collection('invoices').doc(input.invoiceId);
  const counterRef = school.collection('counters').doc('creditNote');

  return db.runTransaction(async (tx) => {
    const [idem, invSnap, counterSnap] = await readAll(tx, idemRef, invoiceRef, counterRef);
    if (idem.exists) return idem.get('result') as { creditNoteId: string; number: string; excessCents: number };
    if (!invSnap.exists) notFound('Invoice');
    const inv = invSnap.data()!;
    if (inv.status === 'void') throw new HttpsError('failed-precondition', 'This invoice is void');
    const total = inv.totalCents as number;
    if (input.amountCents > total) throw new HttpsError('invalid-argument', 'The credit is more than the invoice total');
    const paid = (inv.paidCents as number | undefined) ?? 0;
    const newTotal = total - input.amountCents;
    const excess = Math.max(0, paid - newTotal);
    const newPaid = paid - excess;
    const pending = newTotal - newPaid;
    const studentId = inv.studentId as string;
    const n = counterSnap.exists ? (counterSnap.get('next') as number) : 1;
    const number = `CN-${String(n).padStart(5, '0')}`;

    // ---- writes ----
    tx.set(counterRef, { next: n + 1, updatedAt: now() });
    const cnRef = school.collection('creditNotes').doc();
    tx.create(cnRef, {
      number,
      invoiceId: input.invoiceId,
      invoiceNumber: inv.number,
      studentId,
      amountCents: input.amountCents,
      reason,
      excess: excess ? input.excess : null,
      excessCents: excess,
      createdBy: actor.uid,
      createdAt: now(),
    });
    tx.update(invoiceRef, {
      creditedCents: ((inv.creditedCents as number | undefined) ?? 0) + input.amountCents,
      totalCents: newTotal,
      paidCents: newPaid,
      pendingCents: pending,
      status: pending === 0 ? 'paid' : newPaid > 0 ? 'partial' : 'sent',
      ...(pending === 0 ? { overdueSince: null, paidAt: inv.paidAt ?? Timestamp.fromDate(at) } : {}),
      updatedAt: now(),
    });
    const ct = new CreditTx(tx, school, actor, at);
    if (excess && input.excess === 'credit') {
      tx.create(school.collection('moneyLedger').doc(), {
        studentId,
        deltaCents: excess,
        type: 'creditNote',
        invoiceId: input.invoiceId,
        paymentId: null,
        creditNoteId: cnRef.id,
        reason,
        actorUid: actor.uid,
        idempotencyKey: `creditNote:${input.idempotencyKey}:excess`,
        createdAt: now(),
      });
    }
    if (excess && input.excess === 'refund') {
      tx.create(school.collection('payments').doc(), {
        invoiceId: input.invoiceId,
        invoiceNumber: inv.number,
        studentId,
        amountCents: -excess,
        appliedCents: -excess,
        overpaymentCents: 0,
        currency: inv.currency ?? 'SGD',
        method: input.refundMethod ?? 'paynow',
        reference: number,
        gatewayRef: null,
        status: 'refund',
        refundCents: excess,
        paidAt: Timestamp.fromDate(at),
        recordedBy: actor.uid,
        idempotencyKey: `creditNote:${input.idempotencyKey}`,
        createdAt: now(),
      });
    }
    ct.bump(studentId, { outstandingCents: pending - (inv.pendingCents as number), moneyCreditCents: excess && input.excess === 'credit' ? excess : 0 });
    ct.flush();
    const result = { creditNoteId: cnRef.id, number, excessCents: excess };
    tx.create(idemRef, { invoiceId: input.invoiceId, result, actorUid: actor.uid, createdAt: now() });
    audit(tx, school, actor, 'issueCreditNote', `invoices/${input.invoiceId}`, { number, amountCents: input.amountCents, excess, mode: input.excess });
    return result;
  });
}
