// The credit engine's write side, shared by every operation that moves credits.
//
// A CreditTx wraps one Firestore transaction. Callers do all their reads first (lots via `useLot`),
// then call debit / restore / expire / adjust / settle, then `flush()`. Lot counters are kept in memory
// and written once per lot at flush, so several changes to the same lot in one transaction (cancelling a
// group lesson, a series edit) add up correctly. Student summaries are written as increments.
//
// Ledger entries are append-only and written as they happen. Every lot change is mirrored by a ledger
// entry, which is what reconcileStudent checks.
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Transaction,
} from 'firebase-admin/firestore';
import { NO_EXPIRY, type EnrolmentStatus, type LedgerType } from '@lessonkaki/shared';
import { now, type Actor } from './db';

export interface LotState {
  readonly id: string;
  readonly ref: DocumentReference;
  readonly studentId: string;
  readonly validUntilMs: number;
  readonly validFromMs: number;
  total: number;
  remaining: number;
  used: number;
  expired: number;
  status: EnrolmentStatus;
  /** Created in this transaction: written with create() at flush instead of update(). */
  readonly createFields?: Record<string, unknown>;
}

export interface LedgerWrite {
  studentId: string;
  enrolmentId: string | null;
  type: LedgerType;
  delta: number;
  idempotencyKey: string;
  lessonId?: string | null;
  attendeeKey?: string | null;
  reversesEntryId?: string | null;
  settlesEntryId?: string | null;
  invoiceId?: string | null;
  reason?: string | null;
}

export interface SummaryDelta {
  sessionsAvailable: number;
  sessionsOwed: number;
  outstandingCents: number;
  moneyCreditCents: number;
}

export const millis = (t: Timestamp | null | undefined) => (t ? t.toMillis() : NO_EXPIRY.getTime());

/** Earliest-expiring first, then oldest. Skips empty lots and lots that expire before `atMs`. */
export function pickLot(lots: LotState[], atMs: number, preferredId: string | null = null): LotState | null {
  const usable = lots.filter((l) => l.status === 'active' && l.remaining > 0 && l.validUntilMs >= atMs);
  // Staff can choose the package for a student's lesson; if it can't pay (used up, expired), fall back.
  const preferred = preferredId ? usable.find((l) => l.id === preferredId) : undefined;
  return preferred ?? usable.sort((a, b) => a.validUntilMs - b.validUntilMs || a.validFromMs - b.validFromMs)[0] ?? null;
}

export class CreditTx {
  private readonly lots = new Map<string, LotState>();
  private readonly summaries = new Map<string, SummaryDelta>();

  constructor(
    readonly tx: Transaction,
    readonly school: DocumentReference,
    readonly actor: Actor,
    readonly at: Date,
  ) {}

  /** Registers a lot read in this transaction (same object back if it was already registered). */
  useLot(snap: DocumentSnapshot): LotState {
    const known = this.lots.get(snap.id);
    if (known) return known;
    const lot: LotState = {
      id: snap.id,
      ref: snap.ref,
      studentId: snap.get('studentId') as string,
      validUntilMs: millis(snap.get('validUntil')),
      validFromMs: millis(snap.get('validFrom')),
      total: snap.get('sessionsTotal') as number,
      remaining: snap.get('sessionsRemaining') as number,
      used: snap.get('sessionsUsed') as number,
      expired: (snap.get('sessionsExpired') as number | undefined) ?? 0,
      status: snap.get('status') as EnrolmentStatus,
    };
    this.lots.set(lot.id, lot);
    return lot;
  }

  /** A new lot holding `sessions`, granted with a ledger entry of `grant.type` (grant / adjust / migrate). */
  newLot(
    ref: DocumentReference,
    fields: Record<string, unknown> & { studentId: string; validFrom: Timestamp; validUntil: Timestamp },
    sessions: number,
    grant: Omit<LedgerWrite, 'studentId' | 'enrolmentId' | 'delta'>,
  ): LotState {
    const lot: LotState = {
      id: ref.id,
      ref,
      studentId: fields.studentId,
      validUntilMs: fields.validUntil.toMillis(),
      validFromMs: fields.validFrom.toMillis(),
      total: sessions,
      remaining: sessions,
      used: 0,
      expired: 0,
      status: 'active',
      createFields: fields,
    };
    this.lots.set(lot.id, lot);
    this.ledger({ ...grant, studentId: lot.studentId, enrolmentId: lot.id, delta: sessions });
    this.bump(lot.studentId, { sessionsAvailable: sessions });
    return lot;
  }

  ledger(entry: LedgerWrite): string {
    const ref = this.school.collection('ledger').doc();
    this.tx.create(ref, {
      lessonId: null,
      attendeeKey: null,
      reversesEntryId: null,
      settlesEntryId: null,
      invoiceId: null,
      reason: null,
      ...entry,
      actorUid: this.actor.uid,
      createdAt: now(),
    });
    return ref.id;
  }

  bump(studentId: string, delta: Partial<SummaryDelta>): void {
    const s = this.summaries.get(studentId) ?? {
      sessionsAvailable: 0,
      sessionsOwed: 0,
      outstandingCents: 0,
      moneyCreditCents: 0,
    };
    for (const [k, v] of Object.entries(delta) as [keyof SummaryDelta, number][]) s[k] += v;
    this.summaries.set(studentId, s);
  }

  private isExpired(lot: LotState): boolean {
    return lot.validUntilMs < this.at.getTime();
  }

  /** Uses one credit from `lot`, or records an owed lesson when `lot` is null. Returns the entry id. */
  debit(studentId: string, lot: LotState | null, ref: { lessonId: string; attendeeKey: string; key: string }): string {
    const entryId = this.ledger({
      studentId,
      enrolmentId: lot?.id ?? null,
      type: 'debit',
      delta: -1,
      lessonId: ref.lessonId,
      attendeeKey: ref.attendeeKey,
      idempotencyKey: ref.key,
    });
    if (lot) {
      lot.remaining -= 1;
      lot.used += 1;
      if (lot.remaining === 0) lot.status = 'completed';
      this.bump(studentId, { sessionsAvailable: -1 });
    } else {
      this.bump(studentId, { sessionsOwed: 1 });
    }
    return entryId;
  }

  /**
   * Gives back the credit a charge took: to the same lot, or clears the owed lesson when `lot` is null.
   * A credit returning to a lot whose validity has passed expires straight away (restore + expire).
   */
  restore(
    studentId: string,
    lot: LotState | null,
    ref: { lessonId: string; attendeeKey: string; key: string; reversesEntryId: string },
  ): 'restored' | 'restoredExpired' {
    const base = {
      studentId,
      enrolmentId: lot?.id ?? null,
      lessonId: ref.lessonId,
      attendeeKey: ref.attendeeKey,
      reversesEntryId: ref.reversesEntryId,
    };
    this.ledger({ ...base, type: 'restore', delta: 1, idempotencyKey: `${ref.key}:restore` });
    if (!lot) {
      this.bump(studentId, { sessionsOwed: -1 });
      return 'restored';
    }
    lot.used -= 1;
    if (this.isExpired(lot)) {
      this.ledger({
        ...base,
        type: 'expire',
        delta: -1,
        idempotencyKey: `${ref.key}:expire`,
        reason: 'Restored onto an expired lot',
      });
      lot.expired += 1;
      if (lot.remaining === 0) lot.status = 'expired';
      return 'restoredExpired';
    }
    lot.remaining += 1;
    if (lot.status === 'completed') lot.status = 'active';
    this.bump(studentId, { sessionsAvailable: 1 });
    return 'restored';
  }

  /** Expires everything left on a lot and marks it expired. Returns how many sessions expired. */
  expireRemaining(lot: LotState, key: string, reason: string): number {
    const n = lot.remaining;
    if (n > 0) {
      this.ledger({ studentId: lot.studentId, enrolmentId: lot.id, type: 'expire', delta: -n, idempotencyKey: key, reason });
      lot.expired += n;
      lot.remaining = 0;
      this.bump(lot.studentId, { sessionsAvailable: -n });
    }
    lot.status = 'expired';
    return n;
  }

  /** A manual change to what a lot holds: total and remaining move together. Returns the entry id. */
  adjust(lot: LotState, delta: number, reason: string, key: string): string {
    if (lot.remaining + delta < 0) throw new Error(`Lot ${lot.id} has only ${lot.remaining} left`);
    const entryId = this.ledger({
      studentId: lot.studentId,
      enrolmentId: lot.id,
      type: 'adjust',
      delta,
      idempotencyKey: key,
      reason,
    });
    lot.total += delta;
    lot.remaining += delta;
    if (lot.status === 'active' || lot.status === 'completed') {
      this.bump(lot.studentId, { sessionsAvailable: delta });
      lot.status = lot.remaining === 0 ? 'completed' : 'active';
    }
    return entryId;
  }

  /** Marks a lot void (its remaining credits must already have been taken back with adjust). */
  voidLot(lot: LotState): void {
    if (lot.remaining !== 0) throw new Error(`Lot ${lot.id} still holds ${lot.remaining}`);
    lot.status = 'void';
  }

  /**
   * Settles owed attendees (already read, oldest first) onto `lot` while it has sessions and covers the
   * lesson date. Returns how many were settled.
   */
  settleOwed(lot: LotState, owed: DocumentSnapshot[], keyPrefix: string, invoiceId: string | null = null): number {
    let settled = 0;
    for (const att of owed) {
      if (lot.remaining === 0) break;
      if (att.get('owed') !== true) continue;
      if ((att.get('lessonStartAt') as Timestamp).toMillis() > lot.validUntilMs) continue;
      const lessonId = att.get('lessonId') as string;
      const entryId = this.ledger({
        studentId: lot.studentId,
        enrolmentId: lot.id,
        type: 'settle',
        delta: -1,
        lessonId,
        attendeeKey: `${lessonId}_${lot.studentId}`,
        settlesEntryId: att.get('ledgerEntryId') as string,
        invoiceId,
        idempotencyKey: `${keyPrefix}:settle:${lessonId}`,
      });
      lot.remaining -= 1;
      lot.used += 1;
      if (lot.remaining === 0) lot.status = 'completed';
      this.bump(lot.studentId, { sessionsOwed: -1, sessionsAvailable: -1 });
      this.tx.update(att.ref, { owed: false, enrolmentId: lot.id, ledgerEntryId: entryId, updatedAt: now() });
      settled += 1;
    }
    return settled;
  }

  /** Writes every touched lot and student summary. Call once, after the last change. */
  flush(): void {
    for (const lot of this.lots.values()) {
      const counters = {
        sessionsTotal: lot.total,
        sessionsRemaining: lot.remaining,
        sessionsUsed: lot.used,
        sessionsExpired: lot.expired,
        status: lot.status,
        updatedAt: now(),
      };
      if (lot.createFields) this.tx.create(lot.ref, { ...lot.createFields, ...counters, createdAt: now() });
      else this.tx.update(lot.ref, counters);
    }
    for (const [studentId, d] of this.summaries) {
      const update: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) if (v !== 0) update[`summary.${k}`] = FieldValue.increment(v);
      if (Object.keys(update).length) {
        this.tx.update(this.school.collection('students').doc(studentId), { ...update, updatedAt: now() });
      }
    }
  }
}

/** Reads a student's active lots inside the transaction and registers them. */
export async function readActiveLots(ct: CreditTx, studentId: string): Promise<LotState[]> {
  const snap = await ct.tx.get(
    ct.school.collection('enrolments').where('studentId', '==', studentId).where('status', '==', 'active'),
  );
  return snap.docs.map((d) => ct.useLot(d));
}

/** Reads a student's owed attendees, oldest lesson first. */
export async function readOwed(ct: CreditTx, schoolId: string, studentId: string): Promise<DocumentSnapshot[]> {
  const snap = await ct.tx.get(
    ct.school.firestore
      .collectionGroup('attendees')
      .where('schoolId', '==', schoolId)
      .where('studentId', '==', studentId)
      .where('owed', '==', true)
      .orderBy('lessonStartAt'),
  );
  return snap.docs;
}
