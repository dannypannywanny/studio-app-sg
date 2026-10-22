// One-off: sets lessons.studentsCancelled on lessons from before the field existed, so lessons every
// student cancelled show struck through on the calendar. Recomputed from the attendees with the same
// rule the attendance functions use (lessonStateOf). Dry run by default; --apply writes.
//
//   npx tsx scripts/backfill-students-cancelled.mts --project class-app-sg [--school sywh] [--apply]
import { getFirestore } from 'firebase-admin/firestore';
import type { AttendanceStatus } from '@lessonkaki/shared';
import { lessonStateOf } from '../src/attendance';
import { argValue, initTarget } from './target';

initTarget();
const db = getFirestore();
const schoolId = argValue(process.argv, 'school') ?? 'sywh';
const apply = process.argv.includes('--apply');

const lessons = await db.collection(`schools/${schoolId}/lessons`).where('attendanceState', '==', 'marked').get();
let changes = 0;
let writer = db.bulkWriter();
for (const l of lessons.docs) {
  const statuses = (await l.ref.collection('attendees').get()).docs.map((d) => d.get('status') as AttendanceStatus);
  const want = lessonStateOf(statuses).studentsCancelled;
  if ((l.get('studentsCancelled') ?? false) === want) continue;
  changes += 1;
  console.log(`${l.id} ${l.get('startAt').toDate().toISOString().slice(0, 16)} -> studentsCancelled=${want}`);
  if (apply) writer.update(l.ref, { studentsCancelled: want });
}
if (apply) await writer.close();
console.log(`${lessons.size} marked lessons checked, ${changes} to change${apply ? ', written' : ' (dry run; add --apply to write)'}.`);
