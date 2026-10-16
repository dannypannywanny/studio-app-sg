// Teacher pay for a period: a teacher's own (My pay), or every teacher's for owners/admins (Reports > Teachers).
import { useEffect, useState } from 'react';
import { addDays, formatMoney, wallClockToUtc, wallDateOf } from '@lessonkaki/shared';
import { call } from '../firebase';
import { useTimeZone } from '../hooks';
import { useSchoolId } from '../session';

export interface PayRow {
  teacherId: string;
  name: string;
  pay: { method: 'perLesson' | 'hourly' | 'percent'; rateCents: number; percent: number } | null;
  lessons: number;
  minutes: number;
  creditValueCents: number;
  amountCents: number;
  unvalued: number;
}
const teacherPay = call<{ schoolId: string; from: string; to: string }, { rows: PayRow[] }>('teacherPay');

export const payLabel = (p: PayRow['pay']) =>
  !p ? 'No pay rate set' : p.method === 'perLesson' ? `${formatMoney(p.rateCents)} per lesson` : p.method === 'hourly' ? `${formatMoney(p.rateCents)} per hour` : `${p.percent}% of lesson value`;

/** First of this month to today, or last month in full. */
function periodOf(which: 'this' | 'last', tz: string) {
  const today = wallDateOf(new Date(), tz);
  const first = `${today.slice(0, 7)}-01`;
  if (which === 'this') return { from: first, to: addDays(today, 1) };
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1;
  const prev = new Date(Date.UTC(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 1)).toISOString().slice(0, 10);
  return { from: prev, to: first };
}

export function PayTable() {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const [which, setWhich] = useState<'this' | 'last'>('this');
  const [state, setState] = useState<{ rows: PayRow[]; loading: boolean; error: string | null }>({ rows: [], loading: true, error: null });
  useEffect(() => {
    const p = periodOf(which, tz);
    setState((s) => ({ ...s, loading: true }));
    teacherPay({ schoolId, from: wallClockToUtc(p.from, '00:00', tz).toISOString(), to: wallClockToUtc(p.to, '00:00', tz).toISOString() })
      .then((r) => setState({ rows: r.rows, loading: false, error: null }))
      .catch((e: Error) => setState({ rows: [], loading: false, error: e.message }));
  }, [schoolId, tz, which]);
  return (
    <div className="stack">
      <div className="tabs" role="group" aria-label="Period">
        <button className={`tab ${which === 'this' ? 'on' : ''}`} onClick={() => setWhich('this')}>
          This month
        </button>
        <button className={`tab ${which === 'last' ? 'on' : ''}`} onClick={() => setWhich('last')}>
          Last month
        </button>
      </div>
      {state.error && <p className="error">{state.error}</p>}
      {state.loading ? (
        <p className="muted">Working it out…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Teacher</th>
              <th>Rate</th>
              <th className="num">Lessons taught</th>
              <th className="num">Hours</th>
              <th className="num">Lesson value</th>
              <th className="num">Pay</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((r) => (
              <tr key={r.teacherId}>
                <td>{r.name}</td>
                <td className="muted">{payLabel(r.pay)}</td>
                <td className="num">{r.lessons}</td>
                <td className="num">{(r.minutes / 60).toFixed(1)}</td>
                <td className="num">
                  {formatMoney(r.creditValueCents)}
                  {r.unvalued > 0 && <span className="muted"> (+{r.unvalued} without a price)</span>}
                </td>
                <td className="num">
                  <strong>{formatMoney(r.amountCents)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">A lesson counts when a student was marked present or absent, or cancelled late and charged.</p>
    </div>
  );
}

export function MyPay() {
  return (
    <section className="stack">
      <div className="page-head">
        <h1>My pay</h1>
      </div>
      <PayTable />
    </section>
  );
}
