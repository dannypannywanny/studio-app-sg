// Support jobs and tools: expire lots, reconcile the ledger, adjust credits by hand.
import { Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { NO_EXPIRY } from '@lessonkaki/shared';
import { CreditTx, pickLot, readActiveLots, readOwed, type LotState } from './creditTx';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';
import { reconcileStudent } from './reconcile';

const DAY_MS = 86_400_000;
const SYSTEM = (job: string): Actor => ({ uid: `system:${job}`, role: 'system' });

// ---------------------------------------------------------------------------------------------
// expireLots (daily): lots past validUntil give up what is left, with an `expire -N` entry.
// Until this runs, a date-expired lot's remaining sessions still count in summary.sessionsAvailable.
// ---------------------------------------------------------------------------------------------

export async function expireLots(db: Firestore, schoolId: string, at: Date = new Date()): Promise<{ lots: number; sessions: number }> {
  const school = schoolRef(db, schoolId);
  const due = await school
    .collection('enrolments')
    .where('status', '==', 'active')
    .where('validUntil', '<', Timestamp.fromDate(at))
    .get();
  let lots = 0;
  let sessions = 0;
  for (const d of due.docs) {
    const n = await db.runTransaction(async (tx) => {
      const snap = await tx.get(d.ref);
      const ct = new CreditTx(tx, school, SYSTEM('expireLots'), at);
      const lot = ct.useLot(snap);
      if (lot.status !== 'active' || lot.validUntilMs >= at.getTime()) return 0;
      const expired = ct.expireRemaining(lot, `expireLots:${lot.id}:${lot.validUntilMs}`, 'Package expired');
      ct.flush();
      audit(tx, school, ct.actor, 'expireLots', `enrolments/${lot.id}`, { studentId: lot.studentId, sessions: expired });
      return expired;
    });
    if (n > 0) {
      lots += 1;
      sessions += n;
    }
  }
  return { lots, sessions };
}

// ---------------------------------------------------------------------------------------------
// reconcileLedger (nightly): checks every student's balances against the ledger
// ---------------------------------------------------------------------------------------------

export async function reconcileLedger(
  db: Firestore,
  schoolId: string,
  at: Date = new Date(),
): Promise<{ studentsChecked: number; problemCount: number }> {
  const school = schoolRef(db, schoolId);
  const students = await school.collection('students').get();
  let problemCount = 0;
  for (const s of students.docs) {
    const problems = await reconcileStudent(db, schoolId, s.id);
    if (problems.length === 0) continue;
    problemCount += problems.length;
    await school.collection('auditLog').add({
      actorUid: SYSTEM('reconcileLedger').uid,
      action: 'reconcileLedger.problem',
      target: `students/${s.id}`,
      detail: { problems },
      at: now(),
    });
  }
  const result = { studentsChecked: students.size, problemCount };
  await school.collection('jobs').doc('reconcileLedger').set({ ...result, lastRunAt: Timestamp.fromDate(at) });
  return result;
}

/** Runs a per-school job over every school. */
export async function forEachSchool<T>(db: Firestore, job: (schoolId: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (const s of (await db.collection('schools').get()).docs) out.push(await job(s.id));
  return out;
}

// ---------------------------------------------------------------------------------------------
// adjustCredits (owner/admin): a manual +/- with a reason
// ---------------------------------------------------------------------------------------------

export interface AdjustCreditsInput {
  schoolId: string;
  studentId: string;
  /** Sessions to add (positive) or take away (negative). */
  delta: number;
  reason: string;
  /** The lot to change. Without one: + creates a "Manual credit" lot, - takes earliest-expiring first. */
  enrolmentId?: string | null;
  /** For a new manual lot: days it stays valid (default: no expiry). */
  validityDays?: number | null;
  idempotencyKey: string;
}

export interface AdjustCreditsResult {
  delta: number;
  enrolmentIds: string[];
  settled: number;
}

export async function adjustCredits(
  db: Firestore,
  input: AdjustCreditsInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<AdjustCreditsResult> {
  if (!(actor.role === 'owner' || actor.role === 'admin' || actor.role === 'system')) {
    throw new HttpsError('permission-denied', 'Only an owner or admin can adjust credits');
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'Give a reason for the adjustment');
  if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 100) {
    throw new HttpsError('invalid-argument', 'Adjust by a whole number of sessions, 1 to 100');
  }
  const school = schoolRef(db, input.schoolId);
  const idemRef = school.collection('idempotency').doc(`adjustCredits_${input.idempotencyKey}`);
  const studentRef = school.collection('students').doc(input.studentId);

  return db.runTransaction(async (tx) => {
    const [idem, studentSnap] = await readAll(tx, idemRef, studentRef);
    if (idem.exists) {
      if (idem.get('studentId') !== input.studentId || idem.get('delta') !== input.delta) {
        throw new HttpsError('already-exists', 'This idempotency key was already used for a different adjustment');
      }
      return idem.get('result') as AdjustCreditsResult;
    }
    if (!studentSnap.exists) notFound('Student');
    const ct = new CreditTx(tx, school, actor, at);
    const key = `adjustCredits:${input.idempotencyKey}`;
    const touched: string[] = [];
    let settled = 0;

    // ---- reads ----
    let target: LotState | null = null;
    let candidates: LotState[] = [];
    let owed: DocumentSnapshot[] = [];
    if (input.enrolmentId) {
      const snap = await tx.get(school.collection('enrolments').doc(input.enrolmentId));
      if (!snap.exists || snap.get('studentId') !== input.studentId) notFound('Package for this student');
      target = ct.useLot(snap);
      if (target.status === 'void' || target.status === 'expired') {
        throw new HttpsError('failed-precondition', `That package is ${target.status}`);
      }
    } else if (input.delta < 0) {
      candidates = await readActiveLots(ct, input.studentId);
    } else {
      owed = await readOwed(ct, input.schoolId, input.studentId);
    }

    // ---- writes ----
    if (target) {
      if (target.remaining + input.delta < 0) {
        throw new HttpsError('failed-precondition', `That package only has ${target.remaining} left`);
      }
      ct.adjust(target, input.delta, reason, key);
      touched.push(target.id);
    } else if (input.delta < 0) {
      let left = -input.delta;
      const available = candidates.filter((l) => l.status === 'active').reduce((n, l) => n + l.remaining, 0);
      if (available < left) throw new HttpsError('failed-precondition', `This student only has ${available} left`);
      while (left > 0) {
        const lot = pickLot(candidates, 0)!;
        const take = Math.min(left, lot.remaining);
        ct.adjust(lot, -take, reason, `${key}:${lot.id}`);
        touched.push(lot.id);
        left -= take;
      }
    } else {
      const lotRef = school.collection('enrolments').doc();
      const validUntil = Timestamp.fromDate(
        input.validityDays ? new Date(at.getTime() + input.validityDays * DAY_MS) : NO_EXPIRY,
      );
      const lot = ct.newLot(
        lotRef,
        {
          studentId: input.studentId,
          packageId: null,
          packageName: 'Manual credit',
          invoiceId: null,
          validFrom: Timestamp.fromDate(at),
          validUntil,
        },
        input.delta,
        { type: 'adjust', reason, idempotencyKey: `${key}:grant` },
      );
      settled = ct.settleOwed(lot, owed, key);
      touched.push(lot.id);
    }
    ct.flush();

    const result: AdjustCreditsResult = { delta: input.delta, enrolmentIds: touched, settled };
    tx.create(idemRef, { studentId: input.studentId, delta: input.delta, result, actorUid: actor.uid, createdAt: now() });
    audit(tx, school, actor, 'adjustCredits', `students/${input.studentId}`, { delta: input.delta, reason, lots: touched, settled });
    return result;
  });
}
