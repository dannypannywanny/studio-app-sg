// New lesson: one-off or weekly series. Used by the calendar and the lesson list.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { WEEKDAYS, wallClockToUtc, wallDateOf, weekdayOf, type Weekday } from '@lessonkaki/shared';
import { call } from '../firebase';
import { useTimeZone } from '../hooks';
import { useLessonTypes } from './LessonTypes';
import { useOpenLesson } from './LessonSheet';
import { StudentMultiPicker } from './StudentPicker';
import { useSchoolId, useSession } from '../session';

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
  const { teacherId: myTeacherId, role } = useSession();
  const tz = useTimeZone();
  const openLesson = useOpenLesson();
  // Owners and admins book for any teacher; a teacher login only for themselves.
  const { types, loading: typesLoading } = useLessonTypes(role === 'teacher' ? myTeacherId : null);

  const initial = defaultsIn(tz);
  const [date, setDate] = useState(initialDate ?? initial.date);
  const [time, setTime] = useState(initial.time);
  const [typeKey, setTypeKey] = useState('');
  const [minutes, setMinutes] = useState<number | null>(null);
  const [studentIds, setStudentIds] = useState<string[]>([]);
  const [isOnline, setOnline] = useState(false);
  const [repeats, setRepeats] = useState(false);
  const [byDay, setByDay] = useState<Weekday[] | null>(null);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clashes, setClashes] = useState<string[] | null>(null);

  // Until a type is picked: the signed-in teacher's first, else the first on the list.
  const mine = types.filter((t) => t.teacherId === myTeacherId);
  const type =
    types.find((t) => t.key === typeKey) ?? mine.find((t) => t.isDefault) ?? mine[0] ?? types.find((t) => t.isDefault) ?? types[0];
  const durationMin = minutes ?? type?.durationMin ?? 60;
  const days = byDay ?? [weekdayOf(date)];
  const toggleDay = (d: Weekday) =>
    setByDay(days.includes(d) ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)));

  async function save(skipConflicts: boolean) {
    if (!type) return setError('Set up a subject and its teachers in Settings first.');
    if (studentIds.length === 0) return setError('Pick at least one student.');
    if (repeats && days.length === 0) return setError('Pick at least one weekday.');
    setBusy(true);
    setError(null);
    const shape = { schoolId, teacherId: type.teacherId, subjectId: type.subjectId, durationMin, studentIds, isOnline };
    try {
      if (repeats) {
        const res = await createSeries({ ...shape, startDate: date, time, byDay: days, until: until || null, skipConflicts });
        onDone();
        if (res.lessonIds[0]) openLesson(res.lessonIds[0]);
      } else {
        const { lessonId } = await createLesson({ ...shape, startAt: wallClockToUtc(date, time, tz).toISOString() });
        onDone();
        openLesson(lessonId);
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
      <label className="field lesson-type">
        <span>Lesson</span>
        <select
          value={type?.key ?? ''}
          onChange={(e) => {
            setTypeKey(e.target.value);
            setMinutes(null); // the new type's length, unless changed again below
          }}
          disabled={types.length === 0}
        >
          {types.length === 0 && <option value="">{typesLoading ? 'Loading…' : 'No lessons set up yet'}</option>}
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        {!typesLoading && types.length === 0 && (
          <span className="field-help">
            Add subjects, lengths and teachers in <Link to="/settings">Settings</Link>.
          </span>
        )}
      </label>
      <label className="field">
        <span>Minutes</span>
        <input
          type="number"
          min={5}
          max={720}
          step={5}
          required
          value={type || minutes !== null ? durationMin : ''}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
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
        <StudentMultiPicker value={studentIds} onChange={setStudentIds} />
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
