// S13 Settings: school details, credit policy, email alerts, branding (owner), subjects and locations (staff).
import { addDoc, collection, doc, limit, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ALERT_CATEGORIES,
  ALERT_CATEGORY_LABELS,
  DEFAULT_POLICY,
  MAX_ALERT_RECIPIENTS,
  formatDateTime,
  isEmail,
  resolveAlertSettings,
  resolvePolicy,
  type AlertSettings,
  type Branding,
  type CreditPolicy,
} from '@lessonkaki/shared';
import { BookingHours } from '../components/BookingHours';
import { LessonTypesEditor } from '../components/LessonTypes';
import { db } from '../firebase';
import { useQuery, useSchool } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Ts } from '../types';

function Section({ title, children, note }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="card stack">
      <h2>{title}</h2>
      {note && <p className="muted">{note}</p>}
      {children}
    </div>
  );
}

/** Saves a partial update to the school doc (owner only by the rules). */
function useSaveSchool() {
  const schoolId = useSchoolId();
  const [state, setState] = useState<{ busy: boolean; saved: boolean; error: string | null }>({ busy: false, saved: false, error: null });
  async function save(data: Record<string, unknown>) {
    setState({ busy: true, saved: false, error: null });
    try {
      await updateDoc(doc(db, 'schools', schoolId), { ...data, updatedAt: serverTimestamp() });
      setState({ busy: false, saved: true, error: null });
    } catch (err) {
      setState({ busy: false, saved: false, error: (err as Error).message });
    }
  }
  return { ...state, save };
}

function SaveRow({ busy, saved, error, disabled }: { busy: boolean; saved: boolean; error: string | null; disabled: boolean }) {
  return (
    <div className="form-actions">
      <button className="btn btn-primary" disabled={busy || disabled}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {saved && <span className="success">Saved.</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

interface SchoolFields {
  name: string;
  legalName: string;
  uen: string;
  email: string;
  address: string;
  invoicePrefix: string;
  paynowName: string;
}

function SchoolDetails({ school, canEdit }: { school: Partial<SchoolFields>; canEdit: boolean }) {
  const [f, setF] = useState<SchoolFields>({
    name: school.name ?? '',
    legalName: school.legalName ?? '',
    uen: school.uen ?? '',
    email: school.email ?? '',
    address: school.address ?? '',
    invoicePrefix: school.invoicePrefix ?? 'INV',
    paynowName: school.paynowName ?? '',
  });
  const s = useSaveSchool();
  const set = (k: keyof SchoolFields) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  function submit(e: FormEvent) {
    e.preventDefault();
    void s.save({
      name: f.name.trim(),
      legalName: f.legalName.trim() || null,
      uen: f.uen.trim().toUpperCase() || null,
      email: f.email.trim().toLowerCase() || null,
      address: f.address.trim() || null,
      invoicePrefix: f.invoicePrefix.trim().toUpperCase() || 'INV',
      paynowName: f.paynowName.trim() || null,
    });
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <fieldset disabled={!canEdit} className="form-grid span-all fieldset-plain">
        <label className="field">
          <span>Name</span>
          <input required value={f.name} onChange={set('name')} />
        </label>
        <label className="field">
          <span>Legal name (on invoices)</span>
          <input value={f.legalName} onChange={set('legalName')} />
        </label>
        <label className="field">
          <span>UEN (PayNow)</span>
          <input value={f.uen} onChange={set('uen')} pattern="[0-9A-Za-z]{9,10}" />
        </label>
        <label className="field">
          <span>PayNow payee name</span>
          <input value={f.paynowName} maxLength={25} onChange={set('paynowName')} />
        </label>
        <label className="field">
          <span>Contact email</span>
          <input type="email" value={f.email} onChange={set('email')} />
        </label>
        <label className="field">
          <span>Invoice number prefix</span>
          <input value={f.invoicePrefix} maxLength={8} onChange={set('invoicePrefix')} />
        </label>
        <label className="field span-all">
          <span>Address (on invoices)</span>
          <input value={f.address} onChange={set('address')} />
        </label>
      </fieldset>
      {canEdit && <SaveRow {...s} disabled={false} />}
    </form>
  );
}

function PolicyForm({ policy, canEdit }: { policy: CreditPolicy; canEdit: boolean }) {
  const [p, setP] = useState(policy);
  const s = useSaveSchool();
  const toggle = (k: 'lateCancelReturnsCredit' | 'absentConsumesCredit' | 'allowOwedLessons') => (
    <label className="field checkbox span-all">
      <input type="checkbox" checked={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.checked })} />
      <span>
        {
          {
            lateCancelReturnsCredit: 'A late cancel gives the credit back',
            absentConsumesCredit: 'A no-show uses a credit',
            allowOwedLessons: 'With no credits left, lessons go ahead and are recorded as owed',
          }[k]
        }
      </span>
    </label>
  );
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        void s.save({ policy: { ...DEFAULT_POLICY, ...p } });
      }}
    >
      <fieldset disabled={!canEdit} className="form-grid span-all fieldset-plain">
        <label className="field">
          <span>Late cancel inside (hours before start)</span>
          <input
            type="number"
            min={0}
            max={168}
            value={p.lateCancelHours}
            onChange={(e) => setP({ ...p, lateCancelHours: Number(e.target.value) })}
          />
        </label>
        {toggle('lateCancelReturnsCredit')}
        {toggle('absentConsumesCredit')}
        {toggle('allowOwedLessons')}
      </fieldset>
      {canEdit && <SaveRow {...s} disabled={false} />}
    </form>
  );
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  'lesson.booked': 'Lesson booked',
  'series.booked': 'Weekly lessons booked',
  'attendee.cancelled': 'Cancellation',
  'attendee.removed': 'Taken off a lesson',
  'lesson.cancelled': 'Lesson cancelled',
  'series.cancelled': 'Weekly lessons ended',
  'payment.recorded': 'Payment recorded',
  'payment.succeeded': 'Payment received online',
  'payment.failed': 'Online payment failed',
  'payment.abandoned': 'Online payment not completed',
};

const ALERT_STATUS_LABELS: Record<string, string> = { pending: 'Sending', sent: 'Sent', skipped: 'Not sent', failed: 'Failed' };

function AlertsForm({ settings, canEdit }: { settings: AlertSettings; canEdit: boolean }) {
  const [to, setTo] = useState(settings.to.join(', '));
  const [events, setEvents] = useState(settings.events);
  const [skipStaff, setSkipStaff] = useState(settings.skipStaffActions);
  const [invalid, setInvalid] = useState<string | null>(null);
  const s = useSaveSchool();
  function submit(e: FormEvent) {
    e.preventDefault();
    const list = [...new Set(to.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const bad = list.filter((x) => !isEmail(x));
    if (bad.length) return setInvalid(`Not an email address: ${bad.join(', ')}`);
    if (list.length > MAX_ALERT_RECIPIENTS) return setInvalid(`Up to ${MAX_ALERT_RECIPIENTS} addresses`);
    setInvalid(null);
    void s.save({ alerts: { to: list, events, skipStaffActions: skipStaff } });
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <fieldset disabled={!canEdit} className="form-grid span-all fieldset-plain">
        <label className="field span-all">
          <span>Send to (separate several addresses with commas)</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
        </label>
        {ALERT_CATEGORIES.map((c) => (
          <label key={c} className="field checkbox span-all">
            <input type="checkbox" checked={events[c]} onChange={(e) => setEvents({ ...events, [c]: e.target.checked })} />
            <span>
              {ALERT_CATEGORY_LABELS[c].label} <span className="muted">({ALERT_CATEGORY_LABELS[c].hint})</span>
            </span>
          </label>
        ))}
        <label className="field checkbox span-all">
          <input type="checkbox" checked={skipStaff} onChange={(e) => setSkipStaff(e.target.checked)} />
          <span>Skip changes made by staff in this app (only email about what students and online payments do)</span>
        </label>
      </fieldset>
      {invalid && <p className="error span-all">{invalid}</p>}
      {canEdit && <SaveRow {...s} disabled={false} />}
    </form>
  );
}

interface AlertRow {
  type: string;
  status: string;
  skipReason?: string;
  lastError?: string;
  createdAt?: Ts;
}

function RecentAlerts({ timeZone }: { timeZone: string }) {
  const schoolId = useSchoolId();
  const rows = useQuery<AlertRow>(`alerts:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'alerts'), orderBy('createdAt', 'desc'), limit(8)),
  );
  if (rows.loading || rows.data.length === 0) return null;
  return (
    <table className="table">
      <tbody>
        {rows.data.map((r) => (
          <tr key={r.id}>
            <td>{ALERT_TYPE_LABELS[r.type] ?? r.type}</td>
            <td className="muted">{r.createdAt ? formatDateTime(r.createdAt.toDate(), timeZone) : ''}</td>
            <td className={r.status === 'failed' ? 'error' : 'muted'} title={r.lastError ?? r.skipReason ?? ''}>
              {ALERT_STATUS_LABELS[r.status] ?? r.status}
              {r.status === 'skipped' && r.skipReason ? ` (${r.skipReason})` : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BrandingForm({ branding, canEdit }: { branding: Branding; canEdit: boolean }) {
  const [primary, setPrimary] = useState(branding.colors?.primary ?? '#4338ca');
  const [hover, setHover] = useState(branding.colors?.primaryHover ?? '#3730a3');
  const [display, setDisplay] = useState(branding.fonts?.display ?? '');
  const [body, setBody] = useState(branding.fonts?.body ?? '');
  const [logoUrl, setLogoUrl] = useState(branding.logoUrl ?? '');
  const [radius, setRadius] = useState(branding.buttonRadius ?? 6);
  const s = useSaveSchool();
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        void s.save({
          branding: {
            ...branding,
            colors: { ...(branding.colors ?? {}), primary, primaryHover: hover },
            fonts: { display: display.trim() || null, body: body.trim() || null },
            logoUrl: logoUrl.trim() || null,
            buttonRadius: radius,
          },
        });
      }}
    >
      <fieldset disabled={!canEdit} className="form-grid span-all fieldset-plain">
        <label className="field">
          <span>Main colour</span>
          <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
        </label>
        <label className="field">
          <span>Hover colour</span>
          <input type="color" value={hover} onChange={(e) => setHover(e.target.value)} />
        </label>
        <label className="field">
          <span>Heading font (Google Fonts)</span>
          <input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="Playfair Display" />
        </label>
        <label className="field">
          <span>Body font (Google Fonts)</span>
          <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Roboto" />
        </label>
        <label className="field">
          <span>Button corners (px)</span>
          <input type="number" min={0} max={40} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </label>
        <label className="field span-all">
          <span>Logo URL (https)</span>
          <input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
        </label>
      </fieldset>
      {canEdit && <SaveRow {...s} disabled={false} />}
    </form>
  );
}

interface Location {
  name: string;
  publicName?: string;
  address?: string;
  isOnline: boolean;
  active: boolean;
}

/** A simple list editor for subjects and locations. */
function NamedList<T extends { name: string; active: boolean }>({
  path,
  label,
  extra,
  make,
}: {
  path: 'subjects' | 'locations';
  label: string;
  extra: (row: T & { id: string }) => ReactNode;
  make: (name: string) => Record<string, unknown>;
}) {
  const schoolId = useSchoolId();
  const rows = useQuery<T>(`${path}:${schoolId}`, () => query(collection(db, 'schools', schoolId, path)));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await addDoc(collection(db, 'schools', schoolId, path), { ...make(name.trim()), active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const toggle = (id: string, active: boolean) => updateDoc(doc(db, 'schools', schoolId, path, id), { active, updatedAt: serverTimestamp() });
  return (
    <div className="stack">
      <table className="table">
        <tbody>
          {rows.data.map((r) => (
            <tr key={r.id} className={r.active === false ? 'cancelled' : ''}>
              <td>{r.name}</td>
              <td className="muted">{extra(r)}</td>
              <td>
                <button className="btn btn-sm btn-ghost" onClick={() => void toggle(r.id, r.active === false)}>
                  {r.active === false ? 'Restore' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" onSubmit={add}>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${label}`} aria-label={`New ${label}`} />
        <button className="btn btn-sm">Add</button>
        {error && <span className="error">{error}</span>}
      </form>
    </div>
  );
}

export function Settings() {
  const school = useSchool();
  const { role } = useSession();
  const isOwner = role === 'owner';
  if (school.loading || !school.data) return <p className="muted">Loading…</p>;
  const data = school.data as unknown as Partial<SchoolFields> & {
    policy?: Partial<CreditPolicy>;
    branding?: Branding;
    alerts?: Partial<AlertSettings>;
    timezone?: string;
  };
  const ownerNote = isOwner ? undefined : 'Only the owner can change this.';

  return (
    <section className="stack">
      <h1>Settings</h1>
      <Section title="School" note={ownerNote}>
        <SchoolDetails school={data} canEdit={isOwner} />
      </Section>
      <Section title="Credit rules" note={ownerNote ?? 'Applies to attendance marked from now on. Past charges are not recalculated.'}>
        <PolicyForm policy={resolvePolicy(data.policy)} canEdit={isOwner} />
      </Section>
      <Section
        title="Email alerts"
        note={ownerNote ?? 'Emails like the ones Classcard sent: bookings, cancellations and payments. Recent alerts are listed below.'}
      >
        <AlertsForm settings={resolveAlertSettings(data.alerts, data.email)} canEdit={isOwner} />
        {(role === 'owner' || role === 'admin') && <RecentAlerts timeZone={data.timezone ?? 'Asia/Singapore'} />}
      </Section>
      {(role === 'owner' || role === 'admin') && (
        <Section title="Online booking hours" note="When students can book on the student portal. Times already taken by a lesson are never offered.">
          <BookingHours />
        </Section>
      )}
      <Section title="Branding" note={ownerNote ?? 'Colours, fonts and logo for this school. Leave blank to use the LessonKaki defaults.'}>
        <BrandingForm branding={data.branding ?? {}} canEdit={isOwner} />
      </Section>
      <Section title="Lessons offered" note="Each subject's lengths and who teaches it. New lessons are picked from these, e.g. “Voice lessons with Daniel · 45 min”.">
        <LessonTypesEditor />
      </Section>
      <Section title="Locations">
        <NamedList<Location>
          path="locations"
          label="location"
          extra={(l) => (l.isOnline ? 'Online' : (l.address ?? ''))}
          make={(name) => ({ name, publicName: name, address: null, isOnline: /online|zoom/i.test(name) })}
        />
      </Section>
    </section>
  );
}
