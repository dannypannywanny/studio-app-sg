// The opening-balances sheet: Classcard can't say how many sessions each student has left (the API
// doesn't expose it, and some attendance was never marked), so the owner fills that in by hand.
//
//   1. Make the sheet (one row per student with a Classcard invoice since the activity file starts):
//        pnpm --filter functions exec tsx scripts/migrate/balances-sheet.ts --make \
//          --export ~/Downloads/students.csv --activity ../migration/raw/classcard-activity.tsv
//      Students added after the export: add a row with `row` blank and their Classcard `code`.
//   2. Fill in `sessionsLeft` for EVERY row (0 if none), `validUntil` (YYYY-MM-DD or "none") where
//      sessionsLeft > 0, and `moneyCreditSGD` where they have money credit (blank = 0).
//   3. Turn it into migration/raw/opening-balances.json (refused, with the reasons, if anything's off).
//      Unpaid invoices come straight from the activity file (they matched Classcard's outstanding total):
//        pnpm --filter functions exec tsx scripts/migrate/balances-sheet.ts --to-json --export ~/Downloads/students.csv
//
// No database access: it only reads and writes files in migration/raw/ (gitignored, personal data).
// Students are keyed by export row (`row:<n>`), matching a wholesale import, so blank or shared
// Classcard codes still work.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvToObjects, mapClasscardRows, type ImportCandidate } from '@lessonkaki/shared';
import { checkOpeningBalances, type OpeningBalances } from '../../src/migrate';
import { argValue } from '../target';

const RAW = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migration/raw');
const SHEET = resolve(RAW, 'balances-sheet.csv');
const OUT = resolve(RAW, 'opening-balances.json');
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

const COLUMNS = [
  'row', 'code', 'firstName', 'lastName', 'email', 'exportStatus',
  'invoices', 'latestInvoice', 'latestDate', 'latestSGD', 'unpaidSGD',
  'sessionsLeft', 'validUntil', 'moneyCreditSGD', 'packageName', 'note',
] as const;
type SheetRow = Record<(typeof COLUMNS)[number], string>;

interface Activity { ccId: string; code: string; email: string; invoice: string; date: string; amountSGD: number; status: string }

function readActivity(file: string): Activity[] {
  const lines = readFileSync(expand(file), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const [head, ...rest] = lines.map((l) => l.split('\t'));
  return rest.map((cells) => {
    const r = Object.fromEntries(head!.map((h, i) => [h, (cells[i] ?? '').trim()]));
    return { ccId: r.ccId!, code: r.code!, email: r.email!.toLowerCase(), invoice: r.invoice!, date: r.date!, amountSGD: Number(r.amountSGD), status: r.status! };
  });
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** Classcard student (by code, or by email when the code is blank or shared) -> export row. */
function matchRow(a: Activity, students: ImportCandidate[]): ImportCandidate | string {
  const byCode = a.code ? students.filter((s) => s.legacyId === a.code) : [];
  if (byCode.length === 1) return byCode[0]!;
  const pool = byCode.length > 1 ? byCode : students;
  let byEmail = a.email ? pool.filter((s) => s.email === a.email) : [];
  // Same email on two rows, and Classcard has no code for this one: it's the row without a code.
  if (byEmail.length > 1 && !a.code) byEmail = byEmail.filter((s) => !s.legacyId);
  if (byEmail.length === 1) return byEmail[0]!;
  return `Classcard student ${a.code || a.email || a.ccId}: ${byCode.length + byEmail.length ? 'more than one' : 'no'} export row matches`;
}

function make() {
  const exportFile = argValue(process.argv, 'export');
  const activityFile = argValue(process.argv, 'activity') ?? resolve(RAW, 'classcard-activity.tsv');
  if (!exportFile) throw new Error('Give --export <students.csv>');
  const students = mapClasscardRows(csvToObjects(readFileSync(expand(exportFile), 'utf8')).rows);
  const activity = readActivity(activityFile);

  const byRow = new Map<number, { student: ImportCandidate; invoices: Activity[] }>();
  const unmatched = new Set<string>();
  for (const a of activity) {
    const hit = matchRow(a, students);
    if (typeof hit === 'string') {
      unmatched.add(hit);
      continue;
    }
    const entry = byRow.get(hit.row) ?? { student: hit, invoices: [] };
    entry.invoices.push(a);
    byRow.set(hit.row, entry);
  }

  const rows: SheetRow[] = [...byRow.values()]
    .map(({ student: s, invoices }) => {
      const latest = [...invoices].sort((x, y) => x.date.localeCompare(y.date)).at(-1)!;
      const unpaid = invoices.filter((i) => i.status !== 'Paid').reduce((sum, i) => sum + i.amountSGD, 0);
      return {
        row: String(s.row), code: s.legacyId ?? '', firstName: s.firstName, lastName: s.lastName ?? '', email: s.email ?? '',
        exportStatus: s.status, invoices: String(invoices.length), latestInvoice: latest.invoice, latestDate: latest.date,
        latestSGD: String(latest.amountSGD), unpaidSGD: unpaid ? String(unpaid) : '',
        sessionsLeft: '', validUntil: '', moneyCreditSGD: '', packageName: '', note: '',
      };
    })
    .sort((x, y) => y.latestDate.localeCompare(x.latestDate));
  writeFileSync(SHEET, [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
  console.log(`Sheet: ${rows.length} students (${SHEET}, gitignored).`);
  if (unmatched.size) console.log(`Not in the export (add them in the app, then add a row by hand):\n  ${[...unmatched].join('\n  ')}`);
}

function toJson() {
  const { rows } = csvToObjects(readFileSync(argValue(process.argv, 'sheet') ?? SHEET, 'utf8'));
  const problems: string[] = [];
  const balances: OpeningBalances = { source: `balances sheet, ${new Date().toISOString().slice(0, 10)}`, lots: [], moneyCredits: [], expected: { students: 0, sessions: 0, moneyCreditCents: 0 } };
  const withBalance = new Set<string>();
  for (const r of rows) {
    const who = `row ${r.row || '-'} (${r.code || 'no code'})`;
    // Students added after the export (no export row) are found by their Classcard code instead.
    const studentId = (r.row ?? '').trim() ? `row:${r.row}` : (r.code ?? '').trim();
    if (!studentId) {
      problems.push(`${who}: needs an export row or a Classcard code`);
      continue;
    }
    const left = (r.sessionsLeft ?? '').trim();
    if (!/^\d+$/.test(left)) {
      problems.push(`${who}: sessionsLeft must be a whole number (0 if none), not "${left}"`);
      continue;
    }
    const sessions = Number(left);
    const until = (r.validUntil ?? '').trim().toLowerCase();
    if (sessions > 0) {
      if (until !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(until)) problems.push(`${who}: validUntil must be YYYY-MM-DD or "none"`);
      balances.lots.push({
        legacyLotId: `sheet-${studentId}`, legacyStudentId: studentId, packageName: (r.packageName ?? '').trim() || 'Migrated from Classcard',
        sessionsRemaining: sessions, validUntil: until === 'none' ? null : until, legacyInvoiceNumber: (r.latestInvoice ?? '').trim() || null,
      });
      balances.expected.sessions += sessions;
      withBalance.add(studentId);
    }
    const money = (r.moneyCreditSGD ?? '').trim();
    if (money) {
      if (!/^\d+(\.\d{1,2})?$/.test(money)) problems.push(`${who}: moneyCreditSGD must be like 45 or 45.50`);
      else if (Number(money) > 0) {
        const cents = Math.round(Number(money) * 100);
        balances.moneyCredits.push({ legacyStudentId: studentId, cents });
        balances.expected.moneyCreditCents += cents;
        withBalance.add(studentId);
      }
    }
  }
  balances.expected.students = withBalance.size;

  // Unpaid Classcard invoices -> open invoices, matched to export rows the same way as --make.
  const exportFile = argValue(process.argv, 'export');
  if (!exportFile) problems.push('Give --export <students.csv> (to place the unpaid invoices)');
  else {
    const students = mapClasscardRows(csvToObjects(readFileSync(expand(exportFile), 'utf8')).rows);
    const activity = readActivity(argValue(process.argv, 'activity') ?? resolve(RAW, 'classcard-activity.tsv'));
    balances.openInvoices = [];
    for (const a of activity.filter((x) => x.status !== 'Paid')) {
      const hit = matchRow(a, students);
      if (typeof hit === 'string') {
        problems.push(`unpaid invoice ${a.invoice}: ${hit}`);
        continue;
      }
      balances.openInvoices.push({ legacyInvoiceNumber: a.invoice, legacyStudentId: `row:${hit.row}`, issueDate: a.date, dueDate: a.date, amountCents: Math.round(a.amountSGD * 100) });
    }
    balances.expected.outstandingCents = balances.openInvoices.reduce((sum, i) => sum + i.amountCents, 0);
  }
  problems.push(...checkOpeningBalances(balances));
  if (problems.length) {
    console.error(`Not written. Fix the sheet:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const out = argValue(process.argv, 'out') ? expand(argValue(process.argv, 'out')!) : OUT;
  writeFileSync(out, JSON.stringify(balances, null, 2) + '\n');
  const { students, sessions, moneyCreditCents, outstandingCents = 0 } = balances.expected;
  console.log(
    `Written ${out}: ${students} students, ${sessions} sessions, S$${(moneyCreditCents / 100).toFixed(2)} money credit, ` +
      `${balances.openInvoices?.length ?? 0} open invoices (S$${(outstandingCents / 100).toFixed(2)}).`,
  );
}

if (process.argv.includes('--make')) make();
else if (process.argv.includes('--to-json')) toJson();
else console.error('Give --make or --to-json');
