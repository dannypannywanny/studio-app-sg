import { addDoc, collection, query, serverTimestamp } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { addDays, formatDate, startOfWeek, wallClockToUtc, wallDateOf } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTimeZone } from '../hooks';
import type { Enrolment, Student } from '../types';
import { useSchoolId, useSession } from '../session';

function NewStudentForm({ onDone }: { onDone: () => void }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Contact fields only: rules reject `summary` on create; balances are function-maintained.
      const ref = await addDoc(collection(db, 'schools', schoolId, 'students'), {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        preferredName: null,
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        status: 'active',
        createdOn: wallDateOf(new Date(), tz),
        notes: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      onDone();
      navigate(`/students/${ref.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field">
        <span>First name</span>
        <input required value={form.firstName} onChange={set('firstName')} />
      </label>
      <label className="field">
        <span>Last name</span>
        <input value={form.lastName} onChange={set('lastName')} />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" value={form.email} onChange={set('email')} />
      </label>
      <label className="field">
        <span>Phone</span>
        <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+65 …" />
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add student'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

/** When the student joined: their own date, else the day the record was made. */
function joinedOn(s: Student, tz: string): string | null {
  return s.createdOn ?? (s.createdAt ? wallDateOf(s.createdAt.toDate(), tz) : null);
}

type Filter = 'all' | 'active' | 'week' | 'month' | '30d' | 'nopackage';
type Sort = 'newest' | 'name';

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['week', 'New this week'],
  ['month', 'New this month'],
  ['30d', 'New last 30 days'],
  ['nopackage', 'No package yet'],
];

export function Students() {
  const schoolId = useSchoolId();
  const { role } = useSession();
  const tz = useTimeZone();
  const { data, loading, error } = useStudents();
  // Teachers can't read enrolments, so "no package" is staff-only.
  const canSeePackages = role !== 'teacher';
  const enrolments = useQuery<Enrolment>(canSeePackages ? `enrolments-all:${schoolId}` : null, () =>
    query(collection(db, 'schools', schoolId, 'enrolments')),
  );
  const [params, setParams] = useSearchParams();
  const filter = (params.get('show') as Filter | null) ?? 'all';
  const sort = (params.get('sort') as Sort | null) ?? 'newest';
  const setParam = (k: string, v: string, dflt: string) =>
    setParams(
      (p) => {
        if (v === dflt) p.delete(k);
        else p.set(k, v);
        return p;
      },
      { replace: true },
    );
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const today = wallDateOf(new Date(), tz);
  const since: Partial<Record<Filter, string>> = {
    week: startOfWeek(today),
    month: `${today.slice(0, 7)}-01`,
    '30d': addDays(today, -29),
  };
  const bought = useMemo(() => new Set(enrolments.data.map((e) => e.studentId)), [enrolments.data]);
  const noPackage = (s: Student & { id: string }) => canSeePackages && !enrolments.loading && !bought.has(s.id);

  // Leads have their own page until they become students.
  const students = useMemo(() => data.filter((s) => s.status !== 'lead'), [data]);
  const inFilter = (s: Student & { id: string }, f: Filter): boolean => {
    if (f === 'all') return true;
    if (s.status === 'archived') return false;
    if (f === 'active') return s.status === 'active';
    if (f === 'nopackage') return noPackage(s);
    const d = joinedOn(s, tz);
    return !!d && d >= since[f]!;
  };
  const count = (f: Filter) => students.filter((s) => inFilter(s, f)).length;

  const q = search.trim().toLowerCase();
  const rows = students
    .filter((s) => inFilter(s, filter))
    .filter((s) => !q || `${studentName(s)} ${s.email ?? ''} ${s.phone ?? ''}`.toLowerCase().includes(q))
    .map((s) => ({ s, joined: joinedOn(s, tz) }))
    .sort((a, b) =>
      sort === 'newest'
        ? (b.joined ?? '').localeCompare(a.joined ?? '') ||
          (b.s.createdAt?.toMillis() ?? 0) - (a.s.createdAt?.toMillis() ?? 0) ||
          studentName(a.s).localeCompare(studentName(b.s))
        : studentName(a.s).localeCompare(studentName(b.s)),
    );

  const current = students.filter((s) => s.status !== 'archived').length;
  const tiles: [Filter, string, number][] = [
    ['all', 'Total students', current],
    ['active', 'Active', count('active')],
    ['week', 'New this week', count('week')],
    ['month', 'New this month', count('month')],
    ['30d', 'New last 30 days', count('30d')],
  ];
  const showDate = (d: string) => formatDate(wallClockToUtc(d, '12:00', tz), tz);
  const pick = (f: Filter) => setParam('show', f, 'all');

  return (
    <section className="stack">
      <div className="page-head">
        <h1>Students</h1>
        {!adding && (
          <div className="row">
            <Link className="btn" to="/students/import">
              Import CSV
            </Link>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              New student
            </button>
          </div>
        )}
      </div>
      {!loading && (
        <div className="tiles">
          {tiles.map(([f, label, n]) => (
            <button
              key={f}
              type="button"
              className={`tile tile-link tile-btn ${filter === f && f !== 'all' ? 'on' : ''}`}
              aria-pressed={filter === f}
              onClick={() => pick(filter === f ? 'all' : f)}
            >
              <span className="tile-label">{label}</span>
              <span className="tile-value">{n}</span>
            </button>
          ))}
        </div>
      )}
      {adding && <NewStudentForm onDone={() => setAdding(false)} />}
      <div className="row">
        <div className="tabs" role="group" aria-label="Show">
          {FILTERS.filter(([f]) => f !== 'nopackage' || canSeePackages).map(([f, label]) => (
            <button key={f} type="button" className={`tab ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => pick(f)}>
              {label}
              {f !== 'all' && !loading && ` · ${count(f)}`}
            </button>
          ))}
        </div>
        <select aria-label="Sort" value={sort} onChange={(e) => setParam('sort', e.target.value, 'newest')}>
          <option value="newest">Newest first</option>
          <option value="name">Name A–Z</option>
        </select>
        <input
          className="search"
          type="search"
          placeholder="Search by name, email or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {filter === 'nopackage' && (
        <p className="muted">Students who have never had a package. Good people to get in touch with.</p>
      )}
      {error && <p className="error">{error.message}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">{data.length ? 'No students match.' : 'No students yet. Add your first one.'}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Joined</th>
              <th>Email</th>
              <th>Phone</th>
              <th className="num">Credits</th>
              <th className="num">Owed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, joined }) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/students/${s.id}`}>{studentName(s)}</Link>
                  {noPackage(s) && s.status !== 'archived' && (
                    <>
                      {' '}
                      <span className="badge badge-warn">No package</span>
                    </>
                  )}
                </td>
                <td className="nowrap">{joined ? showDate(joined) : '—'}</td>
                <td>{s.email && <a href={`mailto:${s.email}`}>{s.email}</a>}</td>
                <td>{s.phone && <a href={`tel:${s.phone.replace(/\s+/g, '')}`}>{s.phone}</a>}</td>
                <td className="num">{s.summary?.sessionsAvailable ?? 0}</td>
                <td className="num">{s.summary?.sessionsOwed ? <span className="badge badge-warn">{s.summary.sessionsOwed}</span> : 0}</td>
                <td>
                  <span className={`badge badge-${s.status}`}>{s.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
