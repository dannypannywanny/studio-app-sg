import { collection, limit, orderBy, query } from 'firebase/firestore';
import { useState } from 'react';
import { Link } from 'react-router';
import { LessonForm } from '../components/LessonForm';
import { db } from '../firebase';
import { studentName, useFormatTs, useQuery, useStudents, useTeachers } from '../hooks';
import { useSchoolId } from '../session';
import type { Lesson } from '../types';

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
      {adding && <LessonForm onDone={() => setAdding(false)} />}
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
                  <span className="muted"> · {l.durationMin} min{l.seriesId ? ' · weekly' : ''}</span>
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
