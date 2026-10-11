// S02 Calendar: one week, Monday to Sunday, in the school's time zone.
import { collection, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { WEEKDAYS, addDays, startOfWeek, wallClockToUtc, wallDateOf, wallTimeOf } from '@lessonkaki/shared';
import { DAY_LABEL, LessonForm } from '../components/LessonForm';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Lesson } from '../types';

const HOUR_PX = 48;
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 22;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function weekLabel(monday: string, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-SG', { timeZone: tz, day: 'numeric', month: 'short' });
  const a = wallClockToUtc(monday, '12:00', tz);
  const b = wallClockToUtc(addDays(monday, 6), '12:00', tz);
  return `${fmt.format(a)} – ${fmt.format(b)} ${b.toLocaleString('en-SG', { timeZone: tz, year: 'numeric' })}`;
}

export function Calendar() {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const today = wallDateOf(new Date(), tz);
  const [monday, setMonday] = useState(() => startOfWeek(today));
  const [teacherFilter, setTeacherFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const students = useStudents();
  const teachers = useTeachers();

  const from = wallClockToUtc(monday, '00:00', tz);
  const to = wallClockToUtc(addDays(monday, 7), '00:00', tz);
  const lessons = useQuery<Lesson>(`calendar:${schoolId}:${monday}`, () =>
    query(
      collection(db, 'schools', schoolId, 'lessons'),
      where('startAt', '>=', Timestamp.fromDate(from)),
      where('startAt', '<', Timestamp.fromDate(to)),
      orderBy('startAt'),
    ),
  );

  const placed = useMemo(
    () =>
      lessons.data
        .filter((l) => !teacherFilter || l.teacherId === teacherFilter)
        .map((l) => {
          const start = l.startAt.toDate();
          return { l, date: wallDateOf(start, tz), startMin: minutesOf(wallTimeOf(start, tz)) };
        }),
    [lessons.data, teacherFilter, tz],
  );

  const firstHour = Math.min(DEFAULT_FIRST_HOUR, ...placed.map((p) => Math.floor(p.startMin / 60)));
  const lastHour = Math.max(DEFAULT_LAST_HOUR, ...placed.map((p) => Math.ceil((p.startMin + p.l.durationMin) / 60)));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const days = WEEKDAYS.map((d, i) => ({ code: d, date: addDays(monday, i) }));

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="muted">{weekLabel(monday, tz)}</p>
        </div>
        <div className="row">
          <select value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)} aria-label="Teacher">
            <option value="">All teachers</option>
            {teachers.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setMonday(addDays(monday, -7))} aria-label="Previous week">
            ←
          </button>
          <button className="btn" onClick={() => setMonday(startOfWeek(today))}>
            This week
          </button>
          <button className="btn" onClick={() => setMonday(addDays(monday, 7))} aria-label="Next week">
            →
          </button>
          {!adding && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              New lesson
            </button>
          )}
        </div>
      </div>
      {adding && <LessonForm onDone={() => setAdding(false)} />}
      {lessons.error && <p className="error">{lessons.error.message}</p>}

      <div className="calendar card" role="grid" aria-label="Week calendar">
        <div className="cal-head" role="row">
          <div className="cal-corner" />
          {days.map((d) => (
            <div key={d.date} role="columnheader" className={`cal-day-head ${d.date === today ? 'today' : ''}`}>
              {DAY_LABEL[d.code]} <span className="muted">{Number(d.date.slice(8))}</span>
            </div>
          ))}
        </div>
        <div className="cal-body" style={{ height: hours.length * HOUR_PX }}>
          <div className="cal-hours">
            {hours.map((h) => (
              <div key={h} className="cal-hour" style={{ height: HOUR_PX }}>
                {String(h).padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.date} className={`cal-col ${d.date === today ? 'today' : ''}`}>
              {hours.map((h) => (
                <div key={h} className="cal-slot" style={{ height: HOUR_PX }} />
              ))}
              {placed
                .filter((p) => p.date === d.date)
                .map(({ l, startMin }) => {
                  const names = l.studentIds.map((id) => studentName(students.byId.get(id))).join(', ');
                  return (
                    <Link
                      key={l.id}
                      to={`/lessons/${l.id}`}
                      className={`cal-event state-${l.status === 'cancelled' ? 'cancelled' : l.attendanceState}`}
                      style={{
                        top: ((startMin - firstHour * 60) / 60) * HOUR_PX,
                        height: Math.max((l.durationMin / 60) * HOUR_PX - 2, 20),
                      }}
                      title={`${wallTimeOf(l.startAt.toDate(), tz)} · ${names}`}
                    >
                      <strong>{wallTimeOf(l.startAt.toDate(), tz)}</strong> {names || 'No students'}
                      {l.seriesId && <span className="cal-repeat" aria-label="weekly"> ↻</span>}
                    </Link>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
      <p className="muted legend">
        <span className="cal-key state-unmarked" /> Not marked <span className="cal-key state-marked" /> Marked{' '}
        <span className="cal-key state-cancelled" /> Cancelled · ↻ weekly
      </p>
    </section>
  );
}
