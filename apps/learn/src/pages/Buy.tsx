// /buy/:packageId, linked from the school's pricing page. Signed-out visitors are sent to sign up
// (or sign in) first and come back here; then one tap opens HitPay for this package.
import { ArrowRight, Check } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatMoney } from '@lessonkaki/shared';
import { call, errorMessage } from '../firebase';
import { useDoc } from '../hooks';
import { useStudentIds } from '../session';

const startCheckout = call<{ schoolId: string; packageId: string }, { checkoutId: string; url: string }>('startCheckout');

interface Pkg {
  name: string;
  sessions: number;
  priceCents: number;
  validityDays: number | null;
  sellsOnline?: boolean;
  active?: boolean;
}

export function Buy() {
  const { packageId = '' } = useParams();
  const { schoolId } = useStudentIds();
  const pkg = useDoc<Pkg>(/^[A-Za-z0-9_-]+$/.test(packageId) ? `schools/${schoolId}/packages/${packageId}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pkg.loading) return <div className="skeleton skeleton-hero" aria-busy="true" />;
  const p = pkg.data;
  if (!p || p.active === false || !p.sellsOnline) {
    return (
      <article className="empty">
        <h2>That package isn't sold online</h2>
        <p>See what you can book or buy on the booking page.</p>
        <Link className="btn" to="/book">
          Go to booking
        </Link>
      </article>
    );
  }

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startCheckout({ schoolId, packageId });
      window.location.assign(url); // HitPay; it returns to /book?checkout=...
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const perLesson = p.sessions > 1 ? Math.round(p.priceCents / p.sessions) : null;
  return (
    <div className="stack-lg">
      <header className="page-head">
        <h1>{p.name}</h1>
        <p className="lede">After paying you pick your lesson times straight away.</p>
      </header>
      <article className="buy-card">
        <p className="buy-price">{formatMoney(p.priceCents)}</p>
        <ul className="buy-points">
          <li>
            <Check size={18} weight="bold" aria-hidden="true" />
            {p.sessions} {p.sessions === 1 ? 'lesson' : 'lessons'}, 45 minutes each{perLesson ? ` (${formatMoney(perLesson)} a lesson)` : ''}
          </li>
          {p.validityDays && (
            <li>
              <Check size={18} weight="bold" aria-hidden="true" />
              Use within {p.validityDays} days
            </li>
          )}
          <li>
            <Check size={18} weight="bold" aria-hidden="true" />
            Pay by card or PayNow on HitPay
          </li>
        </ul>
        <button className="btn btn-block" onClick={pay} disabled={busy}>
          {busy ? 'Opening payment' : `Pay ${formatMoney(p.priceCents)}`}
          {!busy && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </article>
    </div>
  );
}
