// New lesson: one-off or weekly series. Used by the calendar and the lesson list.
import { collection, query } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { WEEKDAYS, wallClockToUtc, wallDateOf, weekdayOf, type Weekday } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { studentName, useQuery, useStudents, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Subject } from '../types';

interface Shape {
  schoolId: string;
  teacherId: string;
  subjectId: string;
  durationMin: number;
  studentIds: string[];
  isOnline: boolean;
}

const createLesson = call<Shape & { startAt: string }, { lessonId: string }>('createLesson');
const createSeries = call<
  Shape & { startDate: string; time: string; byDay: Weekday[]; until: string | null; skipConflicts: boolean },
  { seriesId: string; lessonIds: string[]; skipped: string[] }
>('createSeries');

export const DAY_LABEL: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

/** The next whole hour today, as wall-clock strings in the school's zone. */
function defaultsIn(tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).formatToParts(
    new Date(),
  );
  const hour = Math.min(Number(parts.find((p) => p.type === 'hour')?.value ?? 9) + 1, 23);
  return { date: wallDateOf(new Date(), tz), time: `${String(hour).padStart(2, '0')}:00` };
}

interface CallableError {
  message: string;
  code?: string;
  details?: { conflicts?: { date: string }[] };
}

export function LessonForm({ onDone, initialDate }: { onDone: () => void; initialDate?: string }) {
  const schoolId = useSchoolId();
  const { teacherId: myTeacherId } = useSession();
  const tz = useTimeZone();
  const navigate = useNavigate();
  const students = useStudents();
  const teachers = useTeachers();
  const subjects = useQuery<Subject>(`subjects:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'subjects')));

  const initial = defaultsIn(tz);
  const [date, setDate] = useState(initialDate ?? initial.date);
  const [time, setTime] = useState(initial.time);
  const [durationMin, setDuration] = useState(60);
  const [teacherId, setTeacherId] = useState(myTeacherId ?? '');
  const [subjectId, setSubjectId] = useState('');
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [isOnline, setOnline] = useState(false);
  const [repeats, setRepeats] = useState(false);
  const [byDay, setByDay] = useState<Weekday[] | null>(null);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clashes, setClashes] = useState<string[] | null>(null);

  const teacher = teacherId || teachers.data[0]?.id || '';
  const subject = subjectId || subjects.data[0]?.id || '';
  const days = byDay ?? [weekdayOf(date)];
  const active = students.data
    .filter((s) => s.status === 'active')
    .sort((a, b) => studentName(a).localeCompare(studentName(b)));

  const toggle = (id: string) => setStudentIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const toggleDay = (d: Weekday) =>
    setByDay(days.includes(d) ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)));

  async function save(skipConflicts: boolean) {
    if (studentIds.length === 0) return setError('Pick at least one student.');
    if (repeats && days.length === 0) return setError('Pick at least one weekday.');
    setBusy(true);
    setError(null);
    const shape = { schoolId, teacherId: teacher, subjectId: subject, durationMin, studentIds, isOnline };
    try {
      if (repeats) {
        const res = await createSeries({ ...shape, startDate: date, time, byDay: days, until: until || null, skipConflicts });
        onDone();
        navigate(`/lessons/${res.lessonIds[0]}`);
      } else {
        const { lessonId } = await createLesson({ ...shape, startAt: wallClockToUtc(date, time, tz).toISOString() });
        onDone();
        navigate(`/lessons/${lessonId}`);
      }
    } catch (err) {
      const e = err as CallableError;
      setError(e.message);
      setClashes(repeats && e.details?.conflicts ? e.details.conflicts.map((c) => c.date) : null);
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setClashes(null);
    void save(false);
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field">
        <span>{repeats ? 'First date' : 'Date'}</span>
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Start ({tz})</span>
        <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <label className="field">
        <span>Minutes</span>
        <input
          type="number"
          min={5}
          max={720}
          step={5}
          required
          value={durationMin}
          onChange={(e) => setDuration(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>Teacher</span>
        <select value={teacher} onChange={(e) => setTeacherId(e.target.value)}>
          {teachers.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Subject</span>
        <select value={subject} onChange={(e) => setSubjectId(e.target.value)}>
          {subjects.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={isOnline} onChange={(e) => setOnline(e.target.checked)} />
        <span>Online</span>
      </label>
      <label className="field checkbox span-all">
        <input type="checkbox" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
        <span>Repeats weekly</span>
      </label>
      {repeats && (
        <>
          <fieldset className="field">
            <legend>On</legend>
            <div className="chips">
              {WEEKDAYS.map((d) => (
                <label key={d} className={`chip ${days.includes(d) ? 'on' : ''}`}>
                  <input type="checkbox" checked={days.includes(d)} onChange={() => toggleDay(d)} />
                  {DAY_LABEL[d]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>Until (optional)</span>
            <input type="date" value={until} min={date} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <p className="muted span-all">The next 12 weeks of lessons are created now; later weeks are added daily.</p>
        </>
      )}
      <fieldset className="field span-all">
        <legend>Students</legend>
        <div className="chips">
          {active.map((s) => (
            <label key={s.id} className={`chip ${studentIds.includes(s.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={studentIds.includes(s.id)} onChange={() => toggle(s.id)} />
              {studentName(s)}
            </label>
          ))}
          {active.length === 0 && <span className="muted">No active students yet.</span>}
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : repeats ? 'Create weekly lessons' : 'Create lesson'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
        {clashes && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save(true)}>
            Create anyway, leaving out {clashes.length} clashing date{clashes.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </form>
  );
}
