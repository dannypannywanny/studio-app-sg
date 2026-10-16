// Booking, step 2: which package pays for the lesson. Students with a free session go straight on;
// otherwise they buy a package with HitPay (card or PayNow) and come back here when it's paid.
import { ArrowRight, CheckCircle } from '@phosphor-icons/react';
import { collection, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { formatMoney } from '@lessonkaki/shared';
import { call, db, errorMessage } from '../firebase';
import { dayLabel } from '../format';
import { useDoc, useEnrolments, useQuery } from '../hooks';
import type { AvailabilityResult, Profile } from '../types';

const startCheckout = call<{ schoolId: string; packageId: string }, { checkoutId: string; url: string }>('startCheckout');

interface Pkg {
  name: string;
  subjectId: string;
  sessions: number;
  priceCents: number;
  validityDays: number | null;
}

interface Checkout {
  status: 'pending' | 'paid' | 'mismatch' | 'failed';
  packageName: string;
}

/** Back from HitPay: wait for the webhook to mark the checkout paid. */
function ReturnFromPayment({ schoolId, checkoutId, onDone }: { schoolId: string; checkoutId: string; onDone: () => void }) {
  const [params, setParams] = useSearchParams();
  const checkout = useDoc<Checkout>(`schools/${schoolId}/checkouts/${checkoutId}`);
  const [slow, setSlow] = useState(false);
  const hitpayStatus = params.get('status');
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 45_000);
    return () => clearTimeout(t);
  }, []);
  const clear = () => {
    params.delete('checkout');
    params.delete('status');
    params.delete('reference');
    setParams(params, { replace: true });
  };

  if (checkout.data?.status === 'paid') {
    return (
      <article className="paid-note">
        <CheckCircle size={36} weight="fill" aria-hidden="true" className="done-mark" />
        <h2>Payment received</h2>
        <p>{checkout.data.packageName} is on your account. Now pick a time.</p>
        <button
          className="btn"
          onClick={() => {
            clear();
            onDone();
          }}
        >
          Choose a time
          <ArrowRight size={18} weight="bold" aria-hidden="true" />
        </button>
      </article>
    );
  }
  if (hitpayStatus && hitpayStatus !== 'completed') {
    return (
      <div className="notice notice-warn" role="alert">
        <p>The payment wasn't completed, so nothing was charged.</p>
        <button className="btn btn-sm btn-quiet" onClick={clear}>
          Back to packages
        </button>
      </div>
    );
  }
  return (
    <article className="paid-note" aria-busy="true">
      <h2>Confirming your payment</h2>
      <p>
        {slow
          ? "This is taking longer than usual. Your package is added as soon as HitPay confirms; you can leave this page and come back."
          : 'This usually takes a few seconds.'}
      </p>
      <div className="skeleton-line" />
    </article>
  );
}

export function PackageStep({
  schoolId,
  teacher,
  credit,
  profile,
  onContinue,
}: {
  schoolId: string;
  teacher: AvailabilityResult['teachers'][number];
  credit: NonNullable<AvailabilityResult['credit']>;
  profile: Profile | null;
  onContinue: () => void;
}) {
  const [params] = useSearchParams();
  const checkoutId = params.get('checkout');
  const lots = useEnrolments();
  const packages = useQuery<Pkg>(`pkgs:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'packages'), where('sellsOnline', '==', true), where('active', '==', true)),
  );
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forSale = packages.data.filter((p) => !teacher.subjectId || p.subjectId === teacher.subjectId).sort((a, b) => a.priceCents - b.priceCents);
  const free = credit.sessionsAvailable - credit.upcomingLessons;

  if (checkoutId) return <ReturnFromPayment schoolId={schoolId} checkoutId={checkoutId} onDone={onContinue} />;

  async function buy(packageId: string) {
    setBuying(packageId);
    setError(null);
    try {
      const { url } = await startCheckout({ schoolId, packageId });
      window.location.assign(url); // HitPay's checkout; it sends them back to /book?checkout=...
    } catch (err) {
      setError(errorMessage(err));
      setBuying(null);
    }
  }

  const trial = profile?.whatsapp ? (
    <p className="meta">
      New and want a trial first? <a href={profile.whatsapp} target="_blank" rel="noreferrer">WhatsApp the studio</a>.
    </p>
  ) : null;

  return (
    <div className="stack-lg">
      {free >= 1 && (
        <article className="pkg-current">
          <p className="pkg-current-n">
            {free} {free === 1 ? 'session' : 'sessions'} ready to book
          </p>
          {lots.data.length > 0 && (
            <ul className="meta">
              {lots.data.map((l) => (
                <li key={l.id}>
                  {l.packageName}: {l.sessionsRemaining} left
                  {l.validUntil.toDate().getUTCFullYear() < 9999 && `, use by ${dayLabel(l.validUntil.toDate(), 'Asia/Singapore')}`}
                </li>
              ))}
            </ul>
          )}
          {credit.upcomingLessons > 0 && <p className="meta">Lessons you've already booked are counted.</p>}
          <button className="btn" onClick={onContinue}>
            Choose a time
            <ArrowRight size={18} weight="bold" aria-hidden="true" />
          </button>
        </article>
      )}

      <section className="section">
        <h2>{free >= 1 ? 'Or buy more' : credit.mustBuy ? 'Choose a package to book' : 'Buy a package'}</h2>
        {!credit.mustBuy && free < 1 && (
          <p className="meta">
            You have no sessions left. You can still book now and the studio will invoice you, or buy a package first.
          </p>
        )}
        {packages.loading ? (
          <div className="skeleton skeleton-row" />
        ) : forSale.length === 0 ? (
          <p className="meta">No packages are sold online right now. Please contact the studio.</p>
        ) : (
          <ul className="pkg-list">
            {forSale.map((p) => (
              <li key={p.id}>
                <div className="pkg-info">
                  <span className="pkg-title">{p.name}</span>
                  <span className="meta">
                    {p.sessions > 1 ? `${formatMoney(Math.round(p.priceCents / p.sessions))} a lesson` : '1 lesson'}
                    {p.validityDays ? `, use within ${p.validityDays} days` : ''}
                  </span>
                </div>
                <button className="btn btn-sm" onClick={() => buy(p.id)} disabled={buying !== null}>
                  {buying === p.id ? 'Opening' : `Pay ${formatMoney(p.priceCents)}`}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="meta">Pay online with HitPay (card, PayNow, GrabPay, ShopeePay and more). Your sessions are added as soon as the payment goes through.</p>
        {trial}
      </section>

      {!credit.mustBuy && free < 1 && (
        <button className="link-btn light" onClick={onContinue}>
          Book without paying now
        </button>
      )}
    </div>
  );
}
