// Student import from a Classcard CSV export, with a review step.
//
//   Dry run (default): plans the import against the school and writes a review file to
//   migration/raw/ (gitignored). Prints counts only, never names or contact details.
//     pnpm --filter functions exec tsx scripts/migrate/import-students.ts --file ~/Downloads/students.csv
//   Apply the reviewed rows ("create" rows of the review file; edit it to drop any):
//     ... --review ../migration/raw/student-import-review.json --apply
//
// Emulator projects (demo-*) only. Pointing this at class-app-sg is M3 and needs approval first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { csvToObjects, mapClasscardRows, planImport, summarisePlan, type ImportCandidate, type PlanRow } from '@lessonkaki/shared';
import { importStudents } from '../../src/importStudents';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = resolve(here, '../../../migration/raw');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

export function assertEmulator(): string {
  const projectId = process.env.GCLOUD_PROJECT ?? 'demo-lessonkaki';
  if (!projectId.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      `Refusing to run against "${projectId}" (FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST ?? 'unset'}). ` +
        'Migration scripts only run against a demo-* emulator project until the M3 cutover is approved.',
    );
  }
  return projectId;
}

async function main() {
  const projectId = assertEmulator();
  initializeApp({ projectId });
  const db = getFirestore();
  const schoolId = arg('school') ?? 'sywh';
  const exclude = (arg('exclude-email') ?? '').split(',').filter(Boolean);
  const actor = { uid: 'script:import-students', role: 'system' as const };

  if (process.argv.includes('--apply')) {
    const reviewPath = expand(arg('review') ?? resolve(RAW, 'student-import-review.json'));
    const review = JSON.parse(readFileSync(reviewPath, 'utf8')) as { rows: PlanRow[] };
    const rows: ImportCandidate[] = review.rows.filter((r) => r.action === 'create').map((r) => r.candidate);
    const res = await importStudents(db, { schoolId, rows, excludeEmails: exclude }, actor);
    console.log(`Created ${res.created} students (batch ${res.batchId}); ${res.skipped.length} rows skipped on re-check.`);
    return;
  }

  const file = arg('file');
  if (!file) throw new Error('Give --file <export.csv> (dry run) or --apply');
  const { headers, rows } = csvToObjects(readFileSync(expand(file), 'utf8'));
  const existing = (await db.collection(`schools/${schoolId}/students`).get()).docs.map((d) => ({
    id: d.id,
    email: d.get('email') ?? null,
    phone: d.get('phone') ?? null,
    legacyId: d.get('legacyId') ?? null,
  }));
  const plan = planImport(mapClasscardRows(rows), existing, { excludeEmails: exclude });
  mkdirSync(RAW, { recursive: true });
  const out = resolve(RAW, 'student-import-review.json');
  writeFileSync(out, JSON.stringify({ schoolId, headers, createdAt: new Date().toISOString(), rows: plan }, null, 2));

  const issues = new Map<string, number>();
  for (const p of plan) for (const i of p.candidate.issues) issues.set(i, (issues.get(i) ?? 0) + 1);
  console.log(`Rows: ${rows.length}`, summarisePlan(plan));
  console.log('Issues:', Object.fromEntries(issues));
  console.log(`Review written to ${out} (gitignored). Check it, then run again with --apply.`);
}

// Only when run directly (opening-balances.ts imports assertEmulator from here).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
