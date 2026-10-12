// S13 Settings: school details, credit policy, branding (owner), subjects and locations (staff).
import { addDoc, collection, doc, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_POLICY, resolvePolicy, type Branding, type CreditPolicy } from '@lessonkaki/shared';
import { db } from '../firebase';
import { useQuery, useSchool } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Subject } from '../types';

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
  const data = school.data as unknown as Partial<SchoolFields> & { policy?: Partial<CreditPolicy>; branding?: Branding };
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
      <Section title="Branding" note={ownerNote ?? 'Colours, fonts and logo for this school. Leave blank to use the LessonKaki defaults.'}>
        <BrandingForm branding={data.branding ?? {}} canEdit={isOwner} />
      </Section>
      <Section title="Subjects">
        <NamedList<Subject>
          path="subjects"
          label="subject"
          extra={(s) => `${s.defaultDurationMin ?? 60} min default`}
          make={(name) => ({ name, teacherIds: [], defaultDurationMin: 60 })}
        />
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
