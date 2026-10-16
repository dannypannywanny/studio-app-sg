// S11 Attendance report: per-student counts over a period, plus who needs attention.
import { collection, collectionGroup, query, Timestamp, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  RISK_LABEL,
  addDays,
  atRiskStudents,
  summariseAttendance,
  wallClockToUtc,
  wallDateOf,
  type AttendanceRow,
} from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Attendee, Enrolment, Lesson, Ts } from '../types';

const PERIODS = { 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' } as const;
type Days = keyof typeof PERIODS;

const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

export function AttendanceReport() {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const students = useStudents();
  const [days, setDays] = useState<Days>(90);
  const today = wallDateOf(new Date(), tz);
  const from = wallClockToUtc(addDays(today, -days), '00:00', tz);
  const to = wallClockToUtc(addDays(today, 1), '00:00', tz);
  const nowTs = useMemo(() => Timestamp.now(), []);

  const attendees = useQuery<Attendee & { lessonStartAt: Ts }>(`report:${schoolId}:${days}:${today}`, () =>
    query(
      collectionGroup(db, 'attendees'),
      where('schoolId', '==', schoolId),
      where('lessonStartAt', '>=', Timestamp.fromDate(from)),
      where('lessonStartAt', '<', Timestamp.fromDate(to)),
    ),
  );
  const upcoming = useQuery<Lesson>(`upcoming:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons'), where('startAt', '>=', nowTs)),
  );
  const lots = useQuery<Enrolment>(`activeLots:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'enrolments'), where('status', '==', 'active')),
  );

  const rows: AttendanceRow[] = useMemo(
    () => attendees.data.map((a) => ({ studentId: a.studentId, status: a.status, lessonStartAt: a.lessonStartAt.toDate() })),
    [attendees.data],
  );
  const stats = useMemo(() => summariseAttendance(rows), [rows]);
  const risk = useMemo(() => {
    const upcomingByStudent = new Map<string, number>();
    for (const l of upcoming.data) {
      if (l.status === 'cancelled') continue;
      for (const id of l.studentIds) upcomingByStudent.set(id, (upcomingByStudent.get(id) ?? 0) + 1);
    }
    return atRiskStudents({
      now: new Date(),
      students: students.data.map((s) => ({
        id: s.id,
        status: s.status,
        sessionsAvailable: s.summary?.sessionsAvailable ?? 0,
        sessionsOwed: s.summary?.sessionsOwed ?? 0,
      })),
      attendance: rows,
      upcomingByStudent,
      lots: lots.data.map((l) => ({ studentId: l.studentId, remaining: l.sessionsRemaining, validUntil: l.validUntil.toDate() })),
    });
  }, [students.data, rows, upcoming.data, lots.data]);

  const table = [...stats.entries()]
    .map(([id, s]) => ({ id, s, name: studentName(students.byId.get(id)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const totals = summariseAttendance(rows.map((r) => ({ ...r, studentId: 'all' }))).get('all');

  return (
    <section className="stack">
      <div className="page-head">
        <h2>Attendance</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value) as Days)} aria-label="Period">
          {Object.entries(PERIODS).map(([d, label]) => (
            <option key={d} value={d}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {attendees.error && <p className="error">{attendees.error.message}</p>}

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Attendance rate</span>
          <span className="tile-value">{pct(totals?.rate ?? null)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Present</span>
          <span className="tile-value">{totals?.present ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Absent + late cancels</span>
          <span className="tile-value">{(totals?.absent ?? 0) + (totals?.lateCancelled ?? 0)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Needs attention</span>
          <span className={`tile-value ${risk.length ? 'warn' : ''}`}>{risk.length}</span>
        </div>
      </div>

      <div className="card stack">
        <h2>Needs attention</h2>
        {risk.length === 0 ? (
          <p className="empty">Everyone looks fine.</p>
        ) : (
          <table className="table">
            <tbody>
              {risk.map((r) => (
                <tr key={r.studentId}>
                  <td>
                    <Link to={`/students/${r.studentId}`}>{studentName(students.byId.get(r.studentId))}</Link>
                  </td>
                  <td>
                    {r.reasons.map((reason) => (
                      <span key={reason} className="badge badge-warn">
                        {RISK_LABEL[reason]}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card stack">
        <h2>By student</h2>
        {table.length === 0 ? (
          <p className="empty">No lessons in this period.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th className="num">Present</th>
                <th className="num">Absent</th>
                <th className="num">Late cancel</th>
                <th className="num">Cancelled</th>
                <th className="num">Not marked</th>
                <th className="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              {table.map(({ id, s, name }) => (
                <tr key={id}>
                  <td>
                    <Link to={`/students/${id}`}>{name}</Link>
                  </td>
                  <td className="num">{s.present}</td>
                  <td className="num">{s.absent}</td>
                  <td className="num">{s.lateCancelled}</td>
                  <td className="num">{s.cancelled}</td>
                  <td className="num">{s.unmarked}</td>
                  <td className="num">{pct(s.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
