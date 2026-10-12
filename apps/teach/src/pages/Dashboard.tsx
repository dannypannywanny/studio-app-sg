// S01 Dashboard: today's lessons, money owed to the school, lessons students owe.
import { collection, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { Link } from 'react-router';
import { addDays, formatDate, formatMoney, isOverdue, wallClockToUtc, wallDateOf, wallTimeOf } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Invoice, Lesson } from '../types';
import { invoiceBadge } from './Invoices';

const STATE_LABEL = { unmarked: 'Not marked', partial: 'Partly marked', marked: 'Marked' } as const;

export function Dashboard() {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const students = useStudents();
  const teachers = useTeachers();
  const today = wallDateOf(new Date(), tz);
  const from = wallClockToUtc(today, '00:00', tz);
  const to = wallClockToUtc(addDays(today, 1), '00:00', tz);

  const lessons = useQuery<Lesson>(`today:${schoolId}:${today}`, () =>
    query(
      collection(db, 'schools', schoolId, 'lessons'),
      where('startAt', '>=', Timestamp.fromDate(from)),
      where('startAt', '<', Timestamp.fromDate(to)),
      orderBy('startAt'),
    ),
  );
  const open = useQuery<Invoice>(`openInvoices:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'invoices'), where('status', 'in', ['sent', 'partial'])),
  );

  const overdue = open.data.filter((i) => isOverdue(i)).sort((a, b) => a.dueDate.toMillis() - b.dueDate.toMillis());
  const outstanding = open.data.reduce((n, i) => n + i.pendingCents, 0);
  const overdueTotal = overdue.reduce((n, i) => n + i.pendingCents, 0);
  const owing = students.data
    .filter((s) => (s.summary?.sessionsOwed ?? 0) > 0)
    .sort((a, b) => (b.summary?.sessionsOwed ?? 0) - (a.summary?.sessionsOwed ?? 0));
  const owedLessons = owing.reduce((n, s) => n + (s.summary?.sessionsOwed ?? 0), 0);
  const scheduled = lessons.data.filter((l) => l.status !== 'cancelled');
  const toMark = scheduled.filter((l) => l.attendanceState !== 'marked' && l.endAt.toMillis() < Date.now()).length;

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p className="muted">{formatDate(from, tz)}</p>
        </div>
        <Link className="btn" to="/calendar">
          Open calendar
        </Link>
      </div>

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Lessons today</span>
          <span className="tile-value" data-testid="lessons-today">{scheduled.length}</span>
        </div>
        <div className="tile">
          <span className="tile-label">To mark</span>
          <span className={`tile-value ${toMark ? 'warn' : ''}`}>{toMark}</span>
        </div>
        <Link className="tile tile-link" to="/invoices?filter=outstanding">
          <span className="tile-label">Outstanding</span>
          <span className="tile-value" data-testid="outstanding-total">{formatMoney(outstanding)}</span>
        </Link>
        <Link className="tile tile-link" to="/invoices?filter=overdue">
          <span className="tile-label">Overdue · {overdue.length}</span>
          <span className={`tile-value ${overdueTotal ? 'warn' : ''}`}>{formatMoney(overdueTotal)}</span>
        </Link>
        <div className="tile">
          <span className="tile-label">Lessons owed</span>
          <span className={`tile-value ${owedLessons ? 'warn' : ''}`} data-testid="owed-total">{owedLessons}</span>
        </div>
      </div>

      <div className="card stack">
        <h2>Today's lessons</h2>
        {lessons.loading ? (
          <p className="muted">Loading…</p>
        ) : lessons.data.length === 0 ? (
          <p className="empty">No lessons today.</p>
        ) : (
          <table className="table">
            <tbody>
              {lessons.data.map((l) => (
                <tr key={l.id} className={l.status === 'cancelled' ? 'cancelled' : ''}>
                  <td>
                    <Link to={`/lessons/${l.id}`}>{wallTimeOf(l.startAt.toDate(), tz)}</Link>
                    <span className="muted"> · {l.durationMin} min</span>
                  </td>
                  <td>{l.studentIds.map((id) => studentName(students.byId.get(id))).join(', ') || '—'}</td>
                  <td>{teachers.byId.get(l.teacherId)?.displayName ?? '—'}</td>
                  <td>
                    {l.status === 'cancelled' ? (
                      <span className="badge badge-cancelled">Cancelled</span>
                    ) : (
                      <span className={`badge badge-${l.attendanceState}`}>{STATE_LABEL[l.attendanceState]}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="split">
        <div className="card stack">
          <h2>Overdue invoices</h2>
          {overdue.length === 0 ? (
            <p className="empty">Nothing overdue.</p>
          ) : (
            <table className="table">
              <tbody>
                {overdue.slice(0, 8).map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <Link to={`/invoices/${inv.id}`}>{inv.number}</Link>
                    </td>
                    <td>{studentName(students.byId.get(inv.studentId))}</td>
                    <td className="muted">due {formatDate(inv.dueDate.toDate(), tz)}</td>
                    <td className="num">{formatMoney(inv.pendingCents, inv.currency)}</td>
                    <td>
                      <span className={`badge ${invoiceBadge(inv).className}`}>{invoiceBadge(inv).label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {overdue.length > 8 && <Link to="/invoices?filter=overdue">All {overdue.length} overdue invoices</Link>}
        </div>

        <div className="card stack">
          <h2>Students owing lessons</h2>
          {owing.length === 0 ? (
            <p className="empty">No owed lessons.</p>
          ) : (
            <table className="table">
              <tbody>
                {owing.slice(0, 8).map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/students/${s.id}`}>{studentName(s)}</Link>
                    </td>
                    <td className="num">
                      <span className="badge badge-warn">{s.summary?.sessionsOwed} owed</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
