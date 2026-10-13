import { collection, query } from 'firebase/firestore';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { WEEKDAYS, resolvePolicy, wallDateOf, wallTimeOf, type AttendanceStatus, type Weekday } from '@lessonkaki/shared';
import { DAY_LABEL } from '../components/LessonForm';
import { StudentSearch } from '../components/StudentPicker';
import { ConflictBanner } from '../components/Conflicts';
import { useRooms } from '../components/Rooms';
import { PackageSelect, setAttendeePackage } from '../components/PackagePick';
import { useSubjects } from '../components/LessonTypes';
import { call, db } from '../firebase';
import { studentName, useDoc, useFormatTs, useQuery, useSchool, useStudents, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Attendee, Lesson } from '../types';

type Markable = 'present' | 'absent' | 'booked';
type CancelMode = 'auto' | 'onTime' | 'late';
type AttendeeRef = { schoolId: string; lessonId: string; studentId: string };

const markAttendance = call<AttendeeRef & { status: Markable }, { status: AttendanceStatus; charge: string }>(
  'markAttendance',
);
const cancelAttendance = call<AttendeeRef & { mode: CancelMode }, { status: string; late: boolean; charge: string }>(
  'cancelAttendance',
);
const addAttendee = call<AttendeeRef, { added: boolean }>('addAttendee');
const removeAttendee = call<AttendeeRef, { charge: string }>('removeAttendee');
const cancelLesson = call<{ schoolId: string; lessonId: string; reason: string | null }, { restored: number }>(
  'cancelLesson',
);

type Scope = 'one' | 'following' | 'all';
interface EditResult {
  updated: number;
  created: number;
  deleted: number;
  cancelled: number;
  restored: number;
  skipped: string[];
  seriesId: string | null;
}
const editLesson = call<
  {
    schoolId: string;
    lessonId: string;
    scope: Scope;
    changes?: { date?: string; time?: string; durationMin?: number; teacherId?: string; byDay?: Weekday[]; locationId?: string | null };
    cancel?: { reason: string | null };
    skipConflicts?: boolean;
  },
  EditResult
>('editLesson');

const SCOPE_LABEL: Record<Scope, string> = {
  one: 'This lesson only',
  following: 'This and following lessons',
  all: 'All upcoming lessons in the series',
};

function ScopePicker({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  return (
    <fieldset className="field">
      <legend>Apply to</legend>
      <div className="scope">
        {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => (
          <label key={s} className="row">
            <input type="radio" name="scope" checked={value === s} onChange={() => onChange(s)} />
            {SCOPE_LABEL[s]}
          </label>
        ))}
      </div>
      {value !== 'one' && (
        <span className="muted">Past lessons, marked lessons and lessons you changed one by one are left as they are.</span>
      )}
    </fieldset>
  );
}

/** Reschedule one lesson, or a series from this lesson on. */
function Reschedule({ lesson, onDone }: { lesson: Lesson & { id: string }; onDone: (msg: string, moved: boolean) => void }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const teachers = useTeachers();
  const series = useDoc<{ byDay: Weekday[] }>(lesson.seriesId ? `schools/${schoolId}/series/${lesson.seriesId}` : null);
  const start = lesson.startAt.toDate();
  const [scope, setScope] = useState<Scope>('one');
  const [date, setDate] = useState(wallDateOf(start, tz));
  const [time, setTime] = useState(wallTimeOf(start, tz));
  const [durationMin, setDuration] = useState(lesson.durationMin);
  const [teacherId, setTeacherId] = useState(lesson.teacherId);
  const places = useRooms();
  const [roomId, setRoomId] = useState(lesson.locationId ?? '');
  const [byDay, setByDay] = useState<Weekday[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = byDay ?? series.data?.byDay ?? [];
  const roomChanged = !lesson.isOnline && !!roomId && roomId !== (lesson.locationId ?? '');

  async function save(skipConflicts = false) {
    setBusy(true);
    setError(null);
    try {
      const changes =
        scope === 'one'
          ? { date, time, durationMin, teacherId, ...(roomChanged ? { locationId: roomId } : {}) }
          : { time, durationMin, teacherId, ...(byDay ? { byDay } : {}), ...(roomChanged ? { locationId: roomId } : {}) };
      const res = await editLesson({ schoolId, lessonId: lesson.id, scope, changes, skipConflicts });
      onDone(
        scope === 'one'
          ? 'Lesson moved.'
          : `Series updated: ${res.created} lessons rescheduled${res.skipped.length ? `, ${res.skipped.length} clashing dates left out` : ''}.`,
        scope !== 'one',
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Reschedule</h2>
      {lesson.seriesId && <ScopePicker value={scope} onChange={setScope} />}
      <div className="form-grid">
        {scope === 'one' ? (
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        ) : (
          <fieldset className="field span-all">
            <legend>Weekdays</legend>
            <div className="chips">
              {WEEKDAYS.map((d) => (
                <label key={d} className={`chip ${days.includes(d) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={days.includes(d)}
                    onChange={() => setByDay(days.includes(d) ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)))}
                  />
                  {DAY_LABEL[d]}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="field">
          <span>Start ({tz})</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="field">
          <span>Minutes</span>
          <input type="number" min={5} max={720} step={5} value={durationMin} onChange={(e) => setDuration(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Teacher</span>
          <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            {teachers.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
        {places.many && !lesson.isOnline && (
          <label className="field">
            <span>Room</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {!roomId && <option value="">Pick a room</option>}
              {places.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scope === 'one' && (
          <ConflictBanner
            teacherId={teacherId}
            roomId={lesson.isOnline ? null : roomId || null}
            date={date}
            time={time}
            durationMin={durationMin}
            ignoreLessonId={lesson.id}
          />
        )}
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {error && /already has a lesson/.test(error) && scope !== 'one' && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void save(true)}>
            Save anyway, leaving out clashing dates
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

const CHARGE_TEXT: Record<string, string> = {
  debited: '1 credit used.',
  owed: 'No credits left: recorded as owed.',
  restored: 'Credit returned.',
  restoredExpired: 'Credit returned to an expired package, so it expired again.',
  none: 'No credit change.',
};

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  booked: 'Not marked',
  present: 'Present',
  absent: 'Absent',
  cancelled: 'Cancelled',
  lateCancelled: 'Late cancel',
  removed: 'Removed',
};

const ACTIONS: { status: Markable; label: string; className: string }[] = [
  { status: 'present', label: 'Present', className: 'btn-primary' },
  { status: 'absent', label: 'Absent', className: '' },
  { status: 'booked', label: 'Unmark', className: 'btn-ghost' },
];

/** Inline confirm for a student's cancel: shows whether it counts as late, lets staff override. */
function CancelChoice({
  late,
  hours,
  returnsCredit,
  busy,
  onPick,
  onBack,
}: {
  late: boolean;
  hours: number;
  returnsCredit: boolean;
  busy: boolean;
  onPick: (mode: CancelMode) => void;
  onBack: () => void;
}) {
  return (
    <div className="inline-confirm">
      <p className="muted">
        {late
          ? `Inside ${hours}h of the start: counts as a late cancel (${returnsCredit ? 'credit returned' : 'credit used'}).`
          : `More than ${hours}h before the start: an on-time cancel, no credit used.`}
      </p>
      <div className="row">
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onPick('auto')}>
          {late ? 'Late cancel' : 'Cancel on time'}
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => onPick(late ? 'onTime' : 'late')}>
          {late ? 'Count as on time' : 'Count as late'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

/** The lesson as a page (/lessons/:id). Elsewhere it opens in the side sheet (LessonSheet). */
export function LessonDetail() {
  const { lessonId = '' } = useParams();
  return (
    <section className="stack">
      <p>
        <Link to="/lessons">← Lessons</Link>
      </p>
      <LessonPanel lessonId={lessonId} variant="page" />
    </section>
  );
}

/** Lesson details, reschedule, cancel and attendance. `onClose` is how the sheet leaves after a series change. */
export function LessonPanel({
  lessonId,
  variant,
  onClose,
}: {
  lessonId: string;
  variant: 'page' | 'sheet';
  onClose?: () => void;
}) {
  const schoolId = useSchoolId();
  const fmt = useFormatTs();
  const lesson = useDoc<Lesson>(`schools/${schoolId}/lessons/${lessonId}`);
  const attendees = useQuery<Attendee>(`attendees:${lessonId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons', lessonId, 'attendees')),
  );
  const students = useStudents();
  const teachers = useTeachers();
  const subjects = useSubjects();
  const places = useRooms();
  const policy = resolvePolicy(useSchool().data?.policy);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancelLesson, setConfirmCancelLesson] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelScope, setCancelScope] = useState<Scope>('one');
  const [rescheduling, setRescheduling] = useState(false);
  const navigate = useNavigate();
  // After a series change the lessons around this one move, so leave for the calendar.
  const leave = () => (variant === 'sheet' && onClose ? onClose() : navigate('/calendar'));

  async function run(key: string, fn: () => Promise<string | null>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const mark = (studentId: string, status: Markable) =>
    run(`${studentId}:${status}`, async () => {
      const res = await markAttendance({ schoolId, lessonId, studentId, status });
      return `${studentName(students.byId.get(studentId))}: ${CHARGE_TEXT[res.charge]}`;
    });

  const cancel = (studentId: string, mode: CancelMode) =>
    run(`${studentId}:cancel`, async () => {
      const res = await cancelAttendance({ schoolId, lessonId, studentId, mode });
      setCancelling(null);
      return `${studentName(students.byId.get(studentId))}: ${res.late ? 'late cancel' : 'cancelled on time'}. ${CHARGE_TEXT[res.charge]}`;
    });

  const remove = (studentId: string) =>
    run(`${studentId}:remove`, async () => {
      const res = await removeAttendee({ schoolId, lessonId, studentId });
      return `${studentName(students.byId.get(studentId))} removed. ${CHARGE_TEXT[res.charge]}`;
    });

  const add = (studentId: string) =>
    run('add', async () => {
      await addAttendee({ schoolId, lessonId, studentId });
      return `${studentName(students.byId.get(studentId))} added.`;
    });

  const cancelWholeLesson = () =>
    run('cancelLesson', async () => {
      const why = reason.trim() || null;
      setConfirmCancelLesson(false);
      if (cancelScope === 'one') {
        const res = await cancelLesson({ schoolId, lessonId, reason: why });
        return `Lesson cancelled. ${res.restored} credit${res.restored === 1 ? '' : 's'} returned.`;
      }
      const res = await editLesson({ schoolId, lessonId, scope: cancelScope, cancel: { reason: why } });
      leave();
      return `Series ended: ${res.deleted + res.cancelled} upcoming lessons removed, ${res.restored} credits returned.`;
    });

  if (lesson.loading) return <p className="muted">Loading…</p>;
  if (!lesson.data) return <p className="empty">Lesson not found.</p>;
  const l = lesson.data;
  const cancelled = l.status === 'cancelled';
  const hoursToStart = (l.startAt.toMillis() - Date.now()) / 3_600_000;
  const isLate = hoursToStart < policy.lateCancelHours;
  const visible = attendees.data.filter((a) => a.status !== 'removed');
  const onLesson = visible.map((a) => a.studentId);
  const Title = variant === 'page' ? 'h1' : 'h2';

  return (
    <div className={`stack lesson-panel lesson-${variant}`}>
      <div className="page-head">
        <div>
          <Title className="lesson-title">{fmt(l.startAt)}</Title>
          <p className="muted">
            {subjects.data.find((s) => s.id === l.subjectId)?.name ?? 'Lesson'} · {l.durationMin} min · {l.isOnline ? 'Online' : (places.byId.get(l.locationId ?? '')?.name ?? 'In person')} · with{' '}
            {teachers.byId.get(l.teacherId)?.displayName ?? '—'}
            {l.seriesId && ' · weekly series'}
          </p>
        </div>
        {cancelled ? (
          <span className="badge badge-void">Cancelled{l.cancelReason ? `: ${l.cancelReason}` : ''}</span>
        ) : (
          <div className="row">
            {!rescheduling && (
              <button className="btn" onClick={() => setRescheduling(true)}>
                Reschedule
              </button>
            )}
            {!confirmCancelLesson && (
              <button className="btn" onClick={() => setConfirmCancelLesson(true)}>
                Cancel lesson
              </button>
            )}
          </div>
        )}
      </div>

      {rescheduling && !cancelled && (
        <Reschedule
          lesson={l}
          onDone={(msg, moved) => {
            setRescheduling(false);
            setNotice(msg);
            if (moved) leave();
          }}
        />
      )}

      {confirmCancelLesson && !cancelled && (
        <div className="card stack">
          <h2>Cancel this lesson?</h2>
          <p className="muted">Every student who was charged for it gets the credit back. Owed lessons are cleared.</p>
          {l.seriesId && <ScopePicker value={cancelScope} onChange={setCancelScope} />}
          <label className="field">
            <span>Reason (optional, shown on the lesson)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={busy !== null} onClick={cancelWholeLesson}>
              {busy === 'cancelLesson' ? 'Cancelling…' : cancelScope === 'one' ? 'Cancel lesson' : 'End the series'}
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirmCancelLesson(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      <div className="card stack">
        <h2>Attendance</h2>
        {notice && <p className="success" role="status">{notice}</p>}
        {error && <p className="error">{error}</p>}
        <ul className="att-list">
          {visible.map((a) => {
            const s = students.byId.get(a.studentId);
            return (
              <li key={a.id} className="att">
                <div className="att-head">
                  <Link className="att-name" to={`/students/${a.studentId}`}>
                    {studentName(s)}
                  </Link>
                  <span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                  {a.owed ? (
                    <span className="badge badge-warn">Owed</span>
                  ) : a.ledgerEntryId ? (
                    <span className="muted att-note">Used 1 credit</span>
                  ) : null}
                  <span className="muted att-note att-left" data-testid={`balance-${a.studentId}`}>
                    {s?.summary?.sessionsAvailable ?? 0} credits left
                  </span>
                </div>
                {!cancelled && !a.ledgerEntryId && (a.status === 'booked' || a.status === 'present' || a.status === 'absent') && (
                  <PackageSelect
                    studentId={a.studentId}
                    value={a.preferredEnrolmentId ?? null}
                    disabled={busy !== null}
                    onChange={(enrolmentId) =>
                      run(`${a.studentId}:package`, async () => {
                        await setAttendeePackage({ schoolId, lessonId, studentId: a.studentId, enrolmentId });
                        return `${studentName(s)}: ${enrolmentId ? 'package chosen' : 'back to earliest expiry'}.`;
                      })
                    }
                  />
                )}
                {cancelling === a.studentId ? (
                  <CancelChoice
                    late={isLate}
                    hours={policy.lateCancelHours}
                    returnsCredit={policy.lateCancelReturnsCredit}
                    busy={busy !== null}
                    onPick={(mode) => cancel(a.studentId, mode)}
                    onBack={() => setCancelling(null)}
                  />
                ) : (
                  <div className="row">
                    {ACTIONS.map((act) => (
                      <button
                        key={act.status}
                        className={`btn btn-sm ${act.className}`}
                        disabled={a.status === act.status || busy !== null || cancelled}
                        onClick={() => mark(a.studentId, act.status)}
                      >
                        {busy === `${a.studentId}:${act.status}` ? '…' : act.label}
                      </button>
                    ))}
                    <button
                      className="btn btn-sm"
                      disabled={busy !== null || cancelled || a.status === 'cancelled' || a.status === 'lateCancelled'}
                      onClick={() => setCancelling(a.studentId)}
                    >
                      Cancel…
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={busy !== null || cancelled}
                      onClick={() => remove(a.studentId)}
                      title="Take this student off the lesson"
                    >
                      {busy === `${a.studentId}:remove` ? '…' : 'Remove'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {visible.length === 0 && <p className="empty">No students on this lesson.</p>}
        {!cancelled && (
          <StudentSearch
            label="Add a student"
            placeholder={busy === 'add' ? 'Adding…' : 'Add a student: search by name, email or phone'}
            exclude={onLesson}
            disabled={busy !== null}
            onPick={add}
          />
        )}
      </div>
    </div>
  );
}
