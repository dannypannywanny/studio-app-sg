// Marks open invoices whose total is S$0 (100% discount / free package) as paid; they have nothing to collect,
// and "Record payment" refuses S$0. Dry run unless --apply. Emulator by default, production only with --project class-app-sg.
//
//   pnpm --filter functions exec tsx scripts/migrate/settle-zero-invoices.ts --project class-app-sg [--apply]
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { argValue, initTarget } from '../target';

async function main(): Promise<void> {
  initTarget();
  const db = getFirestore();
  const schoolId = argValue(process.argv, 'school') ?? 'sywh';
  const apply = process.argv.includes('--apply');
  const snap = await db.collection(`schools/${schoolId}/invoices`).where('totalCents', '==', 0).get();
  const open = snap.docs.filter((d) => ['sent', 'partial', 'draft'].includes(d.get('status') as string) && d.get('pendingCents') === 0);
  console.log(`${snap.size} S$0 invoices, ${open.length} still open${apply ? '' : ' (dry run)'}`);
  if (!apply) return;
  for (const d of open) {
    await d.ref.update({ status: 'paid', paidAt: d.get('issueDate') ?? Timestamp.now(), overdueSince: null, updatedAt: Timestamp.now() });
  }
  console.log(`settled ${open.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
