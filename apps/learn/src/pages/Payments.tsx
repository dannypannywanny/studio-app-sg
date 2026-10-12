import { CaretRight } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { formatMoney, isOverdue } from '@lessonkaki/shared';
import { dayLabel } from '../format';
import { useInvoices, useSchool, type WithId } from '../hooks';
import type { Invoice } from '../types';

export function invoiceStatus(inv: Invoice): { text: string; tone: 'ok' | 'warn' | 'muted' | 'due' } {
  if (inv.status === 'void') return { text: 'Cancelled', tone: 'muted' };
  if (inv.status === 'paid') return { text: 'Paid', tone: 'ok' };
  if (isOverdue(inv)) return { text: 'Overdue', tone: 'warn' };
  if (inv.status === 'partial') return { text: 'Part paid', tone: 'due' };
  return { text: 'To pay', tone: 'due' };
}

export function Payments() {
  const school = useSchool();
  const invoices = useInvoices();
  const tz = school.timeZone;
  const shown: WithId<Invoice>[] = invoices.data.filter((i) => i.status !== 'draft');
  const unpaid = shown.filter((i) => i.status === 'sent' || i.status === 'partial');
  const unpaidCents = unpaid.reduce((n, i) => n + i.pendingCents, 0);

  return (
    <div className="stack-lg">
      <header className="page-head">
        <h1>Payments</h1>
        {!invoices.loading && (
          <p className="lede">
            {unpaidCents > 0
              ? `${formatMoney(unpaidCents, school.currency)} to pay across ${unpaid.length} ${unpaid.length === 1 ? 'invoice' : 'invoices'}.`
              : 'You are all paid up.'}
          </p>
        )}
      </header>

      {invoices.loading ? (
        <div aria-busy="true">
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
        </div>
      ) : invoices.error ? (
        <div className="notice notice-warn" role="alert">
          We couldn't load your invoices. Refresh the page to try again.
        </div>
      ) : shown.length === 0 ? (
        <article className="empty">
          <h2>No invoices yet</h2>
          <p>When the studio bills you for a package, it shows up here with a PayNow QR code.</p>
        </article>
      ) : (
        <ul className="rows invoices">
          {shown.map((inv) => {
            const status = invoiceStatus(inv);
            return (
              <li key={inv.id}>
                <Link to={`/payments/${inv.id}`} className="inv">
                  <span className="inv-main">
                    <span className="inv-no">{inv.number}</span>
                    <span className="inv-date">Issued {dayLabel(inv.issueDate.toDate(), tz)}</span>
                  </span>
                  <span className="inv-side">
                    <span className="inv-amount">{formatMoney(inv.status === 'paid' || inv.status === 'void' ? inv.totalCents : inv.pendingCents, inv.currency)}</span>
                    <span className={`tag tag-${status.tone}`}>{status.text}</span>
                  </span>
                  <CaretRight size={18} weight="bold" className="inv-caret" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
