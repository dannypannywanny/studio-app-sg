// S09 Invoice detail + S10 record-payment modal.
import { collection, query, where } from 'firebase/firestore';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { centsToDecimal, formatDate, formatMoney, parseMoney, wallClockToUtc, wallDateOf } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { studentName, useDoc, useQuery, useStudents, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Invoice, Payment, PaymentMethod } from '../types';
import { invoiceBadge } from './Invoices';

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
        {open && (
          <div className="row">
            <button className="btn btn-primary" onClick={() => setPaying(true)}>
              Record payment
            </button>
            {inv.paidCents === 0 && !voiding && (
              <button className="btn" onClick={() => setVoiding(true)}>
                Void
              </button>
            )}
          </div>
        )}
      </div>
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
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
