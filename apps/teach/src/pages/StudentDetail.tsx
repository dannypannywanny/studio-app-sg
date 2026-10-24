import { collection, doc, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLessonHref } from '../components/LessonSheet';
import { addDays, applyTax, formatDate, formatMoney, resolveTax, wallDateOf, type LedgerType } from '@lessonkaki/shared';
import { useSubjects } from '../components/LessonTypes';
import { CreditBoxes } from '../components/CreditBoxes';
import { LeadPanel } from '../components/LeadPanel';
import { PortalAccess } from '../components/PortalAccess';
import { call, db } from '../firebase';
import { studentName, useDoc, useFormatTs, useQuery, useSchool, useTeachers, useTimeZone } from '../hooks';
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
  {
    schoolId: string;
    studentId: string;
    packageId: string;
    idempotencyKey: string;
    validUntil: string | null;
    discount: { kind: 'percent' | 'amount'; value: number } | null;
    note: string | null;
  },
  SellResult
>('sellPackage');

/** "Voice lessons with Daniel · 12 lessons" (the server writes the same text on the invoice). */
function usePackageLabels() {
  const subjects = useSubjects();
  const teachers = useTeachers();
  return (p: Package) => {
    const count = `${p.sessions} ${p.sessions === 1 ? 'lesson' : 'lessons'}`;
    const s = subjects.data.find((x) => x.id === p.subjectId);
    if (!s) return `${p.name} · ${count}`;
    const names = (s.teacherIds ?? [])
      .map((id) => teachers.byId.get(id))
      .filter((t) => t && t.active !== false)
      .map((t) => t!.displayName.trim().split(/\s+/)[0]);
    return `${s.name}${names.length ? ` with ${names.join(' / ')}` : ''} · ${count}`;
  };
}

function SellPackage({ studentId }: { studentId: string }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const today = wallDateOf(new Date(), tz);
  const label = usePackageLabels();
  const packages = useQuery<Package>(`packages:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'packages'), where('active', '==', true)),
  );
  const [packageId, setPackageId] = useState('');
  // One key per sale: a double click or a retry after a network blip can't sell twice.
  const [idempotencyKey, setKey] = useState(() => crypto.randomUUID());
  const [expiry, setExpiry] = useState<string | null>(null); // null until picked = package default
  const [noExpiry, setNoExpiry] = useState(false);
  const [discountKind, setDiscountKind] = useState<'percent' | 'amount'>('percent');
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = packages.data.find((p) => p.id === packageId);
  const defaultExpiry = chosen?.validityDays ? addDays(today, chosen.validityDays) : null;
  const expiryDate = noExpiry ? null : (expiry ?? defaultExpiry);
  const amount = Number(discount) || 0;
  const discountCents = !chosen
    ? 0
    : Math.min(chosen.priceCents, Math.max(0, discountKind === 'percent' ? Math.round((chosen.priceCents * Math.min(amount, 100)) / 100) : Math.round(amount * 100)));
  const tax = resolveTax((useSchool().data as { tax?: unknown } | null)?.tax);
  const taxed = applyTax((chosen?.priceCents ?? 0) - discountCents, tax);
  const total = taxed.totalCents;

  function pick(id: string) {
    setPackageId(id);
    setExpiry(null);
    setNoExpiry(false);
  }

  async function sell() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await sellPackage({
        schoolId,
        studentId,
        packageId: chosen.id,
        idempotencyKey,
        validUntil: expiryDate,
        discount: discountCents ? { kind: discountKind, value: discountKind === 'percent' ? amount : Math.round(amount * 100) } : null,
        note: note.trim() || null,
      });
      setMessage(
        `Invoice ${res.invoiceNumber} created for ${formatMoney(total)}. ${chosen.sessions} ${chosen.sessions === 1 ? "lesson" : "lessons"} added` +
          (res.settled ? `, ${res.settled} owed lesson${res.settled > 1 ? 's' : ''} paid off.` : '.'),
      );
      setPackageId('');
      setDiscount('');
      setNote('');
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
      <div className="form-grid">
        <label className="field span-all">
          <span>Package</span>
          <select value={packageId} onChange={(e) => pick(e.target.value)}>
            <option value="">Choose a package…</option>
            {packages.data
              .map((p) => ({ p, text: label(p) }))
              .sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }))
              .map(({ p, text }) => (
                <option key={p.id} value={p.id}>
                  {text} · {formatMoney(p.priceCents)}
                  {p.validityDays ? ` · ${p.validityDays} days` : ''}
                </option>
              ))}
          </select>
        </label>
        {chosen && (
          <>
            <label className="field">
              <span>Expiry</span>
              <input
                type="date"
                min={today}
                value={expiryDate ?? ''}
                disabled={noExpiry}
                onChange={(e) => setExpiry(e.target.value || null)}
              />
            </label>
            <label className="field checkbox">
              <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
              <span>No expiry</span>
            </label>
            <div className="field">
              <span>Discount</span>
              <div className="row discount-row">
                <select value={discountKind} onChange={(e) => setDiscountKind(e.target.value as 'percent' | 'amount')} aria-label="Discount type">
                  <option value="percent">%</option>
                  <option value="amount">Amount</option>
                </select>
                <input
                  type="number"
                  min={0}
                  max={discountKind === 'percent' ? 100 : chosen.priceCents / 100}
                  step={discountKind === 'percent' ? 1 : 0.01}
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  placeholder="0"
                  aria-label="Discount"
                />
              </div>
            </div>
            <label className="field span-all">
              <span>Notes (staff only; kept on the invoice and the package)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
            </label>
            <p className="span-all sale-total">
              {discountCents || (tax.enabled && !tax.inclusive) ? (
                <span className="muted">
                  {formatMoney(chosen.priceCents)}
                  {discountCents ? ` − ${formatMoney(discountCents)}` : ''}
                  {tax.enabled && !tax.inclusive ? ` + ${tax.label} ${formatMoney(taxed.taxCents)}` : ''} ={' '}
                </span>
              ) : null}
              <strong>{formatMoney(total)}</strong>
              {tax.enabled && tax.inclusive && <span className="muted"> (incl. {tax.label} {formatMoney(taxed.taxCents)})</span>}
              <span className="muted"> · {expiryDate ? `expires ${formatDate(new Date(`${expiryDate}T12:00:00Z`), 'UTC')}` : 'no expiry'}</span>
            </p>
          </>
        )}
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!chosen || busy} onClick={sell}>
            {busy ? 'Selling…' : chosen ? `Sell for ${formatMoney(total)}` : 'Sell package'}
          </button>
          {message && <p className="success">{message}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function StudentNotes({ studentId, notes }: { studentId: string; notes: string }) {
  const schoolId = useSchoolId();
  const [text, setText] = useState(notes);
  const [state, setState] = useState<{ busy: boolean; saved: boolean; error: string | null }>({ busy: false, saved: false, error: null });
  const dirty = text !== notes;
  async function save() {
    setState({ busy: true, saved: false, error: null });
    try {
      await updateDoc(doc(db, 'schools', schoolId, 'students', studentId), { notes: text.trim(), updatedAt: serverTimestamp() });
      setState({ busy: false, saved: true, error: null });
    } catch (err) {
      setState({ busy: false, saved: false, error: (err as Error).message });
    }
  }
  return (
    <div className="card stack">
      <h2>Notes</h2>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setState({ busy: false, saved: false, error: null });
        }}
        rows={4}
        maxLength={5000}
        placeholder="Anything staff should know: goals, health, who pays, preferences…"
        aria-label="Student notes"
      />
      <div className="row">
        <button className="btn btn-sm btn-primary" disabled={!dirty || state.busy} onClick={() => void save()}>
          {state.busy ? 'Saving…' : 'Save notes'}
        </button>
        {state.saved && !dirty && <span className="success">Saved.</span>}
        {state.error && <span className="error">{state.error}</span>}
      </div>
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
      <p>{s.status === 'lead' ? <Link to="/leads">← Leads</Link> : <Link to="/students">← Students</Link>}</p>
      <div className="page-head">
        <div>
          <h1>
            {studentName(s)} {s.status === 'lead' && <span className="badge badge-lead">Lead</span>}
          </h1>
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

      {(s.status === 'lead' || s.lead) && <LeadPanel studentId={studentId} student={s} />}
      {s.status !== 'lead' && (
        <PortalAccess studentId={studentId} hasLogin={Boolean((s as { uid?: string }).uid)} hasEmail={Boolean(s.email)} />
      )}

      <StudentNotes key={s.notes ?? ''} studentId={studentId} notes={s.notes ?? ''} />
      <SellPackage studentId={studentId} />

      <div className="card stack">
        <div className="page-head">
          <h2>Packages</h2>
          {(role === 'owner' || role === 'admin') && <AdjustCredits studentId={studentId} lots={lots.data} />}
        </div>
        <CreditBoxes studentId={studentId} lots={lots.data} invoices={invoices.data} />
      </div>

      <details className="card stack ledger-details">
        <summary>
          <h2>Full credit history</h2>
          <span className="muted">Every credit change, newest first</span>
        </summary>
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
                    {e.type === 'expire' && e.delta > 0 ? 'Expiry extended' : LEDGER_LABEL[e.type]}
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
      </details>

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
