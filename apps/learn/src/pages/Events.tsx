// Public event pages (/events, /events/:eventId): anyone can buy tickets, signed in or not. The school
// comes from the site's hostname (publicSchools). An event can hold several sessions; the buyer picks
// one of them or the bundle of all. Paying opens HitPay, which sends the buyer back here with ?order=…;
// the page then waits for the payment webhook to mark the order paid.
import { ArrowRight, CalendarBlank, CheckCircle, MapPin, Ticket } from '@phosphor-icons/react';
import { collection, query, where, type Timestamp } from 'firebase/firestore';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useParams, useSearchParams } from 'react-router';
import { DEFAULT_MAX_PER_ORDER, currentTier, formatMoney, laterPrice, optionSeatsLeft, type EventOption } from '@lessonkaki/shared';
import { call, db, errorMessage } from '../firebase';
import { longDayLabel, timeLabel, timeRange, zoneName } from '../format';
import { logoSrc, useDoc, useProfile, useQuery, useSiteSchoolId } from '../hooks';
import { DIAL_CODES } from './SignIn';

interface PublicSession {
  key: string;
  title: string;
  summary?: string;
  startAt: Timestamp;
  endAt: Timestamp;
  capacity: number | null;
  /** Banner picture (a Storage download URL). */
  imageUrl?: string | null;
}

interface PublicEvent {
  title: string;
  tagline?: string;
  description?: string;
  startAt: Timestamp;
  endAt: Timestamp;
  timeZone: string;
  venue: string | null;
  maxPerOrder?: number;
  sessions: PublicSession[];
  options: EventOption[];
  currency: string;
  published: boolean;
  status: 'scheduled' | 'cancelled';
  soldBySession?: Record<string, number>;
}

interface CheckoutIn {
  eventId: string;
  optionKey: string;
  qty: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  consent: true;
  marketing: boolean;
}
interface OrderState {
  status: string;
  qty: number;
  optionLabel: string | null;
  email: string | null;
}
const startEventCheckout = call<CheckoutIn, { checkoutId: string; url: string }>('startEventCheckout');
const eventOrderStatus = call<{ eventId: string; orderId: string }, OrderState>('eventOrderStatus');

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

/** The browser's zone differs from the event's: say which zone times are in. */
function ZoneNote({ tz }: { tz: string }) {
  return Intl.DateTimeFormat().resolvedOptions().timeZone !== tz ? <span className="meta"> ({zoneName(tz)})</span> : null;
}

/** An option's sessions, in time order. */
const sessionsOf = (e: PublicEvent, o: EventOption) =>
  o.sessionKeys
    .map((k) => e.sessions.find((s) => s.key === k))
    .filter((s): s is PublicSession => !!s)
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());

/** Why an option can't be bought right now, or null when it can. */
function closedReason(e: PublicEvent, o: EventOption, now: Date): string | null {
  if (sessionsOf(e, o).some((s) => s.startAt.toMillis() <= now.getTime())) return 'Sales closed';
  if (!currentTier(o.prices, now, e.timeZone)) return 'Sales closed';
  if (optionSeatsLeft(o, e.sessions, e.soldBySession) === 0) return 'Sold out';
  return null;
}

/** The cheapest price on sale now across the open options ("From S$68"). */
function fromPrice(e: PublicEvent, now: Date): number | null {
  const prices = e.options.filter((o) => !closedReason(e, o, now)).map((o) => currentTier(o.prices, now, e.timeZone)!.tier.priceCents);
  return prices.length ? Math.min(...prices) : null;
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
              const from = fromPrice(e, now);
              return (
                <li key={e.id}>
                  <Link to={`/events/${e.id}`} className="ev-card">
                    {e.sessions.some((s) => s.imageUrl) && (
                      <span className="ev-card-pics">
                        {e.sessions
                          .filter((s) => s.imageUrl)
                          .map((s) => (
                            <img key={s.key} src={s.imageUrl!} alt="" loading="lazy" />
                          ))}
                      </span>
                    )}
                    <span className="ev-card-when">
                      {longDayLabel(e.startAt.toDate(), e.timeZone)}
                      <ZoneNote tz={e.timeZone} />
                    </span>
                    <span className="ev-card-title">{e.title}</span>
                    {e.tagline && <span className="ev-card-tag">{e.tagline}</span>}
                    {e.sessions.length > 1 && (
                      <ul className="ev-card-sessions">
                        {e.sessions.map((s) => (
                          <li key={s.key}>
                            <span className="ev-time">{timeLabel(s.startAt.toDate(), e.timeZone)}</span> {s.title}
                          </li>
                        ))}
                      </ul>
                    )}
                    <span className="ev-card-foot">
                      {from !== null ? <span className="ev-from">From {formatMoney(from, e.currency)}</span> : <span className="tag tag-muted">Sold out</span>}
                      {from !== null && (
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

/** Status polls: about a minute at 2 s each. */
const MAX_TRIES = 30;

function OrderResult({ eventId, orderId, e }: { eventId: string; orderId: string; e: PublicEvent }) {
  const [state, setState] = useState<OrderState | null>(null);
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
          {state.qty} {state.qty === 1 ? 'ticket' : 'tickets'}: {state.optionLabel ?? e.title}
        </p>
        <p className="lede">
          {longDayLabel(e.startAt.toDate(), e.timeZone)}
          {e.venue ? `, ${e.venue}` : ''}. We've emailed your confirmation{state.email ? ` to ${state.email}` : ''}.
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

/** One ticket choice: what it includes, its price now, and the saving for a bundle. */
function OptionChoice({ e, o, now, checked, onPick }: { e: PublicEvent; o: EventOption; now: Date; checked: boolean; onPick: () => void }) {
  const closed = closedReason(e, o, now);
  const on = currentTier(o.prices, now, e.timeZone);
  const later = on ? laterPrice(o.prices, on.index) : null;
  const parts = sessionsOf(e, o);
  // A bundle's saving against buying its sessions one by one at today's prices.
  const separately =
    parts.length > 1
      ? parts.reduce((n, s) => {
          const single = e.options.find((x) => x.sessionKeys.length === 1 && x.sessionKeys[0] === s.key);
          const p = single && currentTier(single.prices, now, e.timeZone);
          return p ? n + p.tier.priceCents : NaN;
        }, 0)
      : NaN;
  const saving = on && Number.isFinite(separately) ? separately - on.tier.priceCents : 0;
  const left = optionSeatsLeft(o, e.sessions, e.soldBySession);
  return (
    <label className={`ev-option${checked ? ' on' : ''}${closed ? ' off' : ''}`}>
      <input type="radio" name="option" checked={checked} disabled={!!closed} onChange={onPick} />
      <span className="ev-option-main">
        <span className="ev-option-title">{o.label}</span>
        <span className="meta">{parts.map((s) => timeRange(s.startAt.toDate(), s.endAt.toDate(), e.timeZone)).join(' and ')}</span>
        {saving > 0 && !closed && <span className="tag tag-ok">Save {formatMoney(saving, e.currency)}</span>}
        {!closed && left !== null && left <= 10 && <span className="tag tag-warn">{left === 1 ? 'Last seat' : `${left} seats left`}</span>}
      </span>
      <span className="ev-option-price">
        {closed ? (
          <span className="tag tag-muted">{closed}</span>
        ) : (
          <>
            <span className="ev-option-now">{formatMoney(on!.tier.priceCents, e.currency)}</span>
            {later && <s className="meta">{formatMoney(later, e.currency)}</s>}
          </>
        )}
      </span>
    </label>
  );
}

function TicketForm({ eventId, e, privacyUrl }: { eventId: string; e: PublicEvent; privacyUrl: string | null }) {
  const [now] = useState(() => new Date());
  const open = e.options.filter((o) => !closedReason(e, o, now));
  // Start on the bundle when there is one: it's the better deal.
  const [optionKey, setOptionKey] = useState(() => (open.find((o) => o.sessionKeys.length > 1) ?? open[0])?.key ?? '');
  const option = open.find((o) => o.key === optionKey) ?? null;
  const left = option ? optionSeatsLeft(option, e.sessions, e.soldBySession) : null;
  const max = Math.max(1, Math.min(e.maxPerOrder ?? DEFAULT_MAX_PER_ORDER, left ?? Infinity));
  const [qty, setQty] = useState(1);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', dial: '+65', phone: '', consent: false, marketing: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = option ? currentTier(option.prices, now, e.timeZone) : null;
  const n = Math.min(qty, max);
  const earlyUntil = open.map((o) => currentTier(o.prices, now, e.timeZone)?.tier.until).find((u): u is string => !!u) ?? null;

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!option) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await startEventCheckout({
        eventId,
        optionKey: option.key,
        qty: n,
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
    <form className="buy-card form ev-form" onSubmit={submit} id="tickets">
      <h2>Get tickets</h2>
      {earlyUntil && <p className="meta">Early bird prices until {longDayLabel(new Date(`${earlyUntil}T12:00:00Z`), 'UTC')}.</p>}
      <fieldset className="ev-options">
        <legend className="field-label">{e.options.length > 1 ? 'Choose your ticket' : 'Ticket'}</legend>
        {e.options.map((o) => (
          <OptionChoice key={o.key} e={e} o={o} now={now} checked={o.key === optionKey} onPick={() => setOptionKey(o.key)} />
        ))}
      </fieldset>
      {max > 1 && (
        <div className="field">
          <span className="field-label" id="qty-label">
            How many people
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="qty-label">
            {Array.from({ length: max }, (_, i) => i + 1).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={n === k} onClick={() => setQty(k)}>
                {k}
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
      <button className="btn btn-block" disabled={busy || !on}>
        {busy ? 'Opening payment' : on ? `Pay ${formatMoney(on.tier.priceCents * n, e.currency)}` : 'Pick a ticket'}
        {!busy && on && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
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

  const tz = e.timeZone;
  const anyOpen = e.options.some((o) => !closedReason(e, o, now));
  const closed =
    e.status === 'cancelled'
      ? 'This event has been cancelled.'
      : e.endAt.toMillis() <= now.getTime()
        ? 'This event has ended.'
        : !anyOpen
          ? e.options.every((o) => closedReason(e, o, now) === 'Sold out')
            ? 'Sold out.'
            : 'Ticket sales have closed.'
          : null;
  const paragraphs = (e.description ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const sessions = [...e.sessions].sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
  const from = fromPrice(e, now);

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
                {longDayLabel(e.startAt.toDate(), tz)}, {timeRange(e.startAt.toDate(), e.endAt.toDate(), tz)}
                <ZoneNote tz={tz} />
              </span>
            </li>
            <li>
              <MapPin size={18} weight="bold" aria-hidden="true" />
              <span>{e.venue ?? 'Venue to be confirmed. Ticket holders get the address by email.'}</span>
            </li>
          </ul>
          {!closed && from !== null && (
            <a className="btn ev-jump" href="#tickets">
              Tickets from {formatMoney(from, e.currency)}
            </a>
          )}
        </header>

        <div className="ev-body">
          {paragraphs.length > 0 && (
            <div className="ev-about">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          <ol className="ev-sessions">
            {sessions.map((s) => (
              <li key={s.key} className="ev-session">
                {s.imageUrl && <img className="ev-session-pic" src={s.imageUrl} alt="" />}
                <span className="ev-session-time">{timeRange(s.startAt.toDate(), s.endAt.toDate(), tz)}</span>
                <h2 className="ev-session-title">{s.title}</h2>
                {s.summary &&
                  s.summary
                    .split(/\n\s*\n/)
                    .filter((p) => p.trim())
                    .map((p, i) => <p key={i}>{p.trim()}</p>)}
              </li>
            ))}
          </ol>
          {closed ? <p className="notice notice-info">{closed}</p> : <TicketForm eventId={eventId} e={e} privacyUrl={profile.data?.privacyUrl ?? null} />}
        </div>
      </article>
    </PublicShell>
  );
}
