// Events: workshops and masterclasses sold as tickets on the learn site (/events), to anyone, no account.
// Staff edit events directly (rules allow it, except the sold count). Orders are checkouts of kind
// 'event', written by the ticket checkout and HitPay webhook; staff only tick people in at the door.
import { Timestamp, collection, doc, getDoc, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  DEFAULT_MAX_PER_ORDER,
  centsToDecimal,
  currentTier,
  formatDateTime,
  formatMoney,
  parseMoney,
  seatsLeft,
  wallClockToUtc,
  wallDateOf,
  type EventPriceTier,
} from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { useDoc, useQuery, useSchool, useTeachers, useTimeZone, type WithId } from '../hooks';
import { useSchoolId, useSession } from '../session';

export interface EventDoc {
  title: string;
  tagline: string;
  description: string;
  startAt: Timestamp;
  endAt: Timestamp;
  timeZone: string;
  venue: string | null;
  capacity: number | null;
  maxPerOrder: number;
  prices: EventPriceTier[];
  currency: string;
  teacherIds: string[];
  published: boolean;
  status: 'scheduled' | 'cancelled';
  soldQty?: number;
}

interface Order {
  kind: 'event';
  eventId: string;
  qty: number;
  tierLabel: string;
  amountCents: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'mismatch';
  buyer: { firstName: string; lastName: string; email: string; phone: string; marketing: boolean };
  studentId: string | null;
  invoiceId?: string;
  checkedInAt?: Timestamp | null;
  confirmationSentAt?: Timestamp;
  confirmationError?: string;
}

const resendConfirmation = call<{ schoolId: string; checkoutId: string }, { ok: true }>('resendEventConfirmation');

/** "mando-pop-to-english-pop": the event's id, which is also its public link. */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'event';

/** "15:00", for time inputs. */
const timeOf = (t: Timestamp, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t.toDate());
/** "5:00 pm", matching formatDateTime. */
const clockOf = (t: Timestamp, tz: string) => new Intl.DateTimeFormat('en-SG', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t.toDate());

function learnUrl(school: unknown, eventId: string): string | null {
  const host = (school as { hosts?: { learn?: string | null } } | null)?.hosts?.learn;
  return host ? `https://${host}/events/${eventId}` : null;
}

// ---------------------------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------------------------

function EventForm({ initial, onDone }: { initial: WithId<EventDoc> | null; onDone: (id: string) => void }) {
  const schoolId = useSchoolId();
  const school = useSchool().data;
  const schoolTz = useTimeZone();
  const tz = initial?.timeZone ?? schoolTz;
  const teachers = useTeachers().data.filter((t) => t.active !== false);
  const early = initial && initial.prices.length > 1 ? initial.prices[0] : null;
  const standard = initial ? initial.prices[initial.prices.length - 1] : null;
  const [f, setF] = useState({
    title: initial?.title ?? '',
    tagline: initial?.tagline ?? '',
    description: initial?.description ?? '',
    date: initial ? wallDateOf(initial.startAt.toDate(), tz) : '',
    start: initial ? timeOf(initial.startAt, tz) : '15:00',
    end: initial ? timeOf(initial.endAt, tz) : '17:00',
    venue: initial?.venue ?? '',
    capacity: initial?.capacity != null ? String(initial.capacity) : '',
    maxPerOrder: String(initial?.maxPerOrder ?? DEFAULT_MAX_PER_ORDER),
    price: standard ? centsToDecimal(standard.priceCents) : '',
    earlyPrice: early ? centsToDecimal(early.priceCents) : '',
    earlyUntil: early?.until ?? '',
    published: initial?.published ?? false,
  });
  const [hosts, setHosts] = useState<string[] | null>(initial?.teacherIds ?? null);
  // New event: hosted by the first teacher until staff choose (teachers load after the first render).
  const hostIds = hosts ?? teachers.slice(0, 1).map((t) => t.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const price = parseMoney(f.price);
    if (price === null) return setError('Enter the ticket price, like 88.');
    const earlyPrice = f.earlyPrice.trim() ? parseMoney(f.earlyPrice) : null;
    if (f.earlyPrice.trim() && earlyPrice === null) return setError('Enter the early bird price, like 68, or leave it blank.');
    if (earlyPrice !== null && !f.earlyUntil) return setError('Pick the last day of the early bird price.');
    if (!f.date) return setError('Pick the date.');
    const startAt = wallClockToUtc(f.date, f.start, tz);
    const endAt = wallClockToUtc(f.date, f.end, tz);
    if (endAt <= startAt) return setError('The end time must be after the start time.');
    if (earlyPrice !== null && f.earlyUntil > f.date) return setError('The early bird must end on or before the event day.');
    const capacity = f.capacity.trim() ? Number(f.capacity) : null;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000)) return setError('Seats must be a whole number, or blank for no limit.');
    const maxPerOrder = Number(f.maxPerOrder);
    if (!Number.isInteger(maxPerOrder) || maxPerOrder < 1 || maxPerOrder > 20) return setError('Tickets per order must be 1 to 20.');
    const prices: EventPriceTier[] = [
      ...(earlyPrice !== null ? [{ label: 'Early bird', priceCents: earlyPrice, until: f.earlyUntil }] : []),
      { label: earlyPrice !== null ? 'Standard' : 'Ticket', priceCents: price, until: null },
    ];
    const data = {
      title: f.title.trim(),
      tagline: f.tagline.trim(),
      description: f.description.trim(),
      startAt: Timestamp.fromDate(startAt),
      endAt: Timestamp.fromDate(endAt),
      timeZone: tz,
      venue: f.venue.trim() || null,
      capacity,
      maxPerOrder,
      prices,
      currency: school?.currency ?? 'SGD',
      teacherIds: hostIds,
      published: f.published,
      updatedAt: serverTimestamp(),
    };
    setBusy(true);
    try {
      let id = initial?.id;
      if (id) await updateDoc(doc(db, 'schools', schoolId, 'events', id), data);
      else {
        // The id is the public link; a date suffix keeps a repeat of the same title apart.
        id = `${slugify(data.title)}-${f.date.slice(0, 7)}`;
        if ((await getDoc(doc(db, 'schools', schoolId, 'events', id))).exists()) {
          setBusy(false);
          return setError('There is already an event with this title that month. Change the title.');
        }
        await setDoc(doc(db, 'schools', schoolId, 'events', id), { ...data, status: 'scheduled', createdAt: serverTimestamp() });
      }
      onDone(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field span-all">
        <span>Title</span>
        <input required maxLength={100} value={f.title} onChange={set('title')} placeholder="e.g. Mando Pop to English Pop" />
      </label>
      <label className="field span-all">
        <span>One-line pitch</span>
        <input maxLength={160} value={f.tagline} onChange={set('tagline')} placeholder="Learn to sing English songs the way they were designed." />
      </label>
      <label className="field span-all">
        <span>About the event</span>
        <textarea
          rows={6}
          maxLength={5000}
          value={f.description}
          onChange={set('description')}
          placeholder="What people will learn, who it's for, what to bring. Blank lines start new paragraphs."
        />
      </label>
      <label className="field">
        <span>Date</span>
        <input type="date" required value={f.date} onChange={set('date')} />
      </label>
      <label className="field">
        <span>Starts</span>
        <input type="time" required value={f.start} onChange={set('start')} />
      </label>
      <label className="field">
        <span>Ends</span>
        <input type="time" required value={f.end} onChange={set('end')} />
      </label>
      <label className="field span-all">
        <span>Venue (blank = "to be confirmed")</span>
        <input maxLength={300} value={f.venue} onChange={set('venue')} placeholder="Address, or a Zoom note" />
      </label>
      <label className="field">
        <span>Price (SGD)</span>
        <input inputMode="decimal" required value={f.price} onChange={set('price')} placeholder="88" />
      </label>
      <label className="field">
        <span>Early bird price (optional)</span>
        <input inputMode="decimal" value={f.earlyPrice} onChange={set('earlyPrice')} placeholder="68" />
      </label>
      <label className="field">
        <span>Early bird until (last day, inclusive)</span>
        <input type="date" value={f.earlyUntil} onChange={set('earlyUntil')} disabled={!f.earlyPrice.trim()} />
      </label>
      <label className="field">
        <span>Seats (blank = no limit)</span>
        <input inputMode="numeric" value={f.capacity} onChange={set('capacity')} />
      </label>
      <label className="field">
        <span>Most tickets per order</span>
        <input inputMode="numeric" required value={f.maxPerOrder} onChange={set('maxPerOrder')} />
      </label>
      {teachers.length > 0 && (
        <fieldset className="field span-all fieldset-plain">
          <span>Hosted by (their booking calendar is blocked during the event)</span>
          <div className="row">
            {teachers.map((t) => (
              <label key={t.id} className="row">
                <input
                  type="checkbox"
                  checked={hostIds.includes(t.id)}
                  onChange={(e) => setHosts(e.target.checked ? [...hostIds, t.id] : hostIds.filter((h) => h !== t.id))}
                />
                {t.displayName}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="field checkbox span-all">
        <input type="checkbox" checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} />
        <span>Published: shown on the learn site and open for tickets</span>
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Save event' : 'Create event'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onDone(initial?.id ?? '')}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// One event: details, link, ticket holders
// ---------------------------------------------------------------------------------------------

function EventDetail({ eventId }: { eventId: string }) {
  const schoolId = useSchoolId();
  const { role } = useSession();
  const school = useSchool().data;
  const ev = useDoc<EventDoc>(`schools/${schoolId}/events/${eventId}`);
  const orders = useQuery<Order>(`eventOrders:${schoolId}:${eventId}`, () =>
    query(collection(db, 'schools', schoolId, 'checkouts'), where('eventId', '==', eventId)),
  );
  const [editing, setEditing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const paid = useMemo(
    () =>
      orders.data
        .filter((o) => o.status === 'paid')
        .sort((a, b) => `${a.buyer.firstName} ${a.buyer.lastName}`.localeCompare(`${b.buyer.firstName} ${b.buyer.lastName}`)),
    [orders.data],
  );
  const unfinished = orders.data.filter((o) => o.status !== 'paid');

  if (ev.loading) return <p className="muted">Loading…</p>;
  const e = ev.data;
  if (!e) {
    return (
      <p className="empty">
        That event doesn't exist. <Link to="/events">All events</Link>
      </p>
    );
  }
  if (editing) return <EventForm initial={e} onDone={() => setEditing(false)} />;

  const tz = e.timeZone;
  const sold = paid.reduce((n, o) => n + o.qty, 0);
  const checkedIn = paid.filter((o) => o.checkedInAt).reduce((n, o) => n + o.qty, 0);
  const revenue = paid.reduce((n, o) => n + o.amountCents, 0);
  const left = seatsLeft(e.capacity, e.soldQty);
  const onSale = currentTier(e.prices, new Date(), tz);
  const url = learnUrl(school, eventId);

  const toggleIn = (o: WithId<Order>) =>
    updateDoc(doc(db, 'schools', schoolId, 'checkouts', o.id), { checkedInAt: o.checkedInAt ? null : serverTimestamp(), updatedAt: serverTimestamp() });

  async function resend(o: WithId<Order>) {
    setBusyId(o.id);
    setNote(null);
    try {
      await resendConfirmation({ schoolId, checkoutId: o.id });
      setNote(`Confirmation sent again to ${o.buyer.email}.`);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const setStatus = (status: EventDoc['status']) =>
    updateDoc(doc(db, 'schools', schoolId, 'events', eventId), { status, ...(status === 'cancelled' ? { published: false } : {}), updatedAt: serverTimestamp() });

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/events">Events</Link>
          </p>
          <h1>
            {e.title}
            {e.status === 'cancelled' ? <span className="badge badge-cancelled">cancelled</span> : !e.published && <span className="badge">draft</span>}
          </h1>
          <p className="muted">
            {formatDateTime(e.startAt.toDate(), tz)} to {clockOf(e.endAt, tz)} · {e.venue ?? 'Venue to be confirmed'}
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          {(role === 'owner' || role === 'admin') &&
            (e.status === 'cancelled' ? (
              <button className="btn btn-ghost" onClick={() => setStatus('scheduled')}>
                Restore
              </button>
            ) : (
              <button
                className="btn btn-ghost"
                onClick={() => window.confirm('Cancel this event? It comes off the learn site and stops selling. Refund paid tickets from each invoice.') && setStatus('cancelled')}
              >
                Cancel event
              </button>
            ))}
        </div>
      </div>

      <div className="tiles card">
        <div className="tile">
          <span className="tile-label">Tickets sold</span>
          <span className="tile-value">
            {sold}
            {e.capacity != null && <span className="muted"> / {e.capacity}</span>}
          </span>
          {left !== null && <span className="muted">{left} seats left</span>}
        </div>
        <div className="tile">
          <span className="tile-label">Taken in</span>
          <span className="tile-value">{formatMoney(revenue, e.currency)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">On sale now</span>
          <span className="tile-value">{onSale ? formatMoney(onSale.tier.priceCents, e.currency) : 'Closed'}</span>
          {onSale && (
            <span className="muted">
              {onSale.tier.label}
              {onSale.tier.until ? ` until ${onSale.tier.until}` : ''}
            </span>
          )}
        </div>
        <div className="tile">
          <span className="tile-label">Checked in</span>
          <span className="tile-value">{checkedIn}</span>
        </div>
      </div>

      {url && (
        <div className="row">
          <code>{url}</code>
          <button
            className="btn btn-sm"
            onClick={() =>
              navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {!e.published && <span className="muted">Publish the event to open this link.</span>}
        </div>
      )}

      <h2>Ticket holders</h2>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {orders.error && <p className="error">{orders.error.message}</p>}
      {paid.length === 0 ? (
        <p className="empty">No tickets sold yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th className="num">Tickets</th>
              <th>Price</th>
              <th>Paid</th>
              <th>Confirmation</th>
              <th>At the door</th>
            </tr>
          </thead>
          <tbody>
            {paid.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.studentId ? (
                    <Link to={`/students/${o.studentId}`}>
                      {o.buyer.firstName} {o.buyer.lastName}
                    </Link>
                  ) : (
                    `${o.buyer.firstName} ${o.buyer.lastName}`
                  )}
                </td>
                <td>
                  <a href={`mailto:${o.buyer.email}`}>{o.buyer.email}</a>
                  <br />
                  <a href={`https://wa.me/${o.buyer.phone.replace(/\D/g, '')}`} target="_blank" rel="noopener">
                    {o.buyer.phone}
                  </a>
                </td>
                <td className="num">{o.qty}</td>
                <td>{o.tierLabel}</td>
                <td>{o.invoiceId ? <Link to={`/invoices/${o.invoiceId}`}>{formatMoney(o.amountCents, o.currency)}</Link> : formatMoney(o.amountCents, o.currency)}</td>
                <td>
                  {o.confirmationError ? <span className="badge badge-warn">not sent</span> : o.confirmationSentAt ? <span className="muted">sent</span> : <span className="muted">—</span>}{' '}
                  <button className="btn btn-sm btn-ghost" disabled={busyId === o.id} onClick={() => resend(o)}>
                    {busyId === o.id ? 'Sending…' : 'Resend'}
                  </button>
                </td>
                <td>
                  <button className={`btn btn-sm ${o.checkedInAt ? 'btn-primary' : ''}`} onClick={() => toggleIn(o)} aria-pressed={!!o.checkedInAt}>
                    {o.checkedInAt ? 'Checked in' : 'Check in'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unfinished.length > 0 && (
        <details>
          <summary className="muted">
            {unfinished.length} unfinished checkout{unfinished.length === 1 ? '' : 's'} (started paying, didn't finish)
          </summary>
          <table className="table">
            <tbody>
              {unfinished.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.buyer.firstName} {o.buyer.lastName}
                  </td>
                  <td>{o.buyer.email}</td>
                  <td>{o.buyer.phone}</td>
                  <td className="num">{o.qty}</td>
                  <td>
                    <span className="badge">{o.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function Events() {
  const { eventId } = useParams();
  const schoolId = useSchoolId();
  const navigate = useNavigate();
  const events = useQuery<EventDoc>(`events:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'events')));
  const [adding, setAdding] = useState(false);

  if (eventId) return <EventDetail key={eventId} eventId={eventId} />;
  const now = Date.now();
  // Upcoming first (soonest first), then past ones (latest first).
  const rows = [...events.data].sort((a, b) => {
    const pa = a.endAt.toMillis() < now;
    const pb = b.endAt.toMillis() < now;
    if (pa !== pb) return pa ? 1 : -1;
    return pa ? b.startAt.toMillis() - a.startAt.toMillis() : a.startAt.toMillis() - b.startAt.toMillis();
  });

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Events</h1>
          <p className="muted">Workshops and masterclasses. Anyone can buy tickets on the learn site, no account needed.</p>
        </div>
        {!adding && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New event
          </button>
        )}
      </div>
      {adding && (
        <EventForm
          initial={null}
          onDone={(id) => {
            setAdding(false);
            if (id) navigate(`/events/${id}`);
          }}
        />
      )}
      {events.error && <p className="error">{events.error.message}</p>}
      {events.loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">No events yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Event</th>
              <th>When</th>
              <th>Venue</th>
              <th className="num">Sold</th>
              <th>Price now</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const tier = currentTier(e.prices, new Date(), e.timeZone);
              const past = e.endAt.toMillis() < now;
              return (
                <tr key={e.id} className={e.status === 'cancelled' || past ? 'cancelled' : ''}>
                  <td>
                    <Link to={`/events/${e.id}`}>{e.title}</Link>
                    {e.status === 'cancelled' ? <span className="badge badge-cancelled">cancelled</span> : !e.published && <span className="badge">draft</span>}
                  </td>
                  <td>{formatDateTime(e.startAt.toDate(), e.timeZone)}</td>
                  <td>{e.venue ?? <span className="muted">To be confirmed</span>}</td>
                  <td className="num">
                    {e.soldQty ?? 0}
                    {e.capacity != null && ` / ${e.capacity}`}
                  </td>
                  <td>{tier && !past ? `${formatMoney(tier.tier.priceCents, e.currency)} (${tier.tier.label})` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
