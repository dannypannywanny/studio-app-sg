// Gives students learn-site access (Auth account + student claims) in bulk, using the same rules as the
// inviteStudents callable: shared emails and staff accounts are skipped and listed for the owner.
// Sends no email. Dry run unless --apply.
//
//   # who would get access: everyone with a lesson since a date (the first cohort)
//   pnpm --filter functions exec tsx scripts/invite-students.ts --school sywh --since 2026-04-01
//   # or named students
//   pnpm --filter functions exec tsx scripts/invite-students.ts --school sywh --ids ccrow-12,ccrow-40
//   # then for real (production needs approval: add --project class-app-sg)
//   ... --apply
//
// Output names students (personal data) on the terminal only; nothing is written to files.
import { getAuth } from 'firebase-admin/auth';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { isWallDate, wallClockToUtc } from '@lessonkaki/shared';
import { inviteStudents, type InviteOutcome } from '../src/invites';
import { argValue, initTarget } from './target';

const HELP: Record<InviteOutcome, string> = {
  invited: 'get access',
  already: 'already have access',
  notFound: 'student not found',
  archived: 'archived, skipped',
  lead: 'a lead, skipped: make them a student in teach first',
  noEmail: 'no usable email: add one in teach, then re-run',
  sharedEmail: 'email shared with another student: give each their own address in teach, then re-run',
  staffAccount: 'email belongs to a staff login: use a different address for the student',
  linkedElsewhere: "email's login is linked to another student: check which student it belongs to",
};

async function main() {
  const target = initTarget();
  const schoolId = argValue(process.argv, 'school');
  if (!schoolId) throw new Error('--school is required');
  const since = argValue(process.argv, 'since');
  const ids = argValue(process.argv, 'ids');
  const apply = process.argv.includes('--apply');
  if (!since === !ids) throw new Error('Give either --since YYYY-MM-DD or --ids a,b,c');

  const db = getFirestore();
  const school = db.collection('schools').doc(schoolId);
  const timeZone = ((await school.get()).get('timezone') as string | undefined) ?? 'Asia/Singapore';

  let studentIds: string[];
  if (since) {
    if (!isWallDate(since)) throw new Error('--since must be YYYY-MM-DD');
    const lessons = await school
      .collection('lessons')
      .where('startAt', '>=', Timestamp.fromDate(wallClockToUtc(since, '00:00', timeZone)))
      .select('studentIds', 'status')
      .get();
    studentIds = [...new Set(lessons.docs.filter((d) => d.get('status') !== 'cancelled').flatMap((d) => d.get('studentIds') as string[]))];
    console.log(`${lessons.size} lessons since ${since}: ${studentIds.length} students.`);
  } else {
    studentIds = ids!.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const results = [];
  // The callable caps a call at 100 students; keep the same batches here.
  for (let i = 0; i < studentIds.length; i += 100) {
    results.push(
      ...(await inviteStudents(
        db,
        getAuth(),
        { schoolId, studentIds: studentIds.slice(i, i + 100), dryRun: !apply },
        { uid: 'invite-students', role: 'system' },
      )),
    );
  }

  const students = results.length ? await db.getAll(...results.map((r) => school.collection('students').doc(r.studentId))) : [];
  const name = (i: number) => {
    const s = students[i]!;
    return s.exists ? `${s.get('preferredName') || s.get('firstName')} ${s.get('lastName') ?? ''}`.trim() : '(missing)';
  };
  for (const outcome of Object.keys(HELP) as InviteOutcome[]) {
    const rows = results.map((r, i) => ({ ...r, i })).filter((r) => r.outcome === outcome);
    if (!rows.length) continue;
    console.log(`\n${rows.length} ${outcome === 'invited' && !apply ? 'would get access' : HELP[outcome]}:`);
    if (outcome !== 'invited' && outcome !== 'already') {
      for (const r of rows) console.log(`  ${r.studentId}  ${name(r.i)}`);
    }
  }
  console.log(apply ? `\nDone in ${target.projectId}. No emails were sent.` : '\nDry run: nothing changed. Re-run with --apply.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
