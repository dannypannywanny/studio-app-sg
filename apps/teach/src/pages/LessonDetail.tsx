import { collection, query } from 'firebase/firestore';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { resolvePolicy, type AttendanceStatus } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { studentName, useDoc, useFormatTs, useQuery, useSchool, useStudents, useTeachers } from '../hooks';
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

export function LessonDetail() {
  const { lessonId = '' } = useParams();
  const schoolId = useSchoolId();
  const fmt = useFormatTs();
  const lesson = useDoc<Lesson>(`schools/${schoolId}/lessons/${lessonId}`);
  const attendees = useQuery<Attendee>(`attendees:${lessonId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons', lessonId, 'attendees')),
  );
  const students = useStudents();
  const teachers = useTeachers();
  const policy = resolvePolicy(useSchool().data?.policy);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [confirmCancelLesson, setConfirmCancelLesson] = useState(false);
  const [reason, setReason] = useState('');

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

  const add = () =>
    run('add', async () => {
      await addAttendee({ schoolId, lessonId, studentId: adding });
      const name = studentName(students.byId.get(adding));
      setAdding('');
      return `${name} added.`;
    });

  const cancelWholeLesson = () =>
    run('cancelLesson', async () => {
      const res = await cancelLesson({ schoolId, lessonId, reason: reason.trim() || null });
      setConfirmCancelLesson(false);
      return `Lesson cancelled. ${res.restored} credit${res.restored === 1 ? '' : 's'} returned.`;
    });

  if (lesson.loading) return <p className="muted">Loading…</p>;
  if (!lesson.data) return <p className="empty">Lesson not found.</p>;
  const l = lesson.data;
  const cancelled = l.status === 'cancelled';
  const hoursToStart = (l.startAt.toMillis() - Date.now()) / 3_600_000;
  const isLate = hoursToStart < policy.lateCancelHours;
  const visible = attendees.data.filter((a) => a.status !== 'removed');
  const onLesson = new Set(visible.map((a) => a.studentId));
  const addable = students.data
    .filter((s) => s.status === 'active' && !onLesson.has(s.id))
    .sort((a, b) => studentName(a).localeCompare(studentName(b)));

  return (
    <section className="stack">
      <p>
        <Link to="/lessons">← Lessons</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{fmt(l.startAt)}</h1>
          <p className="muted">
            {l.durationMin} min · {l.isOnline ? 'Online' : 'In studio'} · with{' '}
            {teachers.byId.get(l.teacherId)?.displayName ?? '—'}
            {l.seriesId && ' · weekly series'}
          </p>
        </div>
        {cancelled ? (
          <span className="badge badge-void">Cancelled{l.cancelReason ? `: ${l.cancelReason}` : ''}</span>
        ) : (
          !confirmCancelLesson && (
            <button className="btn" onClick={() => setConfirmCancelLesson(true)}>
              Cancel lesson
            </button>
          )
        )}
      </div>

      {confirmCancelLesson && !cancelled && (
        <div className="card stack">
          <h2>Cancel this lesson?</h2>
          <p className="muted">Every student who was charged for it gets the credit back. Owed lessons are cleared.</p>
          <label className="field">
            <span>Reason (optional, shown on the lesson)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={busy !== null} onClick={cancelWholeLesson}>
              {busy === 'cancelLesson' ? 'Cancelling…' : 'Cancel lesson'}
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
        <table className="table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Status</th>
              <th>Credit</th>
              <th className="num">Credits left</th>
              <th>Mark</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const s = students.byId.get(a.studentId);
              return (
                <tr key={a.id}>
                  <td>
                    <Link to={`/students/${a.studentId}`}>{studentName(s)}</Link>
                  </td>
                  <td>
                    <span className={`badge badge-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                  </td>
                  <td>
                    {a.owed ? (
                      <span className="badge badge-warn">Owed</span>
                    ) : a.ledgerEntryId ? (
                      'Used 1 credit'
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num" data-testid={`balance-${a.studentId}`}>
                    {s?.summary?.sessionsAvailable ?? 0}
                  </td>
                  <td>
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && <p className="empty">No students on this lesson.</p>}
        {!cancelled && (
          <div className="row">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a student">
              <option value="">Add a student…</option>
              {addable.map((s) => (
                <option key={s.id} value={s.id}>
                  {studentName(s)}
                </option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={!adding || busy !== null} onClick={add}>
              {busy === 'add' ? 'Adding…' : 'Add to lesson'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
