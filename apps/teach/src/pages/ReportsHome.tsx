// S11 Reports: attendance, revenue and teachers, as tabs (?tab=).
import { collection, query, Timestamp, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { addDays, formatMoney, wallClockToUtc, wallDateOf } from '@lessonkaki/shared';
import { db } from '../firebase';
import { useQuery, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Invoice, Lesson, Payment } from '../types';
import { AttendanceReport } from './Reports';

const TABS = [
  ['attendance', 'Attendance'],
  ['revenue', 'Revenue'],
  ['teachers', 'Teachers'],
] as const;
type Tab = (typeof TABS)[number][0];

const PERIODS = { 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' } as const;
type Days = keyof typeof PERIODS;

function usePeriod() {
  const tz = useTimeZone();
  const [days, setDays] = useState<Days>(90);
  const today = wallDateOf(new Date(), tz);
  const from = wallClockToUtc(addDays(today, -days + 1), '00:00', tz);
  const to = wallClockToUtc(addDays(today, 1), '00:00', tz);
  const picker = (
    <div className="tabs" role="group" aria-label="Period">
      {(Object.keys(PERIODS) as unknown as Days[]).map((d) => (
        <button key={d} className={`tab ${Number(days) === Number(d) ? 'on' : ''}`} onClick={() => setDays(Number(d) as Days)}>
          {PERIODS[d]}
        </button>
      ))}
    </div>
  );
  return { days, from, to, today, tz, picker };
}

const monthOf = (d: Date, tz: string) => wallDateOf(d, tz).slice(0, 7);
const monthLabel = (ym: string) =>
  new Date(`${ym}-15T00:00:00Z`).toLocaleDateString('en-SG', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function Bars({ rows, money = true }: { rows: { label: string; value: number; sub?: string }[]; money?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="bars-label">{r.label}</span>
          <span className="bars-track">
            <span className="bars-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bars-value num">
            {money ? formatMoney(r.value) : r.value}
            {r.sub && <span className="muted"> · {r.sub}</span>}
          </span>
        </li>
      ))}
      {rows.length === 0 && <li className="empty">Nothing in this period.</li>}
    </ul>
  );
}

function RevenueReport() {
  const schoolId = useSchoolId();
  const p = usePeriod();
  const payments = useQuery<Payment>(`rev-pay:${schoolId}:${p.days}:${p.today}`, () =>
    query(collection(db, 'schools', schoolId, 'payments'), where('paidAt', '>=', Timestamp.fromDate(p.from)), where('paidAt', '<', Timestamp.fromDate(p.to))),
  );
  const invoices = useQuery<Invoice>(`rev-inv:${schoolId}:${p.days}:${p.today}`, () =>
    query(collection(db, 'schools', schoolId, 'invoices'), where('issueDate', '>=', Timestamp.fromDate(p.from)), where('issueDate', '<', Timestamp.fromDate(p.to))),
  );
  const r = useMemo(() => {
    // Refunds are payments with a negative amount, so they come off what was collected.
    const ok = payments.data.filter((x) => x.status === 'succeeded' || x.status === 'refund');
    const collected = ok.reduce((n, x) => n + x.amountCents, 0);
    const live = invoices.data.filter((i) => i.status !== 'void');
    const invoiced = live.reduce((n, i) => n + i.totalCents, 0);
    const discounts = live.reduce((n, i) => n + (i.discountCents ?? 0), 0);
    const byMonth = new Map<string, number>();
    for (const x of ok) {
      const m = monthOf(x.paidAt.toDate(), p.tz);
      byMonth.set(m, (byMonth.get(m) ?? 0) + x.amountCents);
    }
    const byMethod = new Map<string, number>();
    for (const x of ok) byMethod.set(x.method, (byMethod.get(x.method) ?? 0) + x.amountCents);
    const byPackage = new Map<string, { cents: number; count: number }>();
    for (const i of live) {
      for (const l of i.lines) {
        const v = byPackage.get(l.desc) ?? { cents: 0, count: 0 };
        v.cents += l.qty * l.unitCents;
        v.count += l.qty;
        byPackage.set(l.desc, v);
      }
    }
    const outstanding = live.filter((i) => i.status === 'sent' || i.status === 'partial').reduce((n, i) => n + i.pendingCents, 0);
    return { collected, invoiced, discounts, outstanding, byMonth, byMethod, byPackage };
  }, [payments.data, invoices.data, p.tz]);
  const METHOD: Record<string, string> = { paynow: 'PayNow', bank: 'Bank transfer', cash: 'Cash', card_hitpay: 'Card (HitPay)' };

  return (
    <div className="stack">
      {p.picker}
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Collected</span>
          <span className="tile-value">{formatMoney(r.collected)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Invoiced</span>
          <span className="tile-value">{formatMoney(r.invoiced)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Discounts given</span>
          <span className="tile-value">{formatMoney(r.discounts)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Still unpaid (from these invoices)</span>
          <span className={`tile-value ${r.outstanding ? 'warn' : ''}`}>{formatMoney(r.outstanding)}</span>
        </div>
      </div>
      <div className="split">
        <div className="card stack">
          <h2>Collected by month</h2>
          <Bars rows={[...r.byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ label: monthLabel(m), value: v }))} />
        </div>
        <div className="card stack">
          <h2>By payment method</h2>
          <Bars rows={[...r.byMethod].sort((a, b) => b[1] - a[1]).map(([m, v]) => ({ label: METHOD[m] ?? m, value: v }))} />
        </div>
      </div>
      <div className="card stack">
        <h2>Sales by package</h2>
        <Bars
          rows={[...r.byPackage]
            .sort((a, b) => b[1].cents - a[1].cents)
            .map(([desc, v]) => ({ label: desc, value: v.cents, sub: `${v.count} sold` }))}
        />
      </div>
      {(payments.error || invoices.error) && <p className="error">{(payments.error ?? invoices.error)!.message}</p>}
    </div>
  );
}

function TeachersReport() {
  const schoolId = useSchoolId();
  const p = usePeriod();
  const teachers = useTeachers();
  const lessons = useQuery<Lesson>(`teach-rep:${schoolId}:${p.days}:${p.today}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons'), where('startAt', '>=', Timestamp.fromDate(p.from)), where('startAt', '<', Timestamp.fromDate(p.to))),
  );
  const rows = useMemo(() => {
    const by = new Map<string, { lessons: number; minutes: number; cancelled: number; students: Set<string>; unmarked: number }>();
    const past = Date.now();
    for (const l of lessons.data) {
      const v = by.get(l.teacherId) ?? { lessons: 0, minutes: 0, cancelled: 0, students: new Set<string>(), unmarked: 0 };
      if (l.status === 'cancelled') v.cancelled++;
      else {
        v.lessons++;
        v.minutes += l.durationMin;
        l.studentIds.forEach((s) => v.students.add(s));
        if (l.endAt.toMillis() < past && l.attendanceState !== 'marked') v.unmarked++;
      }
      by.set(l.teacherId, v);
    }
    return [...by].map(([id, v]) => ({ id, name: teachers.byId.get(id)?.displayName ?? 'Teacher', ...v })).sort((a, b) => b.minutes - a.minutes);
  }, [lessons.data, teachers.byId]);
  return (
    <div className="stack">
      {p.picker}
      <table className="table">
        <thead>
          <tr>
            <th>Teacher</th>
            <th className="num">Lessons</th>
            <th className="num">Hours taught</th>
            <th className="num">Students</th>
            <th className="num">Cancelled</th>
            <th className="num">Past, not marked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="num">{r.lessons}</td>
              <td className="num">{(r.minutes / 60).toFixed(1)}</td>
              <td className="num">{r.students.size}</td>
              <td className="num">{r.cancelled}</td>
              <td className="num">{r.unmarked ? <span className="badge badge-warn">{r.unmarked}</span> : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="empty">No lessons in this period.</p>}
    </div>
  );
}

export function Reports() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS.find(([t]) => t === params.get('tab'))?.[0] ?? 'attendance') as Tab;
  return (
    <section className="stack">
      <div className="page-head">
        <h1>Reports</h1>
        <div className="tabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setParams({ tab: t })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'attendance' && <AttendanceReport />}
      {tab === 'revenue' && <RevenueReport />}
      {tab === 'teachers' && <TeachersReport />}
    </section>
  );
}
