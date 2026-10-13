// S09 Invoice detail + S10 record-payment modal.
import { collection, query, where } from 'firebase/firestore';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { centsToDecimal, formatDate, formatMoney, parseMoney, wallClockToUtc, wallDateOf } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { studentName, useDoc, useQuery, useStudents, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Enrolment, Invoice, Payment, PaymentMethod } from '../types';
import { invoiceBadge } from './Invoices';

const editInvoice = call<
  {
    schoolId: string;
    invoiceId: string;
    number?: string;
    dueDate?: string;
    discount?: { kind: 'percent' | 'amount'; value: number } | null;
    validUntil?: string | null;
    note?: string | null;
  },
  { changed: string[] }
>('editInvoice');

/** Edit what Classcard let you change on an invoice: number, due date, discount, package expiry, notes. */
function EditInvoice({ inv, onDone }: { inv: Invoice & { id: string }; onDone: (msg: string | null) => void }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const lots = useQuery<Enrolment>(`invoiceLots:${inv.id}`, () =>
    query(collection(db, 'schools', schoolId, 'enrolments'), where('invoiceId', '==', inv.id)),
  );
  const lot = lots.data.find((l) => l.status === 'active') ?? lots.data[0];
  const lotNever = lot ? lot.validUntil.toDate().getUTCFullYear() >= 2900 : false;
  const lotDate = lot && !lotNever ? wallDateOf(lot.validUntil.toDate(), tz) : '';
  const subtotal = inv.subtotalCents ?? inv.totalCents;

  const [number, setNumber] = useState(inv.number);
  const [due, setDue] = useState(wallDateOf(inv.dueDate.toDate(), tz));
  const [kind, setKind] = useState<'percent' | 'amount'>('amount');
  const [discount, setDiscount] = useState(inv.discountCents ? centsToDecimal(inv.discountCents) : '');
  const [expiry, setExpiry] = useState<string | null>(null);
  const [never, setNever] = useState<boolean | null>(null);
  const [note, setNote] = useState(inv.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(discount) || 0;
  const discountCents = Math.min(subtotal, Math.max(0, kind === 'percent' ? Math.round((subtotal * Math.min(value, 100)) / 100) : Math.round(value * 100)));
  const expiryValue = expiry ?? lotDate;
  const neverValue = never ?? lotNever;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const changes: Parameters<typeof editInvoice>[0] = { schoolId, invoiceId: inv.id };
    if (number.trim() !== inv.number) changes.number = number.trim();
    if (due !== wallDateOf(inv.dueDate.toDate(), tz)) changes.dueDate = due;
    if (discountCents !== (inv.discountCents ?? 0)) changes.discount = discountCents ? { kind: 'amount', value: discountCents } : null;
    if (lot && (neverValue !== lotNever || (!neverValue && expiryValue !== lotDate))) changes.validUntil = neverValue ? null : expiryValue;
    if ((note.trim() || null) !== (inv.note ?? null)) changes.note = note.trim() || null;
    try {
      const res = await editInvoice(changes);
      onDone(res.changed.length ? 'Invoice updated.' : null);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={save}>
      <h2 className="span-all">Edit invoice</h2>
      <label className="field">
        <span>Invoice no.</span>
        <input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={40} required />
      </label>
      <label className="field">
        <span>Due date</span>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
      </label>
      <div className="field">
        <span>Discount (subtotal {formatMoney(subtotal, inv.currency)})</span>
        <div className="row discount-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'percent' | 'amount')} aria-label="Discount type">
            <option value="amount">Amount</option>
            <option value="percent">%</option>
          </select>
          <input type="number" min={0} step={kind === 'percent' ? 1 : 0.01} value={discount} onChange={(e) => setDiscount(e.target.value)} aria-label="Discount" placeholder="0" />
        </div>
        <span className="field-help">
          New total {formatMoney(subtotal - discountCents - (inv.moneyCreditAppliedCents ?? 0), inv.currency)}
        </span>
      </div>
      {lot && (
        <>
          <label className="field">
            <span>Package expiry ({lot.packageName})</span>
            <input type="date" value={neverValue ? '' : expiryValue} disabled={neverValue} onChange={(e) => setExpiry(e.target.value)} />
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={neverValue} onChange={(e) => setNever(e.target.checked)} />
            <span>No expiry</span>
          </label>
        </>
      )}
      <label className="field span-all">
        <span>Notes (staff only, not on the PDF)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

interface RecordPaymentResult {
  invoiceStatus: string;
  appliedCents: number;
  overpaymentCents: number;
  pendingCents: number;
}

const recordPayment = call<
  {
    schoolId: string;
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
    paidAt: string;
    reference: string | null;
    idempotencyKey: string;
  },
  RecordPaymentResult
>('recordPayment');

const voidInvoice = call<
  { schoolId: string; invoiceId: string; reason: string; keepCredits: boolean },
  { status: string; creditsRemoved: number }
>('voidInvoice');

const getInvoicePdfUrl = call<{ schoolId: string; invoiceId: string }, { url: string; expiresAt: string }>(
  'getInvoicePdfUrl',
);

/** The PayNow QR for what's outstanding, drawn from the payload the PDF function saved on the invoice. */
function PayNowPanel({ invoice }: { invoice: Invoice }) {
  const [svg, setSvg] = useState<string | null>(null);
  const payload = invoice.paynow?.payload;
  useEffect(() => {
    if (!payload) return setSvg(null);
    let live = true;
    QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }).then((s) => live && setSvg(s));
    return () => {
      live = false;
    };
  }, [payload]);
  if (!invoice.paynow || !svg) return null;
  return (
    <div className="card paynow">
      <div className="paynow-qr" role="img" aria-label="PayNow QR code" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="stack">
        <h2>Pay by PayNow</h2>
        <p className="muted">Scan with a banking app. Amount and reference fill in automatically.</p>
        <p>
          Amount <strong>{formatMoney(invoice.paynow.amountCents, invoice.currency)}</strong> · Reference{' '}
          <strong>{invoice.paynow.reference}</strong>
        </p>
      </div>
    </div>
  );
}

function PdfButton({ invoiceId, number }: { invoiceId: string; number: string }) {
  const schoolId = useSchoolId();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await getInvoicePdfUrl({ schoolId, invoiceId });
      setLink(url);
      // Signed links expire after 15 minutes; ask for a fresh one after that.
      window.setTimeout(() => setLink(null), 14 * 60_000);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {link ? (
        <a className="btn" href={link} target="_blank" rel="noopener" download={`${number}.pdf`}>
          Open {number}.pdf
        </a>
      ) : (
        <button className="btn" disabled={busy} onClick={prepare}>
          {busy ? 'Preparing PDF…' : 'Download PDF'}
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </>
  );
}

export const METHOD_LABEL: Record<Payment['method'], string> = {
  paynow: 'PayNow',
  bank: 'Bank transfer',
  cash: 'Cash',
  card_hitpay: 'Card (HitPay)',
};

function RecordPaymentModal({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice & { id: string };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const [method, setMethod] = useState<PaymentMethod>('paynow');
  const [amount, setAmount] = useState(centsToDecimal(invoice.pendingCents));
  const [date, setDate] = useState(wallDateOf(new Date(), tz));
  const [reference, setReference] = useState('');
  // One key per opening of the modal: a double click or retry can't record the payment twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);

  const cents = parseMoney(amount);
  const over = cents !== null ? Math.max(0, cents - invoice.pendingCents) : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cents) return setError('Enter an amount like 120 or 120.50.');
    setBusy(true);
    setError(null);
    try {
      // Midday on the chosen date, so the payment lands on that day in the school's zone.
      const paidAt = wallClockToUtc(date, '12:00', tz).toISOString();
      const res = await recordPayment({
        schoolId,
        invoiceId: invoice.id,
        amountCents: cents,
        method,
        paidAt,
        reference: reference.trim() || null,
        idempotencyKey,
      });
      onDone(
        `${formatMoney(res.appliedCents)} recorded.` +
          (res.pendingCents ? ` ${formatMoney(res.pendingCents)} still to pay.` : ' Paid in full.') +
          (res.overpaymentCents ? ` ${formatMoney(res.overpaymentCents)} kept as credit for the next invoice.` : ''),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal card stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-payment-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 id="record-payment-title">Record payment · {invoice.number}</h2>
        <p className="muted">Outstanding: {formatMoney(invoice.pendingCents, invoice.currency)}</p>
        <label className="field">
          <span>Method</span>
          <select ref={first} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            <option value="paynow">PayNow</option>
            <option value="bank">Bank transfer</option>
            <option value="cash">Cash</option>
          </select>
        </label>
        <label className="field">
          <span>Amount (SGD)</span>
          <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        {over > 0 && (
          <p className="muted">
            That's {formatMoney(over)} more than is owed. The extra is kept as credit for the student's next invoice.
          </p>
        )}
        <label className="field">
          <span>Date received</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Reference (optional)</span>
          <input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Bank or PayNow reference" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn btn-primary" disabled={busy || !cents}>
            {busy ? 'Saving…' : cents ? `Record ${formatMoney(cents)}` : 'Record payment'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function VoidPanel({ invoice, onDone }: { invoice: Invoice & { id: string }; onDone: (msg: string) => void }) {
  const schoolId = useSchoolId();
  const [reason, setReason] = useState('');
  const [keepCredits, setKeepCredits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await voidInvoice({ schoolId, invoiceId: invoice.id, reason: reason.trim(), keepCredits });
      onDone(`Invoice voided.${res.creditsRemoved ? ` ${res.creditsRemoved} unused credits taken back.` : ''}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Void this invoice?</h2>
      <p className="muted">
        The amount stops counting as owed. Unused credits from a package on it are taken back unless you keep them.
      </p>
      <label className="field">
        <span>Reason</span>
        <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={keepCredits} onChange={(e) => setKeepCredits(e.target.checked)} />
        <span>Let the student keep the credits</span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || reason.trim().length < 3} onClick={submit}>
          {busy ? 'Voiding…' : 'Void invoice'}
        </button>
      </div>
    </div>
  );
}

export function InvoiceDetail() {
  const { invoiceId = '' } = useParams();
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const students = useStudents();
  const invoice = useDoc<Invoice>(`schools/${schoolId}/invoices/${invoiceId}`);
  const payments = useQuery<Payment>(`payments:${invoiceId}`, () =>
    query(collection(db, 'schools', schoolId, 'payments'), where('invoiceId', '==', invoiceId)),
  );
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (invoice.loading) return <p className="muted">Loading…</p>;
  if (!invoice.data) return <p className="empty">Invoice not found.</p>;
  const inv = invoice.data;
  const badge = invoiceBadge(inv);
  const open = inv.status === 'sent' || inv.status === 'partial';
  const sortedPayments = [...payments.data].sort((a, b) => a.paidAt.toMillis() - b.paidAt.toMillis());

  return (
    <section className="stack">
      <p>
        <Link to="/invoices">← Invoices</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>
            {inv.number} <span className={`badge ${badge.className}`}>{badge.label}</span>
          </h1>
          <p className="muted">
            <Link to={`/students/${inv.studentId}`}>{studentName(students.byId.get(inv.studentId))}</Link> · issued{' '}
            {formatDate(inv.issueDate.toDate(), tz)} · due {formatDate(inv.dueDate.toDate(), tz)}
            {inv.status === 'void' && inv.voidReason ? ` · void: ${inv.voidReason}` : ''}
          </p>
        </div>
        <div className="row">
          <PdfButton invoiceId={inv.id} number={inv.number} />
          {inv.status !== 'void' && !editing && (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {open && (
            <button className="btn btn-primary" onClick={() => setPaying(true)}>
              Record payment
            </button>
          )}
          {open && inv.paidCents === 0 && !voiding && (
            <button className="btn" onClick={() => setVoiding(true)}>
              Void
            </button>
          )}
        </div>
      </div>
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      {editing && (
        <EditInvoice
          inv={inv}
          onDone={(msg) => {
            setEditing(false);
            if (msg) setNotice(msg);
          }}
        />
      )}
      {!editing && (
        <div className="card stack invoice-notes">
          <div className="row">
            <h2>Notes</h2>
            {inv.status !== 'void' && (
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
                {inv.note ? 'Edit' : 'Add a note'}
              </button>
            )}
          </div>
          {inv.note ? <p className="staff-note">{inv.note}</p> : <p className="muted">No notes. Notes stay in LessonKaki and are not printed on the PDF.</p>}
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <span className="tile-label">Total</span>
          <span className="tile-value">{formatMoney(inv.totalCents, inv.currency)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Paid</span>
          <span className="tile-value">{formatMoney(inv.paidCents, inv.currency)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Outstanding</span>
          <span className={`tile-value ${inv.pendingCents ? 'warn' : ''}`} data-testid="outstanding">
            {formatMoney(inv.pendingCents, inv.currency)}
          </span>
        </div>
      </div>

      {open && <PayNowPanel invoice={inv} />}

      <div className="card stack">
        <h2>Items</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Unit price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.desc}</td>
                <td className="num">{l.qty}</td>
                <td className="num">{formatMoney(l.unitCents, inv.currency)}</td>
                <td className="num">{formatMoney(l.qty * l.unitCents, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card stack">
        <h2>Payments</h2>
        {sortedPayments.length === 0 ? (
          <p className="empty">No payments yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th>Reference</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {sortedPayments.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.paidAt.toDate(), tz)}</td>
                  <td>{METHOD_LABEL[p.method]}</td>
                  <td>{p.reference ?? '—'}</td>
                  <td className="num">
                    {formatMoney(p.amountCents, inv.currency)}
                    {p.overpaymentCents > 0 && <span className="muted"> ({formatMoney(p.overpaymentCents)} to credit)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {voiding && open && (
        <VoidPanel
          invoice={inv}
          onDone={(msg) => {
            setVoiding(false);
            setNotice(msg);
          }}
        />
      )}
      {paying && (
        <RecordPaymentModal
          invoice={inv}
          onClose={() => setPaying(false)}
          onDone={(msg) => {
            setPaying(false);
            setNotice(msg);
          }}
        />
      )}
    </section>
  );
}
