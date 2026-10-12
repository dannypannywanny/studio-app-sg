// Lessons replay: Classcard's package invoices and lessons become lots and lessons, and the lessons
// Classcard marked are marked present, so each student's balance comes out of the ledger.
//
//   1. Plan (reads files only, no database; prints counts, never names):
//        pnpm --filter functions exec tsx scripts/migrate/replay-lessons.ts --plan \
//          --export ~/Downloads/students-2026-09-23.csv [--sizes ../migration/raw/replay-sizes.json]
//      Writes migration/raw/replay-plan.json, open-invoices.json and replay-review.md (all gitignored).
//   2. Apply (emulator by default; production only with --project class-app-sg, see ../target.ts):
//        pnpm --filter functions exec tsx scripts/migrate/replay-lessons.ts --apply
//      Idempotent. Refuses to run on a school that already has opening-balance lots from the sheet
//      (they'd be counted twice) unless --allow-existing-lots.
//
// Inputs, all in migration/raw/ (read from the classcard MCP, read-only): classcard-bookings-v2.tsv,
// booking-created.csv, classcard-calendar.tsv, classcard-activity.tsv, classcard-invoice-ids.tsv,
// classcard-students.tsv, classcard-ids.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestore } from 'firebase-admin/firestore';
import { csvToObjects, mapClasscardRows, type ImportCandidate } from '@lessonkaki/shared';
import { reconcileLedger } from '../../src/jobs';
import type { OpeningBalances } from '../../src/migrate';
import {
  applyReplay,
  planReplay,
  planTotals,
  type CcBooking,
  type CcEvent,
  type CcInvoice,
  type ReplayPlan,
} from '../../src/replay';
import { argValue, initTarget } from '../target';

const RAW = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migration/raw');
const PLAN = resolve(RAW, 'replay-plan.json');
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const flag = (n: string) => process.argv.includes(`--${n}`);

// Accounts that aren't students: Classcard demo/sample rows and the owner's own test account.
const NOT_STUDENTS_EMAIL = new Set(['sgvocalcoach@gmail.com', 'test@gmail.com', 'demo@reportcardapps.com']);

function rows(file: string): string[][] {
  return readFileSync(resolve(RAW, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split('\t').map((c) => c.trim()));
}
const tsv = (file: string) => {
  const [head, ...rest] = rows(file);
  return rest.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])) as Record<string, string>);
};

// ---- read Classcard rows ----

function readCreated(): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of readFileSync(resolve(RAW, 'booking-created.csv'), 'utf8').split('\n')) {
    const [id, t] = l.trim().split(',');
    if (id && t) out.set(id, t);
  }
  return out;
}

function readBookings(created: Map<string, string>): CcBooking[] {
  return tsv('classcard-bookings-v2.tsv').map((r) => ({
    bookingId: r.bookingId!,
    ccId: r.ccId!,
    invoiceId: r.invoiceId!,
    startUTC: r.startUTC!,
    endUTC: r.endUTC!,
    kind: r.kind as CcBooking['kind'],
    createdUTC: created.get(r.bookingId!) ?? '',
  }));
}

function readEvents(): CcEvent[] {
  return tsv('classcard-calendar.tsv').map((r) => ({
    eventId: r.eventId!,
    startUTC: r.startUTC!,
    endUTC: r.endUTC!,
    tag: r.tag as CcEvent['tag'],
    marked: r.status === 'Marked',
    classId: r.classId!,
    online: r.on === '1',
    createdUTC: r.createdUTC!,
  }));
}

function readInvoices(): CcInvoice[] {
  const idByNumber = new Map<string, string>();
  for (const r of rows('classcard-invoice-ids.tsv')) {
    const [id, number] = (r[0] ?? '').split(/\s+/);
    if (id && number) idByNumber.set(number, id);
  }
  return tsv('classcard-activity.tsv').flatMap((r) => {
    const invoiceId = idByNumber.get(r.invoice!);
    return invoiceId
      ? [{ invoiceId, number: r.invoice!, ccId: r.ccId!, date: r.date!, amountSGD: Number(r.amountSGD), paid: r.status === 'Paid' }]
      : [];
  });
}

// ---- Classcard student -> LessonKaki student ----

interface CcStudent {
  ccId: string;
  code: string;
  email: string;
  name: string;
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function ccStudents(): CcStudent[] {
  const byId = new Map<string, CcStudent>();
  for (const [ccId, code = '', email = '', first = '', last = ''] of rows('classcard-students.tsv')) {
    if (ccId) byId.set(ccId, { ccId, code, email: email.toLowerCase(), name: norm(`${first} ${last}`) });
  }
  for (const r of tsv('classcard-activity.tsv')) {
    if (!byId.has(r.ccId!)) byId.set(r.ccId!, { ccId: r.ccId!, code: r.code ?? '', email: (r.email ?? '').toLowerCase(), name: '' });
  }
  const ids = JSON.parse(readFileSync(resolve(RAW, 'classcard-ids.json'), 'utf8')) as {
    students: Record<string, { ccId: number; email?: string }>;
  };
  for (const [code, v] of Object.entries(ids.students)) {
    if (!byId.has(String(v.ccId))) byId.set(String(v.ccId), { ccId: String(v.ccId), code, email: (v.email ?? '').toLowerCase(), name: '' });
  }
  return [...byId.values()];
}

function matchStudents(exportRows: ImportCandidate[], cc: CcStudent[]) {
  const keys: Record<string, string> = {};
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const nameOf = (r: ImportCandidate) => norm(`${r.firstName} ${r.lastName}`);
  for (const s of cc) {
    if (NOT_STUDENTS_EMAIL.has(s.email) || s.code === '1') continue;
    // By email; else by Classcard code (Classcard's activity file only gives an email where the code
    // is blank or shared); else by name.
    let c = s.email ? exportRows.filter((r) => r.email === s.email) : [];
    if (!c.length && s.code) c = exportRows.filter((r) => r.legacyId === s.code);
    if (!c.length && s.name) c = exportRows.filter((r) => nameOf(r) === s.name);
    if (c.length > 1 && s.name) {
      const byName = c.filter((r) => nameOf(r) === s.name);
      if (byName.length) c = byName;
    }
    if (c.length > 1 && s.code) {
      const byCode = c.filter((r) => r.legacyId === s.code);
      if (byCode.length) c = byCode;
    }
    if (c.length > 1) {
      const active = c.filter((r) => r.status === 'active');
      if (active.length) c = active;
    }
    if (c.length > 1) ambiguous.push(s.ccId);
    if (c.length) keys[s.ccId] = `doc:ccrow-${c.sort((a, b) => a.row - b.row)[0]!.row}`;
    else if (/^SYWH(27[2-9]|2[89]\d)$/.test(s.code)) keys[s.ccId] = `code:${s.code}`; // added after the export
    else unmatched.push(s.ccId);
  }
  return { keys, unmatched, ambiguous };
}

// ---- plan ----

const sgt = (utcMinute: string) => new Date(Date.parse(`${utcMinute}:00Z`) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

function plan() {
  const exportFile = argValue(process.argv, 'export');
  if (!exportFile) throw new Error('Give --export <students.csv>');
  const exportRows = mapClasscardRows(csvToObjects(readFileSync(expand(exportFile), 'utf8')).rows);
  const created = readCreated();
  const bookings = readBookings(created);
  const missing = bookings.filter((b) => !b.createdUTC).length;
  if (missing) throw new Error(`${missing} bookings have no created time (booking-created.csv)`);
  const events = readEvents();
  const invoices = readInvoices();
  const { keys, unmatched, ambiguous } = matchStudents(exportRows, ccStudents());
  const sizesFile = argValue(process.argv, 'sizes');
  const sizes = sizesFile && existsSync(expand(sizesFile)) ? JSON.parse(readFileSync(expand(sizesFile), 'utf8')) : undefined;

  // Classcard's attendance report: lessons attended per student (some are on events with no student).
  const attended: Record<string, number> = {};
  for (const [ccId, n] of rows('classcard-attendance.tsv').map((r) => (r[0] ?? '').split(/\s+/))) {
    if (ccId && /^\d+$/.test(n ?? '')) attended[ccId] = Number(n);
  }

  const now = new Date().toISOString();
  const p = planReplay({ bookings, events, invoices, studentKeys: keys, sizes, attended, now });

  // Unpaid invoices: open CC-<no> invoices through the existing opening-balances path.
  const openInvoices: NonNullable<OpeningBalances['openInvoices']> = [];
  for (const inv of invoices.filter((i) => !i.paid)) {
    const key = keys[inv.ccId];
    if (!key) continue;
    openInvoices.push({
      legacyInvoiceNumber: inv.number,
      legacyStudentId: key.startsWith('doc:ccrow-') ? `row:${key.slice('doc:ccrow-'.length)}` : key.slice(5),
      issueDate: inv.date,
      dueDate: inv.date,
      amountCents: Math.round(inv.amountSGD * 100),
    });
  }
  const openBalances: OpeningBalances = {
    source: 'Classcard unpaid invoices, replay',
    lots: [],
    moneyCredits: [],
    openInvoices,
    expected: { students: 0, sessions: 0, moneyCreditCents: 0, outstandingCents: openInvoices.reduce((n, i) => n + i.amountCents, 0) },
  };

  writeFileSync(PLAN, JSON.stringify({ createdAt: now, plan: p }, null, 1));
  writeFileSync(resolve(RAW, 'open-invoices.json'), JSON.stringify(openBalances, null, 2));
  writeFileSync(resolve(RAW, 'replay-review.md'), review(p, unmatched));

  console.log(`Classcard students matched to LessonKaki: ${Object.keys(keys).length} (unmatched ${unmatched.length}, picked among several ${ambiguous.length})`);
  console.log('Plan:', p.stats);
  const bySource = new Map<string, number>();
  for (const l of p.lots) bySource.set(l.sizeSource, (bySource.get(l.sizeSource) ?? 0) + 1);
  console.log('Lots by how they were sized:', Object.fromEntries(bySource));
  console.log('Lots with assumed validity:', p.lots.filter((l) => l.validityAssumed).length);
  const links = new Map<string, number>();
  for (const l of p.lessons) links.set(l.link, (links.get(l.link) ?? 0) + 1);
  console.log('Lessons by how the student was found:', Object.fromEntries(links));
  console.log(
    `Duplicates dropped: ${p.duplicates}. Events without a student: ${p.unidentified.length} (marked ${p.unidentified.filter((u) => u.marked).length}).`,
  );
  console.log(
    `Attended in Classcard with no placed lesson: ${p.stats.unlinkedAttended} across ${p.unlinked.length} students ` +
      `(replay marked more than Classcard's report for ${p.attendanceExceeds} students).`,
  );
  console.log(`Packages Classcard data can't size: ${p.unsized.length}. Unmapped Classcard students: ${p.unmappedStudents.length}.`);
  console.log(`Open invoices: ${openInvoices.length}, S$${(openBalances.expected.outstandingCents! / 100).toFixed(2)}.`);
  console.log(`Written: ${PLAN}, open-invoices.json, replay-review.md (gitignored).`);
}

function review(p: ReplayPlan, unmatchedCc: string[]): string {
  const out: string[] = ['# Replay review (personal data: gitignored, do not share)', ''];
  out.push(`## Lessons with no student (${p.unidentified.length})`, '', 'Singapore time. In person = Daniel scheduled it, no booking.', '');
  for (const u of [...p.unidentified].sort((a, b) => a.startUTC.localeCompare(b.startUTC))) {
    out.push(`- ${sgt(u.startUTC)} ${u.online ? 'online' : 'in person'}, ${u.marked ? 'marked' : 'unmarked'}  (event ${u.eventId})`);
  }
  out.push('', `## Packages with no known size (${p.unsized.length})`, '', 'Used the lessons booked on it; "suggested" is the next standard size.', '');
  for (const s of p.unsized) {
    out.push(`- invoice ${s.invoiceNumber ?? `id ${s.invoiceId}`}: ${s.lessonsBooked} lessons booked, suggested ${s.suggested} (${s.reason})`);
  }
  const check = p.lots.filter((l) => l.sizeSource === 'price rule (check)');
  out.push('', `## Sized by the Dec-2025 promo price rule, please check (${check.length})`, '');
  for (const l of check) out.push(`- invoice ${l.invoiceNumber ?? l.invoiceId}: ${l.sessions} sessions`);
  out.push('', `## Classcard students with no LessonKaki student (${unmatchedCc.length})`, '', unmatchedCc.map((c) => `Classcard id ${c}`).join(', '));
  return out.join('\n') + '\n';
}

// ---- apply ----

async function apply() {
  const { plan: p, createdAt } = JSON.parse(readFileSync(PLAN, 'utf8')) as { plan: ReplayPlan; createdAt: string };
  const target = initTarget();
  const db = getFirestore();
  const schoolId = argValue(process.argv, 'school') ?? 'sywh';
  const actor = { uid: 'script:replay-lessons', role: 'system' as const };

  if (!flag('allow-existing-lots')) {
    const foreign = (await db.collection(`schools/${schoolId}/ledger`).where('type', '==', 'migrate').get()).docs.filter(
      (d) => !String(d.get('idempotencyKey')).startsWith('replayLot:'),
    );
    if (foreign.length) {
      throw new Error(
        `${schoolId} already has ${foreign.length} opening-balance entries that are not from the replay; they would be counted twice (--allow-existing-lots to override)`,
      );
    }
  }
  console.log(`Replaying plan of ${createdAt} into ${target.projectId}/${schoolId}: ${JSON.stringify(planTotals(p))}`);
  const res = await applyReplay(db, schoolId, p, actor, {
    teacherIds: { owner: argValue(process.argv, 'teacher-owner') ?? 'owner-teacher', piano: argValue(process.argv, 'teacher-piano') ?? 'piano-teacher' },
    subjectIds: { voice: argValue(process.argv, 'subject-voice') ?? 'voice', piano: argValue(process.argv, 'subject-piano') ?? 'piano' },
    concurrency: Number(argValue(process.argv, 'concurrency') ?? 1),
    onProgress: (done, total) => done % 20 === 0 && console.log(`  students ${done}/${total}`),
  });
  console.log('Applied:', JSON.stringify(res));

  // The same check the nightly job runs, and a spread of what students are left with.
  const rec = await reconcileLedger(db, schoolId);
  console.log(`Reconcile: ${rec.studentsChecked} students checked, ${rec.problemCount} problems${rec.problemCount ? ' (see auditLog)' : ''}.`);
  const students = await db.collection(`schools/${schoolId}/students`).get();
  const spread = new Map<number, number>();
  let owed = 0;
  let owedStudents = 0;
  for (const s of students.docs) {
    const sum = (s.get('summary') ?? {}) as { sessionsAvailable?: number; sessionsOwed?: number };
    if (sum.sessionsAvailable) spread.set(sum.sessionsAvailable, (spread.get(sum.sessionsAvailable) ?? 0) + 1);
    if (sum.sessionsOwed) {
      owed += sum.sessionsOwed;
      owedStudents += 1;
    }
  }
  console.log('Students by sessions left:', Object.fromEntries([...spread].sort((a, b) => a[0] - b[0])));
  console.log(`Owed lessons (marked with no lot to draw on): ${owed} across ${owedStudents} students.`);
  if (rec.problemCount || res.unknownStudents.length) process.exit(2);
}

if (flag('plan')) plan();
else if (flag('apply')) {
  apply().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else console.error('Give --plan or --apply');
