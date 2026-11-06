// /buy/:packageId, linked from the school's pricing page. Signed-out visitors are sent to sign up
// (or sign in) first and come back here; then one tap opens HitPay for this package.
import { ArrowRight, Check } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatMoney } from '@lessonkaki/shared';
import { call, errorMessage } from '../firebase';
import { useDoc } from '../hooks';
import { useStudentIds } from '../session';

const startCheckout = call<{ schoolId: string; packageId: string; code?: string | null }, { checkoutId: string; url: string }>('startCheckout');
const previewDiscountCode = call<
  { schoolId: string; packageId: string; code: string },
  { code: string; discountCents: number; totalCents: number }
>('previewDiscountCode');

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
  const [codeText, setCodeText] = useState('');
  const [applied, setApplied] = useState<{ code: string; discountCents: number; totalCents: number } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

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

  async function applyCode() {
    setCodeError(null);
    setApplied(null);
    if (!codeText.trim()) return;
    setBusy(true);
    try {
      setApplied(await previewDiscountCode({ schoolId, packageId, code: codeText }));
    } catch (err) {
      setCodeError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startCheckout({ schoolId, packageId, code: applied?.code ?? null });
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
            Pay online with HitPay: card, PayNow, GrabPay, ShopeePay and more
          </li>
        </ul>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void applyCode();
          }}
        >
          <label className="field">
            <span>Discount code</span>
            <input
              value={codeText}
              onChange={(e) => {
                setCodeText(e.target.value);
                setApplied(null);
                setCodeError(null);
              }}
              maxLength={40}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn btn-ghost" disabled={busy || !codeText.trim()}>
            Apply code
          </button>
          {codeError && <p className="form-error" role="alert">{codeError}</p>}
          {applied && (
            <p role="status">
              {applied.code} applied: {formatMoney(applied.discountCents)} off.
            </p>
          )}
        </form>
        <button className="btn btn-block" onClick={pay} disabled={busy}>
          {busy ? 'Opening payment' : `Pay ${formatMoney(applied ? applied.totalCents : p.priceCents)}`}
          {!busy && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </article>
    </div>
  );
}
