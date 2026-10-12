// S06 Import students from a CSV (Classcard's export format), with a review step before anything is written.
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  CLASSCARD_STUDENT_HEADERS,
  csvToObjects,
  mapClasscardRows,
  planImport,
  summarisePlan,
  type ImportAction,
  type PlanRow,
} from '@lessonkaki/shared';
import { call } from '../firebase';
import { useStudents } from '../hooks';
import { useSchoolId, useSession } from '../session';

const importStudents = call<
  { schoolId: string; rows: PlanRow['candidate'][]; excludeEmails: string[] },
  { created: number; skipped: { row: number; action: ImportAction }[] }
>('importStudents');

const ACTION_LABEL: Record<ImportAction, string> = {
  create: 'New',
  duplicateInFile: 'Duplicate in file',
  matchesExisting: 'Already a student',
  skip: 'Skipped',
};
const REASON_LABEL: Record<string, string> = {
  demo: 'looks like a demo/test row',
  noIdentity: 'no name or email',
  excludedEmail: 'your own account',
  email: 'same email',
  phone: 'same phone',
  legacyId: 'same Classcard id',
};
const ISSUE_LABEL: Record<string, string> = {
  badEmail: 'email unreadable',
  badPhone: 'phone unreadable',
  placeholderSurname: 'placeholder surname removed',
  noLegacyId: 'no Classcard id',
  duplicateLegacyId: 'Classcard id used twice',
  noName: 'no first name',
};

export function ImportStudents() {
  const schoolId = useSchoolId();
  const { user } = useSession();
  const students = useStudents();
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exclude = useMemo(() => (user?.email ? [user.email] : []), [user?.email]);

  const parsed = useMemo(() => (text ? csvToObjects(text) : null), [text]);
  const missing = parsed ? CLASSCARD_STUDENT_HEADERS.filter((h) => ['First Name', 'Email', 'Phone'].includes(h) && !parsed.headers.includes(h)) : [];
  const plan = useMemo(() => {
    if (!parsed) return [];
    const existing = students.data.map((s) => ({
      id: s.id,
      email: s.email ?? null,
      phone: s.phone ?? null,
      legacyId: (s as { legacyId?: string | null }).legacyId ?? null,
    }));
    return planImport(mapClasscardRows(parsed.rows), existing, { excludeEmails: exclude });
  }, [parsed, students.data, exclude]);
  const counts = summarisePlan(plan);

  async function pick(file: File | undefined) {
    setResult(null);
    setError(null);
    if (!file) return;
    const t = await file.text();
    const rows = csvToObjects(t).rows;
    const p = planImport(mapClasscardRows(rows), [], {});
    setFileName(file.name);
    setText(t);
    // Default: import the rows that are new. The table lets staff change that.
    setInclude(new Set(p.filter((r) => r.action === 'create').map((r) => r.candidate.row)));
  }

  // Re-default when the plan changes (e.g. students finished loading).
  const defaults = useMemo(() => new Set(plan.filter((p) => p.action === 'create').map((p) => p.candidate.row)), [plan]);
  const chosen = plan.filter((p) => include.has(p.candidate.row) && defaults.has(p.candidate.row));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await importStudents({ schoolId, rows: chosen.map((p) => p.candidate), excludeEmails: exclude });
      setResult(`${res.created} students imported.${res.skipped.length ? ` ${res.skipped.length} rows were skipped on the final check.` : ''}`);
      setText(null);
      setFileName(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (row: number) =>
    setInclude((s) => {
      const n = new Set(s);
      if (n.has(row)) n.delete(row);
      else n.add(row);
      return n;
    });

  return (
    <section className="stack">
      <p>
        <Link to="/students">← Students</Link>
      </p>
      <h1>Import students</h1>
      <p className="muted">
        Upload a CSV in Classcard's student export format. Nothing is saved until you review the list and press Import.
        Duplicates are matched on email and phone (normalised to +65…), and against students already here.
      </p>
      <label className="field">
        <span>CSV file</span>
        <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      {result && <p className="success" role="status">{result}</p>}
      {error && <p className="error">{error}</p>}
      {parsed && missing.length > 0 && <p className="error">This file is missing columns: {missing.join(', ')}.</p>}

      {parsed && plan.length > 0 && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-label">Rows in {fileName}</span>
              <span className="tile-value">{plan.length}</span>
            </div>
            <div className="tile">
              <span className="tile-label">New</span>
              <span className="tile-value">{counts.create}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Duplicates</span>
              <span className="tile-value">{counts.duplicateInFile + counts.matchesExisting}</span>
            </div>
            <div className="tile">
              <span className="tile-label">Skipped</span>
              <span className="tile-value">{counts.skip}</span>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={busy || chosen.length === 0} onClick={run}>
              {busy ? 'Importing…' : `Import ${chosen.length} student${chosen.length === 1 ? '' : 's'}`}
            </button>
            <span className="muted">Untick anyone you don't want. Duplicates and skipped rows are never imported.</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Row</th>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Classcard id</th>
                <th>Status</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {plan.map((p) => {
                const c = p.candidate;
                const can = p.action === 'create';
                return (
                  <tr key={c.row} className={can ? '' : 'muted-row'}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Import row ${c.row}`}
                        disabled={!can}
                        checked={can && include.has(c.row)}
                        onChange={() => toggle(c.row)}
                      />
                    </td>
                    <td>{c.row}</td>
                    <td>{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}</td>
                    <td>{c.email ?? '—'}</td>
                    <td title={c.phoneRaw}>{c.phone ?? (c.phoneRaw ? `? ${c.phoneRaw}` : '—')}</td>
                    <td>{c.legacyId ?? '—'}</td>
                    <td>{c.status}</td>
                    <td>
                      <span className={`badge ${can ? 'badge-active' : p.action === 'skip' ? 'badge-cancelled' : 'badge-warn'}`}>
                        {ACTION_LABEL[p.action]}
                      </span>
                      {p.reasons.length > 0 && (
                        <span className="muted">
                          {' '}
                          {p.reasons.map((r) => REASON_LABEL[r] ?? r).join(', ')}
                          {typeof p.matchOf === 'number' ? ` (row ${p.matchOf})` : ''}
                        </span>
                      )}
                      {c.issues.length > 0 && <span className="muted"> · {c.issues.map((i) => ISSUE_LABEL[i] ?? i).join(', ')}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
