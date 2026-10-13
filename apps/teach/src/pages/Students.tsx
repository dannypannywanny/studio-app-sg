import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, startOfWeek, wallDateOf } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useStudents, useTimeZone } from '../hooks';
import type { Student } from '../types';
import { useSchoolId } from '../session';

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

function StudentStats({ students }: { students: Student[] }) {
  const tz = useTimeZone();
  const today = wallDateOf(new Date(), tz);
  const monday = startOfWeek(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const current = students.filter((s) => s.status !== 'archived');
  const joined = current.map((s) => joinedOn(s, tz));
  const tiles: [string, number][] = [
    ['Total students', current.length],
    ['Active', current.filter((s) => s.status === 'active').length],
    ['New this week', joined.filter((d) => d && d >= monday).length],
    ['New this month', joined.filter((d) => d && d >= monthStart).length],
    ['New last 30 days', joined.filter((d) => d && d > addDays(today, -30)).length],
  ];
  return (
    <div className="tiles">
      {tiles.map(([label, n]) => (
        <div key={label} className="tile">
          <span className="tile-label">{label}</span>
          <span className="tile-value">{n}</span>
        </div>
      ))}
    </div>
  );
}

export function Students() {
  const { data, loading, error } = useStudents();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data
      .filter((s) => !q || `${studentName(s)} ${s.email ?? ''} ${s.phone ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => studentName(a).localeCompare(studentName(b)));
  }, [data, search]);

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
      {!loading && <StudentStats students={data} />}
      {adding && <NewStudentForm onDone={() => setAdding(false)} />}
      <input
        className="search"
        type="search"
        placeholder="Search by name, email or phone"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
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
              <th>Email</th>
              <th>Phone</th>
              <th className="num">Credits</th>
              <th className="num">Owed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/students/${s.id}`}>{studentName(s)}</Link>
                </td>
                <td>{s.email}</td>
                <td>{s.phone}</td>
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
