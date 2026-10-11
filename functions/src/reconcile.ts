import type { Firestore } from 'firebase-admin/firestore';
import { schoolRef } from './db';

/**
 * Checks one student's credits against the ledger. Returns a list of problems (empty = consistent).
 * Used by the tests now and by the nightly reconcileLedger job later (M2).
 *
 *  - each lot: sessionsRemaining == sum of ledger deltas for that lot
 *  - each lot: sessionsTotal == sessionsRemaining + sessionsUsed + sessionsExpired
 *  - summary.sessionsAvailable == sum of remaining over active/completed lots
 *  - summary.sessionsOwed == number of attendees still marked owed
 *  - summary.outstandingCents == sum of pendingCents over sent/partial invoices
 *  - summary.moneyCreditCents == sum of the student's moneyLedger deltas
 */
export async function reconcileStudent(db: Firestore, schoolId: string, studentId: string): Promise<string[]> {
  const school = schoolRef(db, schoolId);
  const [studentSnap, lots, ledger, owed, invoices, money] = await Promise.all([
    school.collection('students').doc(studentId).get(),
    school.collection('enrolments').where('studentId', '==', studentId).get(),
    school.collection('ledger').where('studentId', '==', studentId).get(),
    db
      .collectionGroup('attendees')
      .where('schoolId', '==', schoolId)
      .where('studentId', '==', studentId)
      .where('owed', '==', true)
      .get(),
    school.collection('invoices').where('studentId', '==', studentId).get(),
    school.collection('moneyLedger').where('studentId', '==', studentId).get(),
  ]);

  const problems: string[] = [];
  const deltaByLot = new Map<string, number>();
  for (const e of ledger.docs) {
    const lotId = e.get('enrolmentId') as string | null;
    if (lotId) deltaByLot.set(lotId, (deltaByLot.get(lotId) ?? 0) + (e.get('delta') as number));
  }

  let available = 0;
  for (const lot of lots.docs) {
    const remaining = lot.get('sessionsRemaining') as number;
    const sum = deltaByLot.get(lot.id) ?? 0;
    if (sum !== remaining) problems.push(`lot ${lot.id}: sessionsRemaining ${remaining} != ledger sum ${sum}`);
    const total = lot.get('sessionsTotal') as number;
    const accounted = remaining + (lot.get('sessionsUsed') as number) + ((lot.get('sessionsExpired') as number) ?? 0);
    if (total !== accounted) problems.push(`lot ${lot.id}: total ${total} != remaining+used+expired ${accounted}`);
    if (['active', 'completed'].includes(lot.get('status') as string)) available += remaining;
  }

  const summary = (studentSnap.get('summary') ?? {}) as {
    sessionsAvailable?: number;
    sessionsOwed?: number;
    outstandingCents?: number;
    moneyCreditCents?: number;
  };
  if ((summary.sessionsAvailable ?? 0) !== available) {
    problems.push(`summary.sessionsAvailable ${summary.sessionsAvailable ?? 0} != lots ${available}`);
  }
  if ((summary.sessionsOwed ?? 0) !== owed.size) {
    problems.push(`summary.sessionsOwed ${summary.sessionsOwed ?? 0} != owed attendees ${owed.size}`);
  }

  const outstanding = invoices.docs
    .filter((d) => ['sent', 'partial'].includes(d.get('status') as string))
    .reduce((sum, d) => sum + (d.get('pendingCents') as number), 0);
  if ((summary.outstandingCents ?? 0) !== outstanding) {
    problems.push(`summary.outstandingCents ${summary.outstandingCents ?? 0} != invoices ${outstanding}`);
  }
  const credit = money.docs.reduce((sum, d) => sum + (d.get('deltaCents') as number), 0);
  if ((summary.moneyCreditCents ?? 0) !== credit) {
    problems.push(`summary.moneyCreditCents ${summary.moneyCreditCents ?? 0} != moneyLedger ${credit}`);
  }
  return problems;
}
