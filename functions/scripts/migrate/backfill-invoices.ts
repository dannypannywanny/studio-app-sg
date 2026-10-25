// Creates the *paid* Classcard invoices the replay left out and links each replayed package (enrolment) to its
// invoice. Unpaid ones already exist (opening-balances.ts, id cc-<number>) and are only linked.
// Dry run unless --apply; counts only. Emulator by default, production only with --project class-app-sg.
//
//   pnpm --filter functions exec tsx scripts/migrate/backfill-invoices.ts --project class-app-sg [--raw <dir>] [--apply]
//
// Reads <raw>/replay-plan.json (lots: key, invoiceId, invoiceNumber; studentKeys) and classcard-activity.tsv
// (invoice number -> date, amount, status), plus the optional classcard-invoices-older.tsv (paid invoices before
// the replay window) and classcard-discounts.tsv (`number<TAB>discount SGD`, from list_invoices).
//
// - Packages are the replay's enrolments `cc-<lot key>`: a key is `<invoiceId>-<n>` when one invoice paid for
//   several package rows, so those are all linked to the one invoice.
// - Paid invoices with no package (e.g. S$0 / 100% discount with no lesson booked on it) are still created, for
//   the student the replay mapped them to, with no package link. `--packages <json>` gives such an invoice its
//   package: `{ "<number>": { "ccInvoiceId": "123", "sessions": 4, "packageName": "...", "validFrom": "YYYY-MM-DD",
//   "validUntil": "YYYY-MM-DD" } }`. It becomes a `migrate` lot `cc-<ccInvoiceId>` (as the replay names them),
//   settles owed lessons inside its validity, and expires at once if its date has passed.
// - A Classcard discount is kept: subtotal = net + discount. Earlier runs wrote S$0 invoices without it; those
//   (createdBy this script, total 0, no discount) are corrected when the discount is known.
// Idempotent: fixed id `cc-<number>`; existing docs are otherwise never overwritten. No payment/alert is raised;
// the only side effect is onInvoiceWritten rendering the PDF.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { wallClockToUtc } from '@lessonkaki/shared';
import { CreditTx, readOwed } from '../../src/creditTx';
import { argValue, initTarget } from '../target';

interface Act { ccId: string | null; date: string; cents: number; status: string; discountCents: number }
interface NewPackage { ccInvoiceId: string; sessions: number; packageName: string; validFrom: string; validUntil: string }

function tsv(file: string, optional = false): string[][] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
  } catch (err) {
    if (optional) return [];
    throw err;
  }
}

async function main() {
  initTarget();
  const db = getFirestore();
  const schoolId = argValue(process.argv, 'school') ?? 'sywh';
  const apply = process.argv.includes('--apply');
  const school = db.doc(`schools/${schoolId}`);
  const raw = resolve(argValue(process.argv, 'raw') ?? '../migration/raw/');
  const plan = JSON.parse(readFileSync(`${raw}/replay-plan.json`, 'utf8')) as {
    plan: { lots: { key: string; invoiceId: string; invoiceNumber: string | null }[] };
    studentKeys: Record<string, string>;
  };

  const packagesFile = argValue(process.argv, 'packages');
  const packages = (packagesFile ? JSON.parse(readFileSync(resolve(packagesFile), 'utf8')) : {}) as Record<string, NewPackage>;
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  for (const [n, p] of Object.entries(packages)) {
    if (!/^\d+$/.test(p.ccInvoiceId) || !Number.isInteger(p.sessions) || p.sessions <= 0 || !p.packageName || !ymd.test(p.validFrom) || !ymd.test(p.validUntil)) {
      throw new Error(`--packages: entry ${n} is incomplete or malformed`);
    }
  }
  const discounts = new Map(tsv(`${raw}/classcard-discounts.tsv`, true).filter((p) => p.length >= 2).map((p) => [p[0]!, Math.round(Number(p[1]) * 100)]));
  const act = new Map<string, Act>();
  const older = new Map<string, string>(); // ccInvoiceId -> invoice number
  // Older paid invoices: ccInvoiceId, number, date, net SGD, discount SGD.
  for (const p of tsv(`${raw}/classcard-invoices-older.tsv`, true)) {
    if (p.length < 5) continue;
    act.set(p[1]!, { ccId: null, date: p[2]!, cents: Math.round(Number(p[3]) * 100), status: 'Paid', discountCents: Math.round(Number(p[4]) * 100) });
    older.set(p[0]!, p[1]!);
  }
  // Since the replay window: ccId, code, email, invoice, date, amountSGD, status.
  for (const p of tsv(`${raw}/classcard-activity.tsv`)) {
    if (p[0] === 'ccId' || p.length < 7) continue;
    act.set(p[3]!, { ccId: p[0]!, date: p[4]!, cents: Math.round(Number(p[5]) * 100), status: p[6]!, discountCents: discounts.get(p[3]!) ?? 0 });
  }

  // Replay student keys -> student doc ids (resolved as applyReplay does).
  const byCode = new Map<string, string[]>();
  for (const d of (await school.collection('students').get()).docs) {
    const code = d.get('legacyId') as string | null;
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), d.id]);
  }
  const studentOf = async (key: string | undefined): Promise<string | null> => {
    if (!key) return null;
    if (key.startsWith('doc:')) return (await school.collection('students').doc(key.slice(4)).get()).exists ? key.slice(4) : null;
    const ids = byCode.get(key.slice(5)) ?? [];
    return ids.length === 1 ? ids[0]! : null;
  };

  const currency = ((await school.get()).get('currency') as string | undefined) ?? 'SGD';
  const c = { toCreate: 0, withoutPackage: 0, unpaidExisting: 0, alreadyThere: 0, discountFixed: 0, noInvoiceData: 0, noStudent: 0, cents: 0, linkOnly: 0 };
  const byNumber = new Map<string, string[]>(); // invoice number -> lot ids (one invoice can fund several rows)
  for (const l of plan.plan.lots) {
    const number = l.invoiceNumber ?? older.get(l.invoiceId);
    if (!number || !act.has(number)) { c.noInvoiceData += 1; continue; }
    byNumber.set(number, [...(byNumber.get(number) ?? []), `cc-${l.key}`]);
  }
  for (const n of act.keys()) if (!byNumber.has(n)) byNumber.set(n, []); // invoices no package came from
  const noStudent: string[] = [];

  for (const [number, lotIds] of byNumber) {
    const a = act.get(number)!;
    const live = (await Promise.all(lotIds.map((id) => school.collection('enrolments').doc(id).get()))).filter((s) => s.exists);
    const studentId = (live[0]?.get('studentId') as string | undefined) ?? (a.ccId ? await studentOf(plan.studentKeys[a.ccId]) : null);
    if (!studentId) { c.noStudent += 1; noStudent.push(number); continue; }
    const ref = school.collection('invoices').doc(`cc-${number}`);
    const snap = await ref.get();
    const subtotal = a.cents + a.discountCents;
    const fixDiscount = snap.exists && snap.get('createdBy') === 'script:backfill-invoices' && snap.get('totalCents') === 0
      && !snap.get('discountCents') && a.discountCents > 0;
    if (a.status !== 'Paid') c.unpaidExisting += 1;
    else if (snap.exists) { c.alreadyThere += 1; if (fixDiscount) c.discountFixed += 1; }
    else { c.toCreate += 1; c.cents += a.cents; if (!live.length) c.withoutPackage += 1; }
    c.linkOnly += live.filter((s) => !s.get('invoiceId')).length;
    if (!apply) continue;
    const day = Timestamp.fromDate(new Date(`${a.date}T09:00:00+08:00`));
    if (a.status === 'Paid' && !snap.exists) {
      await ref.create({
        number: `CC-${number}`, legacyInvoiceNumber: number, studentId, currency,
        lines: [{ desc: `Classcard invoice ${number}`, qty: 1, unitCents: subtotal, enrolmentId: live[0]?.id ?? null }],
        subtotalCents: subtotal, discountCents: a.discountCents, moneyCreditAppliedCents: 0, totalCents: a.cents, paidCents: a.cents, pendingCents: 0,
        status: 'paid', overdueSince: null, paidAt: day, issueDate: day, dueDate: day,
        createdBy: 'script:backfill-invoices', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (fixDiscount) {
      const ls = (snap.get('lines') as { unitCents: number }[]).map((l, i) => (i === 0 ? { ...l, unitCents: subtotal } : l));
      await ref.update({ lines: ls, subtotalCents: subtotal, discountCents: a.discountCents, updatedAt: FieldValue.serverTimestamp() });
    }
    for (const s of live) if (!s.get('invoiceId')) await s.ref.update({ invoiceId: ref.id, updatedAt: FieldValue.serverTimestamp() });
  }

  // Packages for invoices that had none.
  const tz = ((await school.get()).get('timezone') as string | undefined) ?? 'Asia/Singapore';
  const actor = { uid: 'script:backfill-invoices', role: 'system' as const };
  const p = { packagesToCreate: 0, packagesThere: 0, settled: 0, expiredSessions: 0 };
  for (const [number, pkg] of Object.entries(packages)) {
    if (!act.has(number)) throw new Error(`--packages: invoice ${number} is not in the Classcard data`);
    if (byNumber.get(number)?.length) throw new Error(`--packages: invoice ${number} already has a replayed package`);
    const invRef = school.collection('invoices').doc(`cc-${number}`);
    const lotRef = school.collection('enrolments').doc(`cc-${pkg.ccInvoiceId}`);
    if ((await lotRef.get()).exists) { p.packagesThere += 1; continue; }
    p.packagesToCreate += 1;
    if (!apply) continue;
    const at = new Date();
    const r = await db.runTransaction(async (tx) => {
      const idem = school.collection('idempotency').doc(`backfillPackage_${number}`);
      const [idemSnap, inv] = await Promise.all([tx.get(idem), tx.get(invRef)]);
      if (idemSnap.exists) return { settled: 0, expired: 0 };
      if (!inv.exists) throw new Error(`invoice cc-${number} does not exist`);
      const studentId = inv.get('studentId') as string;
      const validFrom = Timestamp.fromDate(wallClockToUtc(pkg.validFrom, '00:00', tz));
      const validUntil = Timestamp.fromDate(new Date(wallClockToUtc(pkg.validUntil, '23:59', tz).getTime() + 59_999));
      const ct = new CreditTx(tx, school, actor, at);
      const owed = (await readOwed(ct, schoolId, studentId)).filter((a) => (a.get('lessonStartAt') as Timestamp).toMillis() >= validFrom.toMillis());
      const key = `backfillPackage:${number}`;
      const lot = ct.newLot(
        lotRef,
        { studentId, packageId: null, packageName: pkg.packageName, invoiceId: invRef.id, legacyId: `replay:${pkg.ccInvoiceId}`, legacyInvoiceNumber: number, validFrom, validUntil },
        pkg.sessions,
        { type: 'migrate', reason: `From Classcard (invoice ${number})`, idempotencyKey: `${key}:grant` },
      );
      const settled = ct.settleOwed(lot, owed, key, invRef.id);
      const expired = lot.validUntilMs < at.getTime() ? ct.expireRemaining(lot, `expireLots:${lot.id}:${lot.validUntilMs}`, 'Package expired') : 0;
      ct.flush();
      const ls = inv.get('lines') as { enrolmentId?: string | null }[];
      tx.update(invRef, { lines: ls.map((l, i) => (i === 0 && !l.enrolmentId ? { ...l, enrolmentId: lotRef.id } : l)), updatedAt: FieldValue.serverTimestamp() });
      tx.create(idem, { invoiceNumber: number, lotId: lotRef.id, studentId, createdAt: FieldValue.serverTimestamp() });
      return { settled, expired };
    });
    p.settled += r.settled;
    p.expiredSessions += r.expired;
  }
  if (Object.keys(packages).length) console.log(apply ? 'Packages applied:' : 'Packages, dry run:', p);
  console.log(apply ? 'Applied:' : 'Dry run, would apply:', { ...c, totalSGD: c.cents / 100 });
  if (noStudent.length) console.log(`No student found for invoice(s): ${noStudent.join(', ')}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
