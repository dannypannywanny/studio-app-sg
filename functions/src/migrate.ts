// Migration from Classcard: opening balances. Credits per enrolment ("lot") and money credit, as read
// from Classcard (MCP, read-only, plus Daniel's reads of each student's Enrollments panel), arrive as
// an OpeningBalances file in migration/raw/ (never in git). Each lot becomes a `migrate` grant on a new
// lot; money credit becomes a `migrate` moneyLedger entry. Idempotent per legacy lot / student, so a
// re-run after fixing the file only adds what is missing.
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { NO_EXPIRY, wallClockToUtc } from '@lessonkaki/shared';
import { CreditTx } from './creditTx';
import { audit, now, schoolRef, type Actor } from './db';

export interface OpeningLot {
  /** Stable id for the Classcard enrolment (e.g. its invoice number + package). */
  legacyLotId: string;
  /** The Classcard code (legacyId), or `row:<n>` for a student imported wholesale from export row n. */
  legacyStudentId: string;
  packageName: string;
  sessionsRemaining: number;
  /** 'YYYY-MM-DD' (last valid day, school time) or null for no expiry. */
  validUntil: string | null;
  legacyInvoiceNumber: string | null;
}

/** An invoice still unpaid in Classcard, re-created as an open (sent) invoice. */
export interface OpenInvoice {
  legacyInvoiceNumber: string;
  legacyStudentId: string;
  /** 'YYYY-MM-DD', school time. */
  issueDate: string;
  dueDate: string;
  amountCents: number;
}

export interface OpeningBalances {
  /** Where the numbers came from, kept in the audit log. */
  source: string;
  lots: OpeningLot[];
  moneyCredits: { legacyStudentId: string; cents: number }[];
  openInvoices?: OpenInvoice[];
  /** Totals from Classcard, checked after applying. */
  expected: MigrationTotals;
}

export interface MigrationTotals {
  /** Students with migrated sessions or money credit. */
  students: number;
  sessions: number;
  moneyCreditCents: number;
  /** Pending cents on migrated (Classcard) invoices; checked only when given. */
  outstandingCents?: number;
}

/**
 * Everything wrong with a balances file, as readable lines (empty = OK). A blank or invalid entry must
 * stop the whole run: applying would silently skip it, and the file is filled in by hand.
 */
export function checkOpeningBalances(b: OpeningBalances): string[] {
  const problems: string[] = [];
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const lotIds = new Set<string>();
  (b.lots ?? []).forEach((lot, i) => {
    const at = `lots[${i}]${lot.legacyLotId ? ` (${lot.legacyLotId})` : ''}`;
    if (!lot.legacyLotId) problems.push(`${at}: legacyLotId is missing`);
    else if (lotIds.has(lot.legacyLotId)) problems.push(`${at}: legacyLotId is used twice`);
    else lotIds.add(lot.legacyLotId);
    if (!lot.legacyStudentId) problems.push(`${at}: legacyStudentId is missing`);
    if (!lot.packageName) problems.push(`${at}: packageName is missing`);
    if (!count(lot.sessionsRemaining)) problems.push(`${at}: sessionsRemaining must be a whole number >= 0`);
    if (lot.validUntil !== null && !(typeof lot.validUntil === 'string' && isDate(lot.validUntil))) {
      problems.push(`${at}: validUntil must be YYYY-MM-DD or null (no expiry)`);
    }
  });
  const moneyIds = new Set<string>();
  (b.moneyCredits ?? []).forEach((m, i) => {
    const at = `moneyCredits[${i}]${m.legacyStudentId ? ` (${m.legacyStudentId})` : ''}`;
    if (!m.legacyStudentId) problems.push(`${at}: legacyStudentId is missing`);
    else if (moneyIds.has(m.legacyStudentId)) problems.push(`${at}: student listed twice`);
    else moneyIds.add(m.legacyStudentId);
    if (!count(m.cents)) problems.push(`${at}: cents must be a whole number >= 0`);
  });
  const invoiceNos = new Set<string>();
  (b.openInvoices ?? []).forEach((inv, i) => {
    const at = `openInvoices[${i}]${inv.legacyInvoiceNumber ? ` (${inv.legacyInvoiceNumber})` : ''}`;
    if (!inv.legacyInvoiceNumber || !/^[A-Za-z0-9-]{1,30}$/.test(inv.legacyInvoiceNumber)) problems.push(`${at}: legacyInvoiceNumber is missing or odd`);
    else if (invoiceNos.has(inv.legacyInvoiceNumber)) problems.push(`${at}: listed twice`);
    else invoiceNos.add(inv.legacyInvoiceNumber);
    if (!inv.legacyStudentId) problems.push(`${at}: legacyStudentId is missing`);
    if (!isDate(inv.issueDate ?? '') || !isDate(inv.dueDate ?? '')) problems.push(`${at}: issueDate and dueDate must be YYYY-MM-DD`);
    if (!count(inv.amountCents) || inv.amountCents === 0) problems.push(`${at}: amountCents must be a whole number > 0`);
  });
  for (const key of ['students', 'sessions', 'moneyCreditCents'] as const) {
    if (!count(b.expected?.[key])) problems.push(`expected.${key} must be a whole number >= 0`);
  }
  if (b.expected?.outstandingCents !== undefined && !count(b.expected.outstandingCents)) {
    problems.push('expected.outstandingCents must be a whole number >= 0');
  }
  return problems;
}

export async function applyOpeningBalances(
  db: Firestore,
  schoolId: string,
  balances: OpeningBalances,
  actor: Actor,
  at: Date = new Date(),
): Promise<{ lotsCreated: number; moneyCreditsCreated: number; invoicesCreated: number; unknownStudents: string[] }> {
  const problems = checkOpeningBalances(balances);
  if (problems.length) throw new Error(`Opening balances file has problems:\n  ${problems.join('\n  ')}`);
  const school = schoolRef(db, schoolId);
  const tz = ((await school.get()).get('timezone') as string | undefined) ?? 'Asia/Singapore';
  // Students are found by Classcard code, or by export row (`row:<n>`) when the code is blank or shared.
  const students = await school.collection('students').get();
  const byLegacy = new Map<string, string>();
  const shared = new Set<string>(); // a code two students carry can't say which one: use `row:<n>`
  for (const d of students.docs) {
    const code = d.get('legacyId') as string | null;
    if (code && byLegacy.has(code)) shared.add(code);
    else if (code) byLegacy.set(code, d.id);
    if (typeof d.get('importRow') === 'number') byLegacy.set(`row:${d.get('importRow')}`, d.id);
  }
  for (const code of shared) byLegacy.delete(code);
  const unknown = new Set<string>();
  let lotsCreated = 0;
  let moneyCreditsCreated = 0;

  for (const lot of balances.lots) {
    const studentId = byLegacy.get(lot.legacyStudentId);
    if (!studentId) {
      unknown.add(lot.legacyStudentId);
      continue;
    }
    if (!Number.isInteger(lot.sessionsRemaining) || lot.sessionsRemaining <= 0) continue;
    const created = await db.runTransaction(async (tx) => {
      const idem = school.collection('idempotency').doc(`migrateLot_${lot.legacyLotId}`);
      if ((await tx.get(idem)).exists) return false;
      const ct = new CreditTx(tx, school, actor, at);
      // Valid through the end of the last day, in the school's zone.
      const validUntil = lot.validUntil ? Timestamp.fromDate(new Date(wallClockToUtc(lot.validUntil, '23:59', tz).getTime() + 59_999)) : Timestamp.fromDate(NO_EXPIRY);
      ct.newLot(
        school.collection('enrolments').doc(),
        {
          studentId,
          packageId: null,
          packageName: lot.packageName,
          invoiceId: null,
          legacyId: lot.legacyLotId,
          legacyInvoiceNumber: lot.legacyInvoiceNumber,
          validFrom: Timestamp.fromDate(at),
          validUntil,
        },
        lot.sessionsRemaining,
        { type: 'migrate', reason: `Opening balance from Classcard (${balances.source})`, idempotencyKey: `migrateLot:${lot.legacyLotId}` },
      );
      ct.flush();
      tx.create(idem, { legacyLotId: lot.legacyLotId, studentId, createdAt: now() });
      return true;
    });
    if (created) lotsCreated += 1;
  }

  for (const m of balances.moneyCredits) {
    const studentId = byLegacy.get(m.legacyStudentId);
    if (!studentId) {
      unknown.add(m.legacyStudentId);
      continue;
    }
    if (!Number.isInteger(m.cents) || m.cents <= 0) continue;
    const created = await db.runTransaction(async (tx) => {
      const idem = school.collection('idempotency').doc(`migrateMoney_${m.legacyStudentId}`);
      if ((await tx.get(idem)).exists) return false;
      const ct = new CreditTx(tx, school, actor, at);
      tx.create(school.collection('moneyLedger').doc(), {
        studentId,
        deltaCents: m.cents,
        type: 'migrate',
        invoiceId: null,
        paymentId: null,
        creditNoteId: null,
        reason: `Opening money credit from Classcard (${balances.source})`,
        actorUid: actor.uid,
        idempotencyKey: `migrateMoney:${m.legacyStudentId}`,
        createdAt: now(),
      });
      ct.bump(studentId, { moneyCreditCents: m.cents });
      ct.flush();
      tx.create(idem, { legacyStudentId: m.legacyStudentId, studentId, createdAt: now() });
      return true;
    });
    if (created) moneyCreditsCreated += 1;
  }

  // Unpaid Classcard invoices: open invoices numbered CC-<old number>, one fixed id each (idempotent).
  let invoicesCreated = 0;
  const currency = ((await school.get()).get('currency') as string | undefined) ?? 'SGD';
  for (const inv of balances.openInvoices ?? []) {
    const studentId = byLegacy.get(inv.legacyStudentId);
    if (!studentId) {
      unknown.add(inv.legacyStudentId);
      continue;
    }
    const created = await db.runTransaction(async (tx) => {
      const ref = school.collection('invoices').doc(`cc-${inv.legacyInvoiceNumber}`);
      if ((await tx.get(ref)).exists) return false;
      const ct = new CreditTx(tx, school, actor, at);
      const day = (d: string) => Timestamp.fromDate(wallClockToUtc(d, '09:00', tz));
      tx.create(ref, {
        number: `CC-${inv.legacyInvoiceNumber}`,
        legacyInvoiceNumber: inv.legacyInvoiceNumber,
        studentId,
        currency,
        lines: [{ desc: `Classcard invoice ${inv.legacyInvoiceNumber} (unpaid at migration)`, qty: 1, unitCents: inv.amountCents }],
        subtotalCents: inv.amountCents,
        discountCents: 0,
        moneyCreditAppliedCents: 0,
        totalCents: inv.amountCents,
        paidCents: 0,
        pendingCents: inv.amountCents,
        status: 'sent',
        overdueSince: null,
        issueDate: day(inv.issueDate),
        dueDate: day(inv.dueDate),
        createdBy: actor.uid,
        createdAt: now(),
        updatedAt: now(),
      });
      ct.bump(studentId, { outstandingCents: inv.amountCents });
      ct.flush();
      return true;
    });
    if (created) invoicesCreated += 1;
  }

  await db.runTransaction(async (tx) => {
    audit(tx, school, actor, 'applyOpeningBalances', 'migration', {
      source: balances.source,
      lotsCreated,
      moneyCreditsCreated,
      invoicesCreated,
      unknownStudents: [...unknown],
    });
  });
  return { lotsCreated, moneyCreditsCreated, invoicesCreated, unknownStudents: [...unknown] };
}

/** What the migration put in, summed, compared with Classcard's totals. */
export async function validateMigration(
  db: Firestore,
  schoolId: string,
  expected: MigrationTotals,
): Promise<{ ok: boolean; actual: MigrationTotals; diffs: string[] }> {
  const school = schoolRef(db, schoolId);
  const [ledger, money, invoices] = await Promise.all([
    school.collection('ledger').where('type', '==', 'migrate').get(),
    school.collection('moneyLedger').where('type', '==', 'migrate').get(),
    school.collection('invoices').where('legacyInvoiceNumber', '!=', null).get(),
  ]);
  const students = new Set<string>();
  let sessions = 0;
  for (const e of ledger.docs) {
    students.add(e.get('studentId') as string);
    sessions += e.get('delta') as number;
  }
  let moneyCreditCents = 0;
  for (const m of money.docs) {
    students.add(m.get('studentId') as string);
    moneyCreditCents += m.get('deltaCents') as number;
  }
  const actual: MigrationTotals = { students: students.size, sessions, moneyCreditCents };
  if (expected.outstandingCents !== undefined) {
    actual.outstandingCents = invoices.docs
      .filter((d) => ['sent', 'partial'].includes(d.get('status') as string))
      .reduce((sum, d) => sum + (d.get('pendingCents') as number), 0);
  }
  const diffs = (Object.keys(expected) as (keyof MigrationTotals)[])
    .filter((k) => expected[k] !== actual[k])
    .map((k) => `${k}: expected ${expected[k]}, found ${actual[k]}`);
  return { ok: diffs.length === 0, actual, diffs };
}
