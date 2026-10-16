import { collection, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { useState } from 'react';
import { Link } from 'react-router';
import { LessonForm } from '../components/LessonForm';
import { useLessonHref } from '../components/LessonSheet';
import { db } from '../firebase';
import { studentName, useFormatTs, useQuery, useStudents, useTeachers } from '../hooks';
import { useSchoolId } from '../session';
import type { Lesson } from '../types';

const STATE_LABEL = { unmarked: 'Not marked', partial: 'Partly marked', marked: 'Marked' } as const;

type Filter = 'all' | 'needsMarking';
const FILTERS: [Filter, string][] = [
  ['all', 'Latest'],
  ['needsMarking', 'Past, not marked'],
];

export function Lessons() {
  const schoolId = useSchoolId();
  const fmt = useFormatTs();
  const students = useStudents();
  const teachers = useTeachers();
  const lessonHref = useLessonHref();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  // "Past, not marked": lessons that have happened and still need their attendance recorded, newest
  // first. Cancelled lessons don't need marking.
  const lessons = useQuery<Lesson>(`lessons:${schoolId}:${filter}`, () =>
    filter === 'needsMarking'
      ? query(
          collection(db, 'schools', schoolId, 'lessons'),
          where('attendanceState', 'in', ['unmarked', 'partial']),
          where('startAt', '<', Timestamp.now()),
          orderBy('startAt', 'desc'),
          limit(300),
        )
      : query(collection(db, 'schools', schoolId, 'lessons'), orderBy('startAt', 'desc'), limit(100)),
  );
  const rows = filter === 'needsMarking' ? lessons.data.filter((l) => l.status !== 'cancelled') : lessons.data;

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
      <div className="tabs" role="tablist">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
            {label}
            {k === 'needsMarking' && filter === k && !lessons.loading ? ` (${rows.length})` : ''}
          </button>
        ))}
      </div>
      {lessons.error && <p className="error">{lessons.error.message}</p>}
      {lessons.loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">{filter === 'needsMarking' ? 'Nothing to mark: every past lesson has its attendance.' : 'No lessons yet.'}</p>
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
            {rows.map((l) => (
              <tr key={l.id} className={l.status === 'cancelled' ? 'cancelled' : ''}>
                <td>
                  <Link to={lessonHref(l.id)}>{fmt(l.startAt)}</Link>
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
