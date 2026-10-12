// Gives back, to expired packages, the sessions that lessons still to be marked inside their validity
// need (see reopenForPending in src/replay.ts), and settles lessons that went "owed" meanwhile.
// Counts only; dry run unless --apply. Emulator by default, production only with --project class-app-sg.
//
//   pnpm --filter functions exec tsx scripts/migrate/reopen-pending.ts [--apply] [--grace-days 180]
import { getFirestore } from 'firebase-admin/firestore';
import { reopenForPending } from '../../src/replay';
import { argValue, initTarget } from '../target';

async function main() {
  initTarget();
  const db = getFirestore();
  const apply = process.argv.includes('--apply');
  const res = await reopenForPending(db, argValue(process.argv, 'school') ?? 'sywh', { uid: 'script:reopen-pending', role: 'system' }, new Date(), {
    graceDays: Number(argValue(process.argv, 'grace-days') ?? 180),
    dryRun: !apply,
  });
  console.log(apply ? 'Reopened:' : 'Dry run, would reopen:', res);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
