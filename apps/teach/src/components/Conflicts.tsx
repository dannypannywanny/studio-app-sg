// Warns while a lesson is being set up: the time overlaps the teacher's other lessons or their time off.
// Advisory only; the server still refuses a teacher double-booking when the lesson is saved.
import { collection, query, Timestamp, where } from 'firebase/firestore';
import { addDays, wallClockToUtc, wallTimeOf } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTimeZone } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Lesson } from '../types';
import { useRooms } from './Rooms';
import { useHolidays } from './Holidays';
import { offLabel, timeOffRange, useTimeOff } from './TimeOff';

export function ConflictBanner({
  teacherId,
  roomId = null,
  date,
  time,
  durationMin,
  repeats,
  ignoreLessonId,
}: {
  teacherId: string;
  /** In-person room: another teacher's lesson there clashes too. */
  roomId?: string | null;
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
  const places = useRooms();
  const holidays = useHolidays();
  const { role } = useSession();
  const isTeacher = role === 'teacher';
  // The whole day's lessons (any teacher), filtered below by this teacher or this room.
  const lessons = useQuery<Lesson>(valid ? `conflicts:${schoolId}:${date}:${isTeacher ? teacherId : 'all'}` : null, () =>
    query(
      collection(db, 'schools', schoolId, 'lessons'),
      ...(isTeacher ? [where('teacherId', '==', teacherId)] : []),
      where('startAt', '>=', Timestamp.fromDate(dayStart)),
      where('startAt', '<', Timestamp.fromDate(dayEnd)),
    ),
  );
  if (!valid) return null;
  const start = wallClockToUtc(date, time, tz).getTime();
  const end = start + durationMin * 60_000;

  const clashes = lessons.data.filter(
    (l) =>
      l.id !== ignoreLessonId &&
      l.status !== 'cancelled' &&
      l.startAt.toMillis() < end &&
      l.endAt.toMillis() > start &&
      (l.teacherId === teacherId || (roomId !== null && !l.isOnline && l.locationId === roomId)),
  );
  const blocked = offs.filter((o) => {
    if (o.teacherId !== teacherId) return false;
    const r = timeOffRange(o.entry, tz);
    return r.startMs < end && r.endMs > start;
  });
  const holiday = holidays.closed ? holidays.names.get(date) : undefined;
  const n = clashes.length + blocked.length + (holiday ? 1 : 0);
  if (n === 0) {
    return (
      <div className="conflict conflict-none span-all" role="status">
        <strong>No conflicts</strong>
        <span> · {lessons.loading ? 'checking the teacher’s lessons and time off…' : 'nothing else on at this time'}</span>
      </div>
    );
  }

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
            {l.teacherId === teacherId ? 'Lesson' : `${places.byId.get(roomId ?? '')?.name ?? 'Room'} in use`} {fmt(l.startAt.toMillis())}–
            {fmt(l.endAt.toMillis())} ·{' '}
            {l.studentIds.map((id) => studentName(students.byId.get(id))).join(', ') || 'no students'}
          </li>
        ))}
        {holiday && <li>Public holiday: {holiday} (the studio is closed)</li>}
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
