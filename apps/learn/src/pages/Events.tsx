// Public event pages (/events, /events/:eventId): anyone can buy tickets, signed in or not. The school
// comes from the site's hostname (publicSchools). Paying opens HitPay, which sends the buyer back here
// with ?order=…; the page then waits for the payment webhook to mark the order paid.
import { ArrowRight, CalendarBlank, CheckCircle, MapPin, Ticket } from '@phosphor-icons/react';
import { collection, query, where, type Timestamp } from 'firebase/firestore';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useParams, useSearchParams } from 'react-router';
import { DEFAULT_MAX_PER_ORDER, currentTier, formatMoney, laterPrice, seatsLeft, type EventPriceTier } from '@lessonkaki/shared';
import { call, db, errorMessage } from '../firebase';
import { longDayLabel, timeRange, zoneName } from '../format';
import { logoSrc, useDoc, useProfile, useQuery, useSiteSchoolId } from '../hooks';
import { DIAL_CODES } from './SignIn';

interface PublicEvent {
  title: string;
  tagline?: string;
  description?: string;
  startAt: Timestamp;
  endAt: Timestamp;
  timeZone: string;
  venue: string | null;
  capacity: number | null;
  maxPerOrder?: number;
  prices: EventPriceTier[];
  currency: string;
  published: boolean;
  status: 'scheduled' | 'cancelled';
  soldQty?: number;
}

interface CheckoutIn {
  eventId: string;
  qty: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  consent: true;
  marketing: boolean;
}
const startEventCheckout = call<CheckoutIn, { checkoutId: string; url: string }>('startEventCheckout');
const eventOrderStatus = call<{ eventId: string; orderId: string }, { status: string; qty: number; email: string | null }>('eventOrderStatus');

const ID = /^[A-Za-z0-9_-]+$/;

/** Signed-out frame: the school's logo and a way to the student portal, no tab bar. */
function PublicShell({ children }: { children: ReactNode }) {
  const site = useSiteSchoolId();
  const profile = useProfile(site.schoolId);
  const logo = logoSrc(profile.data);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <NavLink to="/events" className="brand" aria-label={`${profile.data?.name ?? 'Events'}: all events`}>
            {logo ? <img src={logo} alt="" height={38} /> : <span className="brand-name">{profile.data?.name}</span>}
          </NavLink>
          <Link className="btn btn-sm btn-quiet" to="/">
            Student login
          </Link>
        </div>
      </header>
      <main id="main" className="wrap page page-public">
        {children}
      </main>
    </div>
  );
}

function When({ e }: { e: PublicEvent }) {
  const start = e.startAt.toDate();
  return (
    <>
      {longDayLabel(start, e.timeZone)}, {timeRange(start, e.endAt.toDate(), e.timeZone)}
      {Intl.DateTimeFormat().resolvedOptions().timeZone !== e.timeZone && <span className="meta"> ({zoneName(e.timeZone)})</span>}
    </>
  );
}

/** "S$68, S$88 struck through, early bird until Saturday 14 November": the price on sale now. */
function Price({ e, now }: { e: PublicEvent; now: Date }) {
  const on = currentTier(e.prices, now, e.timeZone);
  if (!on) return null;
  const later = laterPrice(e.prices, on.index);
  return (
    <div className="ev-price">
      <span className="buy-price">{formatMoney(on.tier.priceCents, e.currency)}</span>
      {later && (
        <span className="ev-was">
          <s>{formatMoney(later, e.currency)}</s> {on.tier.label.toLowerCase()}
          {on.tier.until && ` until ${longDayLabel(new Date(`${on.tier.until}T12:00:00Z`), 'UTC')}`}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// /events
// ---------------------------------------------------------------------------------------------

export function EventList() {
  const site = useSiteSchoolId();
  const events = useQuery<PublicEvent>(site.schoolId ? `pubEvents:${site.schoolId}` : null, () =>
    query(collection(db, 'schools', site.schoolId!, 'events'), where('published', '==', true)),
  );
  const [now] = useState(() => new Date());
  const upcoming = events.data
    .filter((e) => e.status !== 'cancelled' && e.endAt.toMillis() > now.getTime())
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());

  return (
    <PublicShell>
      <div className="stack-lg">
        <header className="page-head">
          <h1>Events</h1>
          <p className="lede">Workshops and masterclasses. Anyone can join: no lessons or account needed.</p>
        </header>
        {site.loading || events.loading ? (
          <div className="skeleton skeleton-hero" aria-busy="true" />
        ) : upcoming.length === 0 ? (
          <article className="empty">
            <h2>Nothing scheduled right now</h2>
            <p>New events are announced here first. Check back soon.</p>
          </article>
        ) : (
          <ul className="ev-list">
            {upcoming.map((e) => {
              const left = seatsLeft(e.capacity, e.soldQty);
              return (
                <li key={e.id}>
                  <Link to={`/events/${e.id}`} className="ev-card">
                    <span className="ev-card-when">
                      <When e={e} />
                    </span>
                    <span className="ev-card-title">{e.title}</span>
                    {e.tagline && <span className="ev-card-tag">{e.tagline}</span>}
                    <span className="ev-card-foot">
                      <Price e={e} now={now} />
                      {left === 0 ? (
                        <span className="tag tag-muted">Sold out</span>
                      ) : (
                        <span className="text-link">
                          Get tickets <ArrowRight size={16} weight="bold" aria-hidden="true" />
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PublicShell>
  );
}

// ---------------------------------------------------------------------------------------------
// /events/:eventId
// ---------------------------------------------------------------------------------------------

/** Polls tries; about a minute at 2 s each. */
const MAX_TRIES = 30;

function OrderResult({ eventId, orderId, e }: { eventId: string; orderId: string; e: PublicEvent }) {
  const [state, setState] = useState<{ status: string; qty: number; email: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  // The webhook usually lands within seconds of HitPay's redirect.
  useEffect(() => {
    if (error || state?.status === 'paid' || state?.status === 'failed' || tries > MAX_TRIES) return;
    const t = setTimeout(
      () =>
        eventOrderStatus({ eventId, orderId })
          .then(setState)
          .catch((err) => setError(errorMessage(err)))
          .finally(() => setTries((n) => n + 1)),
      tries === 0 ? 0 : 2000,
    );
    return () => clearTimeout(t);
  }, [eventId, orderId, state?.status, tries, error]);

  if (error) {
    return (
      <p className="notice notice-warn" role="alert">
        {error}
      </p>
    );
  }
  if (state?.status === 'paid') {
    return (
      <section className="done" aria-live="polite">
        <CheckCircle className="done-mark" size={56} weight="fill" aria-hidden="true" />
        <h1>You're in</h1>
        <p className="done-when">
          {state.qty} {state.qty === 1 ? 'ticket' : 'tickets'} for {e.title}
        </p>
        <p className="lede">
          <When e={e} />. We've emailed your confirmation{state.email ? ` to ${state.email}` : ''}.
          {!e.venue && ' The venue is still to be confirmed: we will email you the address before the day.'}
        </p>
        <div className="done-actions">
          <Link className="btn btn-quiet" to={`/events/${eventId}`}>
            Back to the event
          </Link>
        </div>
      </section>
    );
  }
  if (state?.status === 'failed') {
    return (
      <div className="notice notice-warn" role="alert">
        <p>The payment didn't go through, so nothing was charged.</p>
        <Link className="btn btn-sm" to={`/events/${eventId}`}>
          Try again
        </Link>
      </div>
    );
  }
  return (
    <div className="notice notice-info" role="status" aria-live="polite">
      <p>
        {tries > MAX_TRIES
          ? "We haven't heard back from the payment yet. If you paid, your confirmation email is on its way; if it doesn't arrive in 15 minutes, contact the studio."
          : 'Confirming your payment…'}
      </p>
    </div>
  );
}

function TicketForm({ eventId, e, privacyUrl }: { eventId: string; e: PublicEvent; privacyUrl: string | null }) {
  const left = seatsLeft(e.capacity, e.soldQty);
  const max = Math.max(1, Math.min(e.maxPerOrder ?? DEFAULT_MAX_PER_ORDER, left ?? Infinity));
  const [qty, setQty] = useState(1);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', dial: '+65', phone: '', consent: false, marketing: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = currentTier(e.prices, new Date(), e.timeZone);
  if (!on) return null;
  const total = on.tier.priceCents * qty;

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { url } = await startEventCheckout({
        eventId,
        qty,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email.trim(),
        phone: `${form.dial} ${form.phone.replace(/^0+/, '')}`,
        consent: true,
        marketing: form.marketing,
      });
      window.location.assign(url); // HitPay; it returns to /events/:id?order=…
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="buy-card form" onSubmit={submit} id="tickets">
      <h2>Get tickets</h2>
      {max > 1 && (
        <div className="field">
          <span className="field-label" id="qty-label">
            Tickets
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="qty-label">
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={qty === n} onClick={() => setQty(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span className="field-label">First name</span>
          <input required autoComplete="given-name" value={form.firstName} onChange={(x) => setForm({ ...form, firstName: x.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Last name</span>
          <input autoComplete="family-name" value={form.lastName} onChange={(x) => setForm({ ...form, lastName: x.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Email</span>
        <input type="email" required autoComplete="email" inputMode="email" value={form.email} onChange={(x) => setForm({ ...form, email: x.target.value })} />
        <span className="field-help">Your confirmation goes here.</span>
      </label>
      <label className="field">
        <span className="field-label">Mobile</span>
        <div className="phone-row">
          <select aria-label="Country code" value={form.dial} onChange={(x) => setForm({ ...form, dial: x.target.value })}>
            {DIAL_CODES.map(([code, name]) => (
              <option key={code} value={code}>
                {name} {code}
              </option>
            ))}
          </select>
          <input type="tel" required autoComplete="tel-national" inputMode="tel" value={form.phone} onChange={(x) => setForm({ ...form, phone: x.target.value })} />
        </div>
        <span className="field-help">In case anything about the event changes.</span>
      </label>
      <label className="check">
        <input type="checkbox" required checked={form.consent} onChange={(x) => setForm({ ...form, consent: x.target.checked })} />
        <span>
          I agree to the{' '}
          {privacyUrl ? (
            <a href={privacyUrl} target="_blank" rel="noreferrer">
              privacy notice
            </a>
          ) : (
            'privacy notice'
          )}
          : the studio keeps my details to run this event and my booking.
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.marketing} onChange={(x) => setForm({ ...form, marketing: x.target.checked })} />
        <span>Tell me about future events (optional).</span>
      </label>
      <button className="btn btn-block" disabled={busy}>
        {busy ? 'Opening payment' : `Pay ${formatMoney(total, e.currency)}`}
        {!busy && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
      </button>
      <p className="meta">Card, PayNow and more, through HitPay.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function EventPage() {
  const { eventId = '' } = useParams();
  const [params] = useSearchParams();
  const orderId = params.get('order');
  const site = useSiteSchoolId();
  const profile = useProfile(site.schoolId);
  const ev = useDoc<PublicEvent>(site.schoolId && ID.test(eventId) ? `schools/${site.schoolId}/events/${eventId}` : null);
  const [now] = useState(() => new Date());
  const e = ev.data;

  useEffect(() => {
    if (e?.title) document.title = profile.data?.name ? `${e.title} · ${profile.data.name}` : e.title;
  }, [e?.title, profile.data?.name]);

  if (site.loading || ev.loading) {
    return (
      <PublicShell>
        <div className="skeleton skeleton-hero" aria-busy="true" />
      </PublicShell>
    );
  }
  // A draft or missing event reads as not found (rules refuse drafts to the public).
  if (!e) {
    return (
      <PublicShell>
        <article className="empty">
          <h2>That event isn't available</h2>
          <p>It may have ended or not be open yet.</p>
          <Link className="btn" to="/events">
            See all events
          </Link>
        </article>
      </PublicShell>
    );
  }
  if (orderId && ID.test(orderId)) {
    return (
      <PublicShell>
        <OrderResult eventId={eventId} orderId={orderId} e={e} />
      </PublicShell>
    );
  }

  const left = seatsLeft(e.capacity, e.soldQty);
  const onSale = currentTier(e.prices, now, e.timeZone);
  const closed =
    e.status === 'cancelled'
      ? 'This event has been cancelled.'
      : e.endAt.toMillis() <= now.getTime()
        ? 'This event has ended.'
        : e.startAt.toMillis() <= now.getTime() || !onSale
          ? 'Ticket sales have closed.'
          : left === 0
            ? 'Sold out.'
            : null;
  const paragraphs = (e.description ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <PublicShell>
      <article className="ev">
        <header className="page-head ev-head">
          <p className="ev-kicker">
            <Ticket size={18} weight="bold" aria-hidden="true" /> {profile.data?.name ?? 'Event'}
          </p>
          <h1>{e.title}</h1>
          {e.tagline && <p className="lede">{e.tagline}</p>}
          <ul className="buy-points ev-facts">
            <li>
              <CalendarBlank size={18} weight="bold" aria-hidden="true" />
              <span>
                <When e={e} />
              </span>
            </li>
            <li>
              <MapPin size={18} weight="bold" aria-hidden="true" />
              <span>{e.venue ?? 'Venue to be confirmed. Ticket holders get the address by email.'}</span>
            </li>
          </ul>
          {!closed && <Price e={e} now={now} />}
          {!closed && left !== null && left <= 10 && <p className="tag tag-warn">{left === 1 ? 'Last seat' : `${left} seats left`}</p>}
        </header>

        <div className="ev-body">
          {paragraphs.length > 0 && (
            <div className="ev-about">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          {closed ? <p className="notice notice-info">{closed}</p> : <TicketForm eventId={eventId} e={e} privacyUrl={profile.data?.privacyUrl ?? null} />}
        </div>
      </article>
    </PublicShell>
  );
}
