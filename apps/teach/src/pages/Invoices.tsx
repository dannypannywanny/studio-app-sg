// S08 Invoices: everything the school has billed, filterable by status, with the overdue list.
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDate, formatMoney, isOverdue } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTimeZone, type WithId } from '../hooks';
import { useSchoolId } from '../session';
import type { Invoice } from '../types';

const FILTERS = {
  outstanding: { label: 'Outstanding', test: (i: Invoice) => i.status === 'sent' || i.status === 'partial' },
  overdue: { label: 'Overdue', test: (i: Invoice) => isOverdue(i) },
  paid: { label: 'Paid', test: (i: Invoice) => i.status === 'paid' },
  void: { label: 'Void', test: (i: Invoice) => i.status === 'void' },
  all: { label: 'All', test: () => true },
} as const;
type Filter = keyof typeof FILTERS;

/** Status for display: overdue wins over sent/partial. */
export function invoiceBadge(inv: Invoice): { label: string; className: string } {
  if (isOverdue(inv)) return { label: inv.status === 'partial' ? 'Overdue · partial' : 'Overdue', className: 'badge-overdue' };
  const label = { draft: 'Draft', sent: 'Sent', partial: 'Partly paid', paid: 'Paid', void: 'Void' }[inv.status];
  return { label, className: `badge-${inv.status}` };
}

export function Invoices() {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const students = useStudents();
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as Filter | null) ?? 'outstanding';
  const [search, setSearch] = useState('');
  const invoices = useQuery<Invoice>(`invoices:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'invoices'), orderBy('issueDate', 'desc'), limit(500)),
  );

  const counts = useMemo(
    () => Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, invoices.data.filter(f.test).length])),
    [invoices.data],
  );
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return invoices.data
      .filter(FILTERS[filter].test)
      .filter(
        (i: WithId<Invoice>) =>
          !q || `${i.number} ${studentName(students.byId.get(i.studentId))}`.toLowerCase().includes(q),
      );
  }, [invoices.data, filter, search, students.byId]);
  const outstandingTotal = invoices.data.filter(FILTERS.outstanding.test).reduce((n, i) => n + i.pendingCents, 0);
  const overdueTotal = invoices.data.filter(FILTERS.overdue.test).reduce((n, i) => n + i.pendingCents, 0);

  return (
    <section className="stack">
      <div className="page-head">
        <h1>Invoices</h1>
      </div>
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Outstanding</span>
          <span className="tile-value">{formatMoney(outstandingTotal)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Overdue</span>
          <span className={`tile-value ${overdueTotal ? 'warn' : ''}`}>{formatMoney(overdueTotal)}</span>
        </div>
      </div>
      <div className="row">
        <div className="tabs" role="tablist">
          {(Object.keys(FILTERS) as Filter[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={filter === k}
              className={`tab ${filter === k ? 'on' : ''}`}
              onClick={() => setParams({ filter: k })}
            >
              {FILTERS[k].label} <span className="muted">{counts[k]}</span>
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search by number or student"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {invoices.error && <p className="error">{invoices.error.message}</p>}
      {invoices.loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">No invoices here.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Student</th>
              <th>Issued</th>
              <th>Due</th>
              <th className="num">Total</th>
              <th className="num">Outstanding</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inv) => {
              const badge = invoiceBadge(inv);
              return (
                <tr key={inv.id}>
                  <td>
                    <Link to={`/invoices/${inv.id}`}>{inv.number}</Link>
                  </td>
                  <td>
                    <Link to={`/students/${inv.studentId}`}>{studentName(students.byId.get(inv.studentId))}</Link>
                  </td>
                  <td>{formatDate(inv.issueDate.toDate(), tz)}</td>
                  <td>{formatDate(inv.dueDate.toDate(), tz)}</td>
                  <td className="num">{formatMoney(inv.totalCents, inv.currency)}</td>
                  <td className="num">{formatMoney(inv.pendingCents, inv.currency)}</td>
                  <td>
                    <span className={`badge ${badge.className}`}>{badge.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
