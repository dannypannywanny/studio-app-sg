// Events: workshops and masterclasses sold as tickets on the learn site (/events), to anyone, no account.
// One event is one page with one or more sessions (e.g. two masterclasses the same afternoon); buyers
// pick one session or the cheaper bundle of all of them. Staff edit events directly (rules allow it,
// except the sold counts). Orders are checkouts of kind 'event', written by the ticket checkout and the
// HitPay webhook; staff only tick people in at the door.
import { Timestamp, collection, doc, getDoc, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  DEFAULT_MAX_PER_ORDER,
  buildEventOptions,
  centsToDecimal,
  currentTier,
  formatDateTime,
  formatMoney,
  parseMoney,
  seatsLeft,
  wallClockToUtc,
  wallDateOf,
  type EventOption,
} from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { useDoc, useQuery, useSchool, useTeachers, useTimeZone, type WithId } from '../hooks';
import { useSchoolId, useSession } from '../session';

interface SessionDoc {
  key: string;
  title: string;
  summary: string;
  startAt: Timestamp;
  endAt: Timestamp;
  capacity: number | null;
}

export interface EventDoc {
  title: string;
  tagline: string;
  description: string;
  /** First session's start and last session's end (lists, and the hosts' booking block). */
  startAt: Timestamp;
  endAt: Timestamp;
  timeZone: string;
  venue: string | null;
  maxPerOrder: number;
  sessions: SessionDoc[];
  options: EventOption[];
  currency: string;
  teacherIds: string[];
  published: boolean;
  status: 'scheduled' | 'cancelled';
  soldQty?: number;
  soldBySession?: Record<string, number>;
}

interface Order {
  kind: 'event';
  eventId: string;
  optionKey: string;
  optionLabel: string;
  sessionKeys: string[];
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

/** "mando-pop-to-english-pop": readable ids for events and sessions (the event id is its public link). */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'event';

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

interface SessionRow {
  key: string;
  title: string;
  summary: string;
  start: string;
  end: string;
  capacity: string;
  price: string;
  earlyPrice: string;
}

const blankSession = (start = '15:00', end = '16:00'): SessionRow => ({ key: '', title: '', summary: '', start, end, capacity: '', price: '', earlyPrice: '' });

/** Back from the stored options to the form: each session's prices, the bundle, the early bird date. */
function formFrom(e: EventDoc) {
  const tz = e.timeZone;
  const option = (key: string) => e.options.find((o) => o.key === key);
  const priceOf = (o: EventOption | undefined) => (o ? centsToDecimal(o.prices[o.prices.length - 1]!.priceCents) : '');
  const earlyOf = (o: EventOption | undefined) => (o && o.prices.length > 1 ? centsToDecimal(o.prices[0]!.priceCents) : '');
  const bundle = option('all');
  return {
    sessions: e.sessions.map(
      (s): SessionRow => ({
        key: s.key,
        title: s.title,
        summary: s.summary ?? '',
        start: timeOf(s.startAt, tz),
        end: timeOf(s.endAt, tz),
        capacity: s.capacity != null ? String(s.capacity) : '',
        price: priceOf(option(s.key)),
        earlyPrice: earlyOf(option(s.key)),
      }),
    ),
    bundleLabel: bundle?.label ?? '',
    bundlePrice: priceOf(bundle),
    bundleEarly: earlyOf(bundle),
    earlyUntil: e.options.find((o) => o.prices.length > 1)?.prices[0]?.until ?? '',
  };
}

function EventForm({ initial, onDone }: { initial: WithId<EventDoc> | null; onDone: (id: string) => void }) {
  const schoolId = useSchoolId();
  const school = useSchool().data;
  const schoolTz = useTimeZone();
  const tz = initial?.timeZone ?? schoolTz;
  const teachers = useTeachers().data.filter((t) => t.active !== false);
  const from = initial ? formFrom(initial) : null;
  const [f, setF] = useState({
    title: initial?.title ?? '',
    tagline: initial?.tagline ?? '',
    description: initial?.description ?? '',
    date: initial ? wallDateOf(initial.startAt.toDate(), tz) : '',
    venue: initial?.venue ?? '',
    maxPerOrder: String(initial?.maxPerOrder ?? DEFAULT_MAX_PER_ORDER),
    earlyUntil: from?.earlyUntil ?? '',
    bundleLabel: from?.bundleLabel || 'Both classes',
    bundlePrice: from?.bundlePrice ?? '',
    bundleEarly: from?.bundleEarly ?? '',
    published: initial?.published ?? false,
  });
  const [sessions, setSessions] = useState<SessionRow[]>(from?.sessions ?? [blankSession()]);
  const [hosts, setHosts] = useState<string[] | null>(initial?.teacherIds ?? null);
  // New event: hosted by the first teacher until staff choose (teachers load after the first render).
  const hostIds = hosts ?? teachers.slice(0, 1).map((t) => t.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const setSession = (i: number, k: keyof SessionRow) => (e: { target: { value: string } }) =>
    setSessions(sessions.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)));
  const anyEarly = sessions.some((s) => s.earlyPrice.trim()) || !!f.bundleEarly.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.date) return setError('Pick the date.');
    /** Cents, null when optional and blank, or false after showing an error. */
    const money = (text: string, what: string, optional = false): number | null | false => {
      if (optional && !text.trim()) return null;
      const n = parseMoney(text);
      if (n === null) {
        setError(`Enter ${what} like 88${optional ? ', or leave it blank' : ''}.`);
        return false;
      }
      return n;
    };
    const keys = new Set<string>();
    const built = [];
    for (const [i, s] of sessions.entries()) {
      if (!s.title.trim()) return setError(`Give session ${i + 1} a title.`);
      const name = s.title.trim();
      const startAt = wallClockToUtc(f.date, s.start, tz);
      const endAt = wallClockToUtc(f.date, s.end, tz);
      if (endAt <= startAt) return setError(`${name}: the end time must be after the start time.`);
      const capacity = s.capacity.trim() ? Number(s.capacity) : null;
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000)) return setError(`${name}: seats must be a whole number, or blank for no limit.`);
      const price = money(s.price, `the price of ${name}`);
      const early = money(s.earlyPrice, `the early bird price of ${name}`, true);
      if (price === false || price === null || early === false) return;
      // A saved session keeps its key: orders refer to it.
      let key = s.key || slugify(s.title);
      while (keys.has(key) || key === 'all') key = `${key}-${i + 1}`;
      keys.add(key);
      built.push({ key, title: name, summary: s.summary.trim(), startAt, endAt, capacity, price, early });
    }
    const bundlePrice = sessions.length > 1 ? money(f.bundlePrice, 'the price for all sessions', true) : null;
    const bundleEarly = sessions.length > 1 && bundlePrice ? money(f.bundleEarly, 'the early bird price for all sessions', true) : null;
    if (bundlePrice === false || bundleEarly === false) return;
    if (anyEarly && !f.earlyUntil) return setError('Pick the last day of the early bird prices.');
    if (anyEarly && f.earlyUntil > f.date) return setError('The early bird must end on or before the event day.');
    const maxPerOrder = Number(f.maxPerOrder);
    if (!Number.isInteger(maxPerOrder) || maxPerOrder < 1 || maxPerOrder > 20) return setError('Tickets per order must be 1 to 20.');

    built.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const options = buildEventOptions(
      built.map((s) => ({ key: s.key, title: s.title, priceCents: s.price, earlyCents: s.early })),
      bundlePrice ? { label: f.bundleLabel.trim() || 'All sessions', priceCents: bundlePrice, earlyCents: bundleEarly } : null,
      anyEarly ? f.earlyUntil : null,
    );
    const data = {
      title: f.title.trim(),
      tagline: f.tagline.trim(),
      description: f.description.trim(),
      startAt: Timestamp.fromDate(built[0]!.startAt),
      endAt: Timestamp.fromDate(new Date(Math.max(...built.map((s) => s.endAt.getTime())))),
      timeZone: tz,
      venue: f.venue.trim() || null,
      maxPerOrder,
      sessions: built.map((s) => ({
        key: s.key,
        title: s.title,
        summary: s.summary,
        startAt: Timestamp.fromDate(s.startAt),
        endAt: Timestamp.fromDate(s.endAt),
        capacity: s.capacity,
      })),
      options,
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
        // The id is the public link; the month keeps a repeat of the same title apart.
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
        <span>Page title</span>
        <input required maxLength={100} value={f.title} onChange={set('title')} placeholder="e.g. Masterclass Afternoon" />
      </label>
      <label className="field span-all">
        <span>One-line pitch</span>
        <input maxLength={160} value={f.tagline} onChange={set('tagline')} placeholder="Two masterclasses, one afternoon." />
      </label>
      <label className="field span-all">
        <span>About (optional)</span>
        <textarea rows={4} maxLength={5000} value={f.description} onChange={set('description')} placeholder="Who it's for, what to bring. Blank lines start new paragraphs." />
      </label>
      <label className="field">
        <span>Date</span>
        <input type="date" required value={f.date} onChange={set('date')} />
      </label>
      <label className="field span-all">
        <span>Venue (blank = "to be confirmed")</span>
        <input maxLength={300} value={f.venue} onChange={set('venue')} placeholder="Address, or a Zoom note" />
      </label>

      {sessions.map((s, i) => (
        <fieldset key={i} className="span-all card form-grid">
          <legend className="row">
            <strong>Session {i + 1}</strong>
            {sessions.length > 1 && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                title={s.key && initial?.soldBySession?.[s.key] ? 'Tickets are sold for this session' : undefined}
                disabled={!!s.key && !!initial?.soldBySession?.[s.key]}
                onClick={() => setSessions(sessions.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            )}
          </legend>
          <label className="field span-all">
            <span>Title</span>
            <input required maxLength={100} value={s.title} onChange={setSession(i, 'title')} placeholder="e.g. Mando Pop to English Pop" />
          </label>
          <label className="field span-all">
            <span>What it covers</span>
            <textarea rows={3} maxLength={2000} value={s.summary} onChange={setSession(i, 'summary')} placeholder="Learn to sing English songs the way they were designed." />
          </label>
          <label className="field">
            <span>Starts</span>
            <input type="time" required value={s.start} onChange={setSession(i, 'start')} />
          </label>
          <label className="field">
            <span>Ends</span>
            <input type="time" required value={s.end} onChange={setSession(i, 'end')} />
          </label>
          <label className="field">
            <span>Seats (blank = no limit)</span>
            <input inputMode="numeric" value={s.capacity} onChange={setSession(i, 'capacity')} />
          </label>
          <label className="field">
            <span>Price (SGD)</span>
            <input inputMode="decimal" required value={s.price} onChange={setSession(i, 'price')} placeholder="88" />
          </label>
          <label className="field">
            <span>Early bird price (optional)</span>
            <input inputMode="decimal" value={s.earlyPrice} onChange={setSession(i, 'earlyPrice')} placeholder="68" />
          </label>
        </fieldset>
      ))}
      <div className="span-all">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            const last = sessions[sessions.length - 1];
            setSessions([...sessions, { ...blankSession(last?.end, last?.end), price: last?.price ?? '', earlyPrice: last?.earlyPrice ?? '' }]);
          }}
        >
          Add a session
        </button>
      </div>

      {sessions.length > 1 && (
        <>
          <label className="field">
            <span>Bundle name</span>
            <input maxLength={60} value={f.bundleLabel} onChange={set('bundleLabel')} />
          </label>
          <label className="field">
            <span>Price for all sessions (blank = no bundle)</span>
            <input inputMode="decimal" value={f.bundlePrice} onChange={set('bundlePrice')} placeholder="148" />
          </label>
          <label className="field">
            <span>Early bird price for all</span>
            <input inputMode="decimal" value={f.bundleEarly} onChange={set('bundleEarly')} placeholder="118" disabled={!f.bundlePrice.trim()} />
          </label>
        </>
      )}
      <label className="field">
        <span>Early bird until (last day, inclusive)</span>
        <input type="date" value={f.earlyUntil} onChange={set('earlyUntil')} disabled={!anyEarly} />
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
  const checkedIn = paid.filter((o) => o.checkedInAt).reduce((n, o) => n + o.qty, 0);
  const revenue = paid.reduce((n, o) => n + o.amountCents, 0);
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
        {e.sessions.map((s) => {
          const sold = e.soldBySession?.[s.key] ?? 0;
          const left = seatsLeft(s.capacity, sold);
          return (
            <div className="tile" key={s.key}>
              <span className="tile-label">
                {s.title} · {clockOf(s.startAt, tz)}
              </span>
              <span className="tile-value">
                {sold}
                {s.capacity != null && <span className="muted"> / {s.capacity}</span>}
              </span>
              <span className="muted">{left !== null ? `${left} seats left` : 'attending'}</span>
            </div>
          );
        })}
        <div className="tile">
          <span className="tile-label">Taken in</span>
          <span className="tile-value">{formatMoney(revenue, e.currency)}</span>
          <span className="muted">{checkedIn} checked in</span>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>On sale now</th>
            <th>Until</th>
          </tr>
        </thead>
        <tbody>
          {e.options.map((o) => {
            const on = currentTier(o.prices, new Date(), tz);
            return (
              <tr key={o.key}>
                <td>{o.label}</td>
                <td>{on ? `${formatMoney(on.tier.priceCents, e.currency)} (${on.tier.label})` : 'Closed'}</td>
                <td>{on?.tier.until ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

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
              <th>Ticket</th>
              <th className="num">Qty</th>
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
                <td>
                  {o.optionLabel}
                  <br />
                  <span className="muted">{o.tierLabel}</span>
                </td>
                <td className="num">{o.qty}</td>
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
                  <td>{o.optionLabel}</td>
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
              <th>Sessions</th>
              <th className="num">Tickets sold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const past = e.endAt.toMillis() < now;
              return (
                <tr key={e.id} className={e.status === 'cancelled' || past ? 'cancelled' : ''}>
                  <td>
                    <Link to={`/events/${e.id}`}>{e.title}</Link>
                    {e.status === 'cancelled' ? <span className="badge badge-cancelled">cancelled</span> : !e.published && <span className="badge">draft</span>}
                  </td>
                  <td>{formatDateTime(e.startAt.toDate(), e.timeZone)}</td>
                  <td>{e.venue ?? <span className="muted">To be confirmed</span>}</td>
                  <td>{e.sessions.map((s) => s.title).join(', ')}</td>
                  <td className="num">{e.soldQty ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
