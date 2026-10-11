import { collection, limit, orderBy, query } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { wallClockToUtc } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { studentName, useFormatTs, useQuery, useStudents, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Lesson, Subject } from '../types';

const createLesson = call<
  {
    schoolId: string;
    teacherId: string;
    subjectId: string;
    startAt: string;
    durationMin: number;
    studentIds: string[];
    isOnline: boolean;
  },
  { lessonId: string }
>('createLesson');

/** Today and the next whole hour, as wall-clock strings in the school's zone. */
function defaultsIn(tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Math.min(Number(get('hour')) + 1, 23);
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${String(hour).padStart(2, '0')}:00` };
}

function NewLessonForm({ onDone }: { onDone: () => void }) {
  const schoolId = useSchoolId();
  const { teacherId: myTeacherId } = useSession();
  const tz = useTimeZone();
  const navigate = useNavigate();
  const students = useStudents();
  const teachers = useTeachers();
  const subjects = useQuery<Subject>(`subjects:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'subjects')));

  const initial = defaultsIn(tz);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [durationMin, setDuration] = useState(60);
  const [teacherId, setTeacherId] = useState(myTeacherId ?? '');
  const [subjectId, setSubjectId] = useState('');
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [isOnline, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teacher = teacherId || teachers.data[0]?.id || '';
  const subject = subjectId || subjects.data[0]?.id || '';
  const active = students.data
    .filter((s) => s.status === 'active')
    .sort((a, b) => studentName(a).localeCompare(studentName(b)));

  function toggle(id: string) {
    setStudentIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (studentIds.length === 0) return setError('Pick at least one student.');
    setBusy(true);
    setError(null);
    try {
      const { lessonId } = await createLesson({
        schoolId,
        teacherId: teacher,
        subjectId: subject,
        startAt: wallClockToUtc(date, time, tz).toISOString(),
        durationMin,
        studentIds,
        isOnline,
      });
      onDone();
      navigate(`/lessons/${lessonId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field">
        <span>Date</span>
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
          {busy ? 'Saving…' : 'Create lesson'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

const STATE_LABEL = { unmarked: 'Not marked', partial: 'Partly marked', marked: 'Marked' } as const;

export function Lessons() {
  const schoolId = useSchoolId();
  const fmt = useFormatTs();
  const students = useStudents();
  const teachers = useTeachers();
  const [adding, setAdding] = useState(false);
  const lessons = useQuery<Lesson>(`lessons:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons'), orderBy('startAt', 'desc'), limit(100)),
  );

  return (
    <section className="stack">
      <div className="page-head">
        <h1>Lessons</h1>
        {!adding && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New lesson
          </button>
        )}
      </div>
      {adding && <NewLessonForm onDone={() => setAdding(false)} />}
      {lessons.error && <p className="error">{lessons.error.message}</p>}
      {lessons.loading ? (
        <p className="muted">Loading…</p>
      ) : lessons.data.length === 0 ? (
        <p className="empty">No lessons yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Students</th>
              <th>Teacher</th>
              <th>Where</th>
              <th>Attendance</th>
            </tr>
          </thead>
          <tbody>
            {lessons.data.map((l) => (
              <tr key={l.id} className={l.status === 'cancelled' ? 'cancelled' : ''}>
                <td>
                  <Link to={`/lessons/${l.id}`}>{fmt(l.startAt)}</Link>
                  <span className="muted"> · {l.durationMin} min</span>
                </td>
                <td>{l.studentIds.map((id) => studentName(students.byId.get(id))).join(', ')}</td>
                <td>{teachers.byId.get(l.teacherId)?.displayName ?? '—'}</td>
                <td>{l.isOnline ? 'Online' : 'In studio'}</td>
                <td>
                  <span className={`badge badge-${l.attendanceState}`}>{STATE_LABEL[l.attendanceState]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
