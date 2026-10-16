import { ArrowLeft, DownloadSimple } from '@phosphor-icons/react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatMoney } from '@lessonkaki/shared';
import { call, errorMessage } from '../firebase';
import { dayLabel } from '../format';
import { useDoc, useSchool, type WithId } from '../hooks';
import { useStudentIds } from '../session';
import type { Invoice } from '../types';
import { invoiceStatus } from './Payments';

const getInvoicePdfUrl = call<{ schoolId: string; invoiceId: string }, { url: string; expiresAt: string }>('getInvoicePdfUrl');

/** PayNow QR for what's outstanding, from the payload the PDF function saved on the invoice. */
function PayNow({ invoice }: { invoice: WithId<Invoice> }) {
  const [svg, setSvg] = useState<string | null>(null);
  const payload = invoice.paynow?.payload;
  useEffect(() => {
    if (!payload) return;
    let live = true;
    QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#161616', light: '#ffffff' } }).then(
      (s) => live && setSvg(s),
    );
    return () => {
      live = false;
    };
  }, [payload]);
  if (!invoice.paynow || !svg) return null;
  return (
    <section className="paynow" aria-label="Pay with PayNow">
      <div className="paynow-qr" role="img" aria-label="PayNow QR code" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="paynow-text">
        <h2>Pay with PayNow</h2>
        <p>Scan with your banking app. The amount and reference are filled in for you.</p>
        <dl className="kv">
          <div>
            <dt>Amount</dt>
            <dd>{formatMoney(invoice.paynow.amountCents, invoice.currency)}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd>{invoice.paynow.reference}</dd>
          </div>
        </dl>
        <p className="meta">Payments show here once the studio records them, usually within a day.</p>
      </div>
    </section>
  );
}

export function InvoiceDetail() {
  const { invoiceId = '' } = useParams();
  const { schoolId } = useStudentIds();
  const school = useSchool();
  const invoice = useDoc<Invoice>(`schools/${schoolId}/invoices/${invoiceId}`);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function openPdf() {
    // Open the tab first (inside the tap) so phones don't block it as a pop-up.
    const tab = window.open('', '_blank');
    setPdfBusy(true);
    setPdfError(null);
    try {
      const { url } = await getInvoicePdfUrl({ schoolId, invoiceId });
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch (err) {
      tab?.close();
      setPdfError(errorMessage(err));
    } finally {
      setPdfBusy(false);
    }
  }

  const back = (
    <Link to="/payments" className="back">
      <ArrowLeft size={18} weight="bold" aria-hidden="true" />
      Payments
    </Link>
  );

  if (invoice.loading) return <div className="skeleton skeleton-hero" aria-busy="true" />;
  if (!invoice.data) {
    return (
      <div className="stack-lg">
        {back}
        <article className="empty">
          <h2>Invoice not found</h2>
          <p>It may have been replaced. Your current invoices are on the Payments page.</p>
        </article>
      </div>
    );
  }

  const inv = invoice.data;
  const status = invoiceStatus(inv);
  const tz = school.timeZone;
  const owing = (inv.status === 'sent' || inv.status === 'partial') && inv.pendingCents > 0;

  return (
    <div className="stack-lg">
      {back}
      <header className="page-head">
        <p className="inv-head">
          <span className={`tag tag-${status.tone}`}>{status.text}</span>
          <span className="meta">
            Issued {dayLabel(inv.issueDate.toDate(), tz)}
            {owing && <>, due {dayLabel(inv.dueDate.toDate(), tz)}</>}
          </span>
        </p>
        <h1>Invoice {inv.number}</h1>
      </header>

      {owing && <PayNow invoice={inv} />}

      <section className="section">
        <ul className="lines">
          {inv.lines.map((l, i) => (
            <li key={i}>
              <span>
                {l.desc}
                {l.qty > 1 && <span className="meta"> × {l.qty}</span>}
              </span>
              <span className="num">{formatMoney(l.qty * l.unitCents, inv.currency)}</span>
            </li>
          ))}
        </ul>
        <dl className="totals">
          {inv.discountCents > 0 && (
            <div>
              <dt>Discount</dt>
              <dd className="num">-{formatMoney(inv.discountCents, inv.currency)}</dd>
            </div>
          )}
          {inv.tax && !inv.tax.inclusive && (inv.taxCents ?? 0) > 0 && (
            <div>
              <dt>
                {inv.tax.label} {inv.tax.rate}%
              </dt>
              <dd className="num">{formatMoney(inv.taxCents ?? 0, inv.currency)}</dd>
            </div>
          )}
          {(inv.creditedCents ?? 0) > 0 && (
            <div>
              <dt>Credit note</dt>
              <dd className="num">-{formatMoney(inv.creditedCents ?? 0, inv.currency)}</dd>
            </div>
          )}
          <div>
            <dt>Total{inv.tax?.inclusive && (inv.taxCents ?? 0) > 0 ? ` (incl. ${inv.tax.label} ${formatMoney(inv.taxCents ?? 0, inv.currency)})` : ''}</dt>
            <dd className="num">{formatMoney(inv.totalCents, inv.currency)}</dd>
          </div>
          {inv.paidCents > 0 && (
            <div>
              <dt>Paid</dt>
              <dd className="num">{formatMoney(inv.paidCents, inv.currency)}</dd>
            </div>
          )}
          {owing && (
            <div className="totals-due">
              <dt>To pay</dt>
              <dd className="num">{formatMoney(inv.pendingCents, inv.currency)}</dd>
            </div>
          )}
        </dl>
      </section>

      <div>
        <button className="btn btn-quiet" onClick={openPdf} disabled={pdfBusy}>
          <DownloadSimple size={18} weight="bold" aria-hidden="true" />
          {pdfBusy ? 'Preparing PDF' : 'Download PDF'}
        </button>
        {pdfError && <p className="form-error" role="alert">{pdfError}</p>}
      </div>
    </div>
  );
}
