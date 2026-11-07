// New lesson: one-off or weekly series. Used by the calendar and the lesson list.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { WEEKDAYS, formatMoney, wallClockToUtc, wallDateOf, weekdayOf, type Weekday } from '@lessonkaki/shared';
import { call } from '../firebase';
import { useTimeZone } from '../hooks';
import { useLessonTypes } from './LessonTypes';
import { ConflictBanner } from './Conflicts';
import { useRooms } from './Rooms';
import { useOpenLesson } from './LessonSheet';
import { StudentMultiPicker } from './StudentPicker';
import { PackageSelect, setAttendeePackage, useActiveLots, useTrialPackages } from './PackagePick';
import { studentName, useStudents } from '../hooks';
import type { Package } from '../types';
import { useSchoolId, useSession } from '../session';

interface Shape {
  schoolId: string;
  teacherId: string;
  subjectId: string;
  durationMin: number;
  studentIds: string[];
  isOnline: boolean;
  locationId: string | null;
}

const createLesson = call<Shape & { startAt: string; trialStudentIds: string[] }, { lessonId: string }>('createLesson');
const sellPackage = call<{ schoolId: string; studentId: string; packageId: string; idempotencyKey: string }, { enrolmentId: string; invoiceNumber: string }>(
  'sellPackage',
);

/**
 * What a student comes for: '' an ordinary lesson (paid from their packages), 'trial' a trial (their trial
 * package if they have one, else free), or `sell:<packageId>` a paid trial, invoiced when it's booked.
 */
type Visit = '' | 'trial' | `sell:${string}`;

function VisitSelect({
  studentId,
  isLead,
  value,
  onChange,
  trialPackages,
}: {
  studentId: string;
  isLead: boolean;
  value: Visit;
  onChange: (v: Visit) => void;
  trialPackages: (Package & { id: string })[];
}) {
  const trialIds = new Set(trialPackages.map((p) => p.id));
  const owned = useActiveLots(studentId).filter((l) => l.packageId && trialIds.has(l.packageId));
  return (
    <select className="package-select" aria-label="Lesson or trial" value={value} onChange={(e) => onChange(e.target.value as Visit)}>
      {!isLead && <option value="">Lesson</option>}
      <option value="trial">{owned.length ? `Trial: uses their ${owned[0]!.packageName}` : 'Free trial'}</option>
      {trialPackages
        .filter((p) => p.active)
        .map((p) => (
          <option key={p.id} value={`sell:${p.id}`}>
            Paid trial: {p.name} · {formatMoney(p.priceCents)} (invoice now)
          </option>
        ))}
    </select>
  );
}
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

/** Usual length of a lead's trial lesson; staff can change it in the form. */
export const TRIAL_MINUTES = 30;

export function LessonForm({ onDone, initialDate, trialFor }: { onDone: () => void; initialDate?: string; trialFor?: string }) {
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
  const [minutes, setMinutes] = useState<number | null>(trialFor ? TRIAL_MINUTES : null);
  const [studentIds, setStudentIds] = useState<string[]>(trialFor ? [trialFor] : []);
  const [packages, setPackages] = useState<Record<string, string | null>>({});
  const [visits, setVisits] = useState<Record<string, Visit>>({});
  const trialPackages = useTrialPackages();
  const places = useRooms();
  const [roomId, setRoomId] = useState('');
  const room = places.rooms.find((r) => r.id === roomId) ?? places.rooms[0] ?? null;
  const students = useStudents();
  // Choices made in the form, applied to the new lesson(s) once they exist.
  const applyPackages = (lessonIds: string[]) =>
    Promise.all(
      lessonIds.flatMap((lessonId) =>
        studentIds
          .filter((id) => packages[id])
          .map((studentId) => setAttendeePackage({ schoolId, lessonId, studentId, enrolmentId: packages[studentId] ?? null })),
      ),
    );
  const [isOnline, setOnline] = useState(false);
  const [repeatsWanted, setRepeats] = useState(false);
  // Leads always come for a trial; a student can too. Trials are single lessons, never weekly.
  const isLead = (id: string) => students.byId.get(id)?.status === 'lead';
  const visitOf = (id: string): Visit => visits[id] ?? (isLead(id) ? 'trial' : '');
  const hasLead = studentIds.some(isLead);
  const hasTrial = studentIds.some((id) => visitOf(id) !== '');
  const repeats = repeatsWanted && !hasTrial;
  // Paid trials: the trial package is sold (invoice) and set to pay for the new lesson.
  const invoiceTrials = (lessonId: string) =>
    Promise.all(
      studentIds.flatMap((studentId) => {
        const v = visitOf(studentId);
        if (!v.startsWith('sell:')) return [];
        const packageId = v.slice('sell:'.length);
        return [
          sellPackage({ schoolId, studentId, packageId, idempotencyKey: `trial_${lessonId}_${studentId}` }).then((r) =>
            setAttendeePackage({ schoolId, lessonId, studentId, enrolmentId: r.enrolmentId }),
          ),
        ];
      }),
    );
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
    const locationId = isOnline ? (places.online?.id ?? null) : (room?.id ?? null);
    const shape = { schoolId, teacherId: type.teacherId, subjectId: type.subjectId, durationMin, studentIds, isOnline, locationId };
    try {
      if (repeats) {
        const res = await createSeries({ ...shape, startDate: date, time, byDay: days, until: until || null, skipConflicts });
        await applyPackages(res.lessonIds);
        onDone();
        if (res.lessonIds[0]) openLesson(res.lessonIds[0]);
      } else {
        const trialStudentIds = studentIds.filter((id) => visitOf(id) !== '' && !isLead(id));
        const { lessonId } = await createLesson({ ...shape, trialStudentIds, startAt: wallClockToUtc(date, time, tz).toISOString() });
        await applyPackages([lessonId]);
        // The lesson exists now, so close the form either way (saving again would book it twice).
        const invoiced = await invoiceTrials(lessonId).then(
          () => null,
          (err: Error) => err.message,
        );
        onDone();
        openLesson(lessonId);
        if (invoiced) window.alert(`The trial is booked, but its invoice wasn't created: ${invoiced} Sell the trial package from the student's page.`);
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
            setMinutes(hasLead ? TRIAL_MINUTES : null); // the new type's length (a trial's), unless changed again below
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
      {places.many && !isOnline && (
        <label className="field">
          <span>Room</span>
          <select value={room?.id ?? ''} onChange={(e) => setRoomId(e.target.value)}>
            {places.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {type && (
        <ConflictBanner
          teacherId={type.teacherId}
          roomId={isOnline ? null : (room?.id ?? null)}
          date={date}
          time={time}
          durationMin={durationMin}
          repeats={repeats}
        />
      )}
      <label className="field checkbox">
        <input type="checkbox" checked={isOnline} onChange={(e) => setOnline(e.target.checked)} />
        <span>Online</span>
      </label>
      {hasTrial ? (
        <p className="muted span-all">
          {hasLead ? 'Leads are booked for a single trial lesson. ' : 'Trials are single lessons. '}A trial never uses a student's regular
          package: it's free, or paid by a trial package (choose one below to invoice it now).
        </p>
      ) : (
        <label className="field checkbox span-all">
          <input type="checkbox" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
          <span>Repeats weekly</span>
        </label>
      )}
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
        {studentIds.length > 0 && (
          <div className="package-picks">
            {studentIds.map((id) => (
              <label key={id} className="package-pick">
                <span>{studentName(students.byId.get(id))}</span>
                {(isLead(id) || !repeats) && (trialPackages.length > 0 || !isLead(id)) && (
                  <VisitSelect
                    studentId={id}
                    isLead={isLead(id)}
                    value={visitOf(id)}
                    onChange={(v) => setVisits({ ...visits, [id]: v })}
                    trialPackages={trialPackages}
                  />
                )}
                {visitOf(id) === '' ? (
                  <PackageSelect studentId={id} value={packages[id] ?? null} onChange={(v) => setPackages({ ...packages, [id]: v })} />
                ) : (
                  visitOf(id) === 'trial' &&
                  trialPackages.length === 0 && <span className="muted">Free trial</span>
                )}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : repeats ? 'Create weekly lessons' : trialFor || hasTrial ? 'Book trial' : 'Create lesson'}
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
