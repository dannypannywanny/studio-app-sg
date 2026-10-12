// Applies the owner's month-by-month review of replayed lessons (see replay-lessons.ts): mark a lesson
// present, or cancel it. Counts only; dry run unless --apply. Emulator by default, production only with
// --project class-app-sg (../target.ts).
//
//   pnpm --filter functions exec tsx scripts/migrate/apply-review.ts --file ../migration/raw/month-2026-10-actions.json [--apply]
//
// The file is a list of { lessonId, action: 'present' | 'cancel', reason? }. Only lessons that are still
// "booked" are touched, so a re-run, or a lesson marked by hand since, is left alone. Present is marked at
// the lesson's own end time; a cancel is the teacher's (credit goes back if one was taken).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { getFirestore, type Timestamp } from 'firebase-admin/firestore';
import { cancelLesson, setAttendance } from '../../src/attendance';
import { argValue, initTarget } from '../target';

interface Action {
  lessonId: string;
  action: 'present' | 'cancel';
  reason?: string;
}

async function main() {
  const file = argValue(process.argv, 'file');
  if (!file) throw new Error('Give --file <actions.json>');
  initTarget();
  const db = getFirestore();
  const schoolId = argValue(process.argv, 'school') ?? 'sywh';
  const apply = process.argv.includes('--apply');
  const actions = JSON.parse(readFileSync(resolve(file.replace(/^~(?=$|\/)/, homedir())), 'utf8')) as Action[];
  // The owner is the one acting: owner alerts honour the "skip my own actions" setting.
  const actor = { uid: 'script:apply-review', role: 'owner' as const };
  const done = { marked: 0, cancelled: 0, alreadyDone: 0, missing: 0 };
  const owedBefore: Record<string, number> = {};

  for (const a of actions) {
    const ref = db.doc(`schools/${schoolId}/lessons/${a.lessonId}`);
    const snap = await ref.get();
    if (!snap.exists) {
      done.missing += 1;
      continue;
    }
    const studentId = (snap.get('studentIds') as string[])[0]!;
    const status = (await ref.collection('attendees').doc(studentId).get()).get('status');
    if (snap.get('status') === 'cancelled' || status !== 'booked') {
      done.alreadyDone += 1;
      continue;
    }
    owedBefore[studentId] ??= ((await db.doc(`schools/${schoolId}/students/${studentId}`).get()).get('summary.sessionsOwed') as number) ?? 0;
    if (!apply) {
      done[a.action === 'present' ? 'marked' : 'cancelled'] += 1;
      continue;
    }
    if (a.action === 'present') {
      const end = (snap.get('endAt') as Timestamp).toDate();
      await setAttendance(db, { schoolId, lessonId: a.lessonId, studentId, status: 'present' }, actor, end);
      done.marked += 1;
    } else {
      await cancelLesson(db, { schoolId, lessonId: a.lessonId, reason: a.reason ?? 'Cancelled by teacher' }, actor);
      done.cancelled += 1;
    }
  }
  console.log(apply ? 'Applied:' : 'Dry run, would apply:', done);

  if (apply) {
    let newlyOwed = 0;
    for (const [studentId, before] of Object.entries(owedBefore)) {
      const after = ((await db.doc(`schools/${schoolId}/students/${studentId}`).get()).get('summary.sessionsOwed') as number) ?? 0;
      newlyOwed += Math.max(0, after - before);
    }
    console.log(`Lessons that became "owed" (no package to charge): ${newlyOwed}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
