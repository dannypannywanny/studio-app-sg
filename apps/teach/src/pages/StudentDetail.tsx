import { collection, query, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLessonHref } from '../components/LessonSheet';
import { formatDate, formatMoney, type LedgerType } from '@lessonkaki/shared';
import { PortalAccess } from '../components/PortalAccess';
import { call, db } from '../firebase';
import { studentName, useDoc, useFormatTs, useQuery, useTimeZone } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Enrolment, Invoice, LedgerEntry, Package, Student } from '../types';

const LEDGER_LABEL: Record<LedgerType, string> = {
  grant: 'Package sold',
  debit: 'Lesson',
  restore: 'Credit returned',
  settle: 'Owed lesson paid',
  expire: 'Expired',
  adjust: 'Adjustment',
  migrate: 'Opening balance',
};

interface SellResult {
  invoiceNumber: string;
  settled: number;
  sessionsRemaining: number;
}

const sellPackage = call<
  { schoolId: string; studentId: string; packageId: string; idempotencyKey: string },
  SellResult
>('sellPackage');

function SellPackage({ studentId }: { studentId: string }) {
  const schoolId = useSchoolId();
  const packages = useQuery<Package>(`packages:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'packages'), where('active', '==', true)),
  );
  const [packageId, setPackageId] = useState('');
  // One key per sale: a double click or a retry after a network blip can't sell twice.
  const [idempotencyKey, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = packages.data.find((p) => p.id === packageId);

  async function sell() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await sellPackage({ schoolId, studentId, packageId: chosen.id, idempotencyKey });
      setMessage(
        `Invoice ${res.invoiceNumber} created. ${chosen.sessions} sessions added` +
          (res.settled ? `, ${res.settled} owed lesson${res.settled > 1 ? 's' : ''} paid off.` : '.'),
      );
      setPackageId('');
      setKey(crypto.randomUUID());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Sell package</h2>
      <div className="row">
        <select value={packageId} onChange={(e) => setPackageId(e.target.value)} aria-label="Package">
          <option value="">Choose a package…</option>
          {packages.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.sessions} sessions · {formatMoney(p.priceCents)}
              {p.validityDays ? ` · ${p.validityDays} days` : ''}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={!chosen || busy} onClick={sell}>
          {busy ? 'Selling…' : chosen ? `Sell for ${formatMoney(chosen.priceCents)}` : 'Sell package'}
        </button>
      </div>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const adjustCredits = call<
  { schoolId: string; studentId: string; delta: number; reason: string; enrolmentId: string | null; idempotencyKey: string },
  { delta: number; settled: number }
>('adjustCredits');

/** Owner/admin: add or take away sessions by hand, with a reason (it goes in the ledger). */
function AdjustCredits({ studentId, lots }: { studentId: string; lots: (Enrolment & { id: string })[] }) {
  const schoolId = useSchoolId();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState(1);
  const [reason, setReason] = useState('');
  const [enrolmentId, setEnrolmentId] = useState('');
  const [idempotencyKey, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usable = lots.filter((l) => l.status === 'active' || l.status === 'completed');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await adjustCredits({ schoolId, studentId, delta, reason: reason.trim(), enrolmentId: enrolmentId || null, idempotencyKey });
      setMessage(
        `${res.delta > 0 ? 'Added' : 'Took away'} ${Math.abs(res.delta)} session${Math.abs(res.delta) === 1 ? '' : 's'}` +
          (res.settled ? `; ${res.settled} owed lesson${res.settled === 1 ? '' : 's'} paid off.` : '.'),
      );
      setReason('');
      setKey(crypto.randomUUID());
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="row">
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          Adjust credits…
        </button>
        {message && <p className="success">{message}</p>}
      </div>
    );
  }
  return (
    <div className="card form-grid">
      <label className="field">
        <span>Sessions (+ to add, − to take away)</span>
        <input type="number" min={-100} max={100} step={1} value={delta} onChange={(e) => setDelta(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Package</span>
        <select value={enrolmentId} onChange={(e) => setEnrolmentId(e.target.value)}>
          <option value="">{delta > 0 ? 'New manual credit' : 'Earliest-expiring first'}</option>
          {usable.map((l) => (
            <option key={l.id} value={l.id}>
              {l.packageName} ({l.sessionsRemaining} left)
            </option>
          ))}
        </select>
      </label>
      <label className="field span-all">
        <span>Reason (kept in the ledger)</span>
        <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy || !delta || reason.trim().length < 3} onClick={save}>
          {busy ? 'Saving…' : 'Save adjustment'}
        </button>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

export function StudentDetail() {
  const { studentId = '' } = useParams();
  const schoolId = useSchoolId();
  const { role } = useSession();
  const tz = useTimeZone();
  const fmt = useFormatTs();
  const lessonHref = useLessonHref();
  const student = useDoc<Student>(`schools/${schoolId}/students/${studentId}`);
  const byStudent = (name: string) => () =>
    query(collection(db, 'schools', schoolId, name), where('studentId', '==', studentId));
  const lots = useQuery<Enrolment>(`enrolments:${studentId}`, byStudent('enrolments'));
  const ledger = useQuery<LedgerEntry>(`ledger:${studentId}`, byStudent('ledger'));
  const invoices = useQuery<Invoice>(`invoices:${studentId}`, byStudent('invoices'));

  const lotName = useMemo(() => new Map(lots.data.map((l) => [l.id, l.packageName])), [lots.data]);
  const sortedLots = [...lots.data].sort((a, b) => b.validFrom.toMillis() - a.validFrom.toMillis());
  // Newest first; the server timestamp is briefly null on a just-written entry, so treat that as newest.
  const sortedLedger = [...ledger.data].sort(
    (a, b) => (b.createdAt?.toMillis() ?? Infinity) - (a.createdAt?.toMillis() ?? Infinity),
  );
  const sortedInvoices = [...invoices.data].sort((a, b) => b.issueDate.toMillis() - a.issueDate.toMillis());

  if (student.loading) return <p className="muted">Loading…</p>;
  if (!student.data) return <p className="empty">Student not found.</p>;
  const s = student.data;

  return (
    <section className="stack">
      <p>
        <Link to="/students">← Students</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{studentName(s)}</h1>
          <p className="muted">{[s.email, s.phone].filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Credits available</span>
          <span className="tile-value" data-testid="credits">
            {s.summary?.sessionsAvailable ?? 0}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Lessons owed</span>
          <span className={`tile-value ${s.summary?.sessionsOwed ? 'warn' : ''}`}>{s.summary?.sessionsOwed ?? 0}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Outstanding</span>
          <span className={`tile-value ${s.summary?.outstandingCents ? 'warn' : ''}`}>
            {formatMoney(s.summary?.outstandingCents ?? 0)}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Money credit</span>
          <span className="tile-value">{formatMoney(s.summary?.moneyCreditCents ?? 0)}</span>
        </div>
      </div>

      <PortalAccess studentId={studentId} hasLogin={Boolean((s as { uid?: string }).uid)} hasEmail={Boolean(s.email)} />

      <SellPackage studentId={studentId} />

      <div className="card stack">
        <div className="page-head">
          <h2>Packages</h2>
          {(role === 'owner' || role === 'admin') && <AdjustCredits studentId={studentId} lots={lots.data} />}
        </div>
        {sortedLots.length === 0 ? (
          <p className="empty">No packages yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Package</th>
                <th className="num">Left</th>
                <th className="num">Used</th>
                <th>Bought</th>
                <th>Valid until</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedLots.map((l) => (
                <tr key={l.id}>
                  <td>{l.packageName}</td>
                  <td className="num">
                    {l.sessionsRemaining} / {l.sessionsTotal}
                  </td>
                  <td className="num">{l.sessionsUsed}</td>
                  <td>{formatDate(l.validFrom.toDate(), tz)}</td>
                  <td>{l.validUntil.toDate().getUTCFullYear() >= 9999 ? 'No expiry' : formatDate(l.validUntil.toDate(), tz)}</td>
                  <td>
                    <span className={`badge badge-${l.status}`}>{l.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card stack">
        <h2>Credit ledger</h2>
        {sortedLedger.length === 0 ? (
          <p className="empty">No credit activity yet.</p>
        ) : (
          <table className="table" data-testid="ledger">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th className="num">Change</th>
                <th>Package</th>
                <th>Lesson</th>
              </tr>
            </thead>
            <tbody>
              {sortedLedger.map((e) => (
                <tr key={e.id}>
                  <td>{fmt(e.createdAt)}</td>
                  <td>
                    {LEDGER_LABEL[e.type]}
                    {e.type === 'debit' && !e.enrolmentId && <span className="badge badge-warn">owed</span>}
                  </td>
                  <td className={`num ${e.delta < 0 ? 'neg' : 'pos'}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</td>
                  <td>{e.enrolmentId ? (lotName.get(e.enrolmentId) ?? '—') : '—'}</td>
                  <td>{e.lessonId ? <Link to={lessonHref(e.lessonId)}>View</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card stack">
        <h2>Invoices</h2>
        {sortedInvoices.length === 0 ? (
          <p className="empty">No invoices yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Items</th>
                <th className="num">Total</th>
                <th className="num">Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedInvoices.map((inv) => (
                <tr key={inv.id}>
                  <td>
                    <Link to={`/invoices/${inv.id}`}>{inv.number}</Link>
                  </td>
                  <td>{formatDate(inv.issueDate.toDate(), tz)}</td>
                  <td>{formatDate(inv.dueDate.toDate(), tz)}</td>
                  <td>{inv.lines.map((l) => l.desc).join(', ')}</td>
                  <td className="num">{formatMoney(inv.totalCents, inv.currency)}</td>
                  <td className="num">{formatMoney(inv.pendingCents, inv.currency)}</td>
                  <td>
                    <span className={`badge badge-${inv.status}`}>{inv.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
