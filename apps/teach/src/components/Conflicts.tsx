// Warns while a lesson is being set up: the time overlaps the teacher's other lessons or their time off.
// Advisory only; the server still refuses a teacher double-booking when the lesson is saved.
import { collection, query, Timestamp, where } from 'firebase/firestore';
import { addDays, wallClockToUtc, wallTimeOf } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Lesson } from '../types';
import { offLabel, timeOffRange, useTimeOff } from './TimeOff';

export function ConflictBanner({
  teacherId,
  date,
  time,
  durationMin,
  repeats,
  ignoreLessonId,
}: {
  teacherId: string;
  date: string;
  time: string;
  durationMin: number;
  repeats?: boolean;
  ignoreLessonId?: string;
}) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const students = useStudents();
  const offs = useTimeOff();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) && durationMin > 0;
  const dayStart = valid ? wallClockToUtc(addDays(date, -1), '12:00', tz) : new Date(0);
  const dayEnd = valid ? wallClockToUtc(addDays(date, 1), '00:00', tz) : new Date(0);
  const lessons = useQuery<Lesson>(valid ? `conflicts:${schoolId}:${teacherId}:${date}` : null, () =>
    query(
      collection(db, 'schools', schoolId, 'lessons'),
      where('teacherId', '==', teacherId),
      where('startAt', '>=', Timestamp.fromDate(dayStart)),
      where('startAt', '<', Timestamp.fromDate(dayEnd)),
    ),
  );
  if (!valid) return null;
  const start = wallClockToUtc(date, time, tz).getTime();
  const end = start + durationMin * 60_000;

  const clashes = lessons.data.filter(
    (l) => l.id !== ignoreLessonId && l.status !== 'cancelled' && l.startAt.toMillis() < end && l.endAt.toMillis() > start,
  );
  const blocked = offs.filter((o) => {
    if (o.teacherId !== teacherId) return false;
    const r = timeOffRange(o.entry, tz);
    return r.startMs < end && r.endMs > start;
  });
  const n = clashes.length + blocked.length;
  if (n === 0) return null;

  const fmt = (ms: number) => wallTimeOf(new Date(ms), tz);
  return (
    <div className="conflict span-all" role="status">
      <strong>
        {n} conflicting {n === 1 ? 'event' : 'events'}
        {repeats ? ' on the first date' : ''}
      </strong>
      <ul>
        {clashes.map((l) => (
          <li key={l.id}>
            Lesson {fmt(l.startAt.toMillis())}–{fmt(l.endAt.toMillis())} ·{' '}
            {l.studentIds.map((id) => studentName(students.byId.get(id))).join(', ') || 'no students'}
          </li>
        ))}
        {blocked.map((o) => (
          <li key={o.entry.id}>
            Time off {offLabel(o)}
            {o.entry.note ? ` · ${o.entry.note}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
