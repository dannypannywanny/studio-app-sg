// Opening balances from Classcard: one `migrate` lot per enrolment with sessions left, money credit
// per student, then a check of the totals against Classcard's.
//
//   pnpm --filter functions exec tsx scripts/migrate/opening-balances.ts [--file ../migration/raw/opening-balances.json]
//
// The file follows opening-balances.example.json. Fill it from Classcard read-only: the classcard MCP
// (list_students, list_invoices, list_packages) plus each active student's Enrollments panel for
// sessions left and valid-till dates, which the API doesn't expose. Emulator (demo-*) by default;
// production only with an explicit `--project class-app-sg` (scripts/target.ts).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestore } from 'firebase-admin/firestore';
import { applyOpeningBalances, validateMigration, type OpeningBalances } from '../../src/migrate';
import { initTarget } from '../target';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  initTarget();
  const db = getFirestore();
  const i = process.argv.indexOf('--file');
  const file = i > 0 ? process.argv[i + 1]! : resolve(here, '../../../migration/raw/opening-balances.json');
  const schoolArg = process.argv.indexOf('--school');
  const schoolId = schoolArg > 0 ? process.argv[schoolArg + 1]! : 'sywh';
  const balances = JSON.parse(readFileSync(resolve(file), 'utf8')) as OpeningBalances;

  const res = await applyOpeningBalances(db, schoolId, balances, { uid: 'script:opening-balances', role: 'system' });
  console.log(`Lots created: ${res.lotsCreated}, money credits: ${res.moneyCreditsCreated}`);
  if (res.unknownStudents.length) console.log(`No student with these Classcard ids yet: ${res.unknownStudents.length}`);
  const check = await validateMigration(db, schoolId, balances.expected);
  console.log(check.ok ? 'Totals match Classcard.' : `Totals differ:\n  ${check.diffs.join('\n  ')}`);
  if (!check.ok) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
