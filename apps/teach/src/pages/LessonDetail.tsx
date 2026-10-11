import { collection, query } from 'firebase/firestore';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AttendanceStatus } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { studentName, useDoc, useFormatTs, useQuery, useStudents, useTeachers } from '../hooks';
import { useSchoolId } from '../session';
import type { Attendee, Lesson } from '../types';

type Markable = 'present' | 'absent' | 'lateCancelled' | 'booked';

const markAttendance = call<
  { schoolId: string; lessonId: string; studentId: string; status: Markable },
  { status: AttendanceStatus; charge: string }
>('markAttendance');

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
  { status: 'lateCancelled', label: 'Late cancel', className: '' },
  { status: 'booked', label: 'Unmark', className: 'btn-ghost' },
];

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mark(studentId: string, status: Markable) {
    setBusy(`${studentId}:${status}`);
    setError(null);
    try {
      await markAttendance({ schoolId, lessonId, studentId, status });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (lesson.loading) return <p className="muted">Loading…</p>;
  if (!lesson.data) return <p className="empty">Lesson not found.</p>;
  const l = lesson.data;

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
            {l.status === 'cancelled' && ' · cancelled'}
          </p>
        </div>
      </div>

      <div className="card stack">
        <h2>Attendance</h2>
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
            {attendees.data.map((a) => {
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
                    <div className="row">
                      {ACTIONS.map((act) => (
                        <button
                          key={act.status}
                          className={`btn btn-sm ${act.className}`}
                          disabled={a.status === act.status || busy !== null || l.status === 'cancelled'}
                          onClick={() => mark(a.studentId, act.status)}
                        >
                          {busy === `${a.studentId}:${act.status}` ? '…' : act.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
