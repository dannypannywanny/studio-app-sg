// S07 Packages: what the school sells. Staff edit these directly (rules allow it); prices and session
// counts on invoices already sold never change because each sale copies them.
import { addDoc, collection, doc, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { centsToDecimal, formatMoney, parseMoney } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { useQuery } from '../hooks';
import { useSchoolId } from '../session';
import type { DiscountCode, Package, Subject } from '../types';

type Kind = 'paid' | 'trial' | 'single';
const KIND_LABEL: Record<Kind, string> = { paid: 'Package', trial: 'Trial', single: 'Single lesson' };

type Row = Package & { id: string; subjectId?: string; kind?: Kind; sellsOnline?: boolean };

function PackageForm({ initial, subjects, onDone }: { initial: Row | null; subjects: (Subject & { id: string })[]; onDone: () => void }) {
  const schoolId = useSchoolId();
  const [name, setName] = useState(initial?.name ?? '');
  const [subjectId, setSubjectId] = useState(initial?.subjectId ?? subjects[0]?.id ?? '');
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'paid');
  const [sessions, setSessions] = useState(initial?.sessions ?? 4);
  const [price, setPrice] = useState(initial ? centsToDecimal(initial.priceCents) : '');
  const [validityDays, setValidity] = useState(initial?.validityDays ? String(initial.validityDays) : '');
  const [sellsOnline, setSellsOnline] = useState(initial?.sellsOnline ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const priceCents = parseMoney(price);
    if (priceCents === null) return setError('Enter a price like 300 or 299.50.');
    if (!Number.isInteger(sessions) || sessions < 1 || sessions > 200) return setError('Sessions must be 1 to 200.');
    const days = validityDays.trim() ? Number(validityDays) : null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return setError('Validity must be 1 to 3650 days, or blank.');
    setBusy(true);
    setError(null);
    const data = {
      name: name.trim(),
      subjectId,
      kind,
      sessions,
      priceCents,
      validityDays: days,
      sellsOnline,
      oncePerStudent: kind === 'trial',
      updatedAt: serverTimestamp(),
    };
    try {
      if (initial) await updateDoc(doc(db, 'schools', schoolId, 'packages', initial.id), data);
      else await addDoc(collection(db, 'schools', schoolId, 'packages'), { ...data, active: true, createdAt: serverTimestamp() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field span-all">
        <span>Name</span>
        <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 4 Sessions" />
      </label>
      <label className="field">
        <span>Subject</span>
        <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Sessions</span>
        <input type="number" min={1} max={200} required value={sessions} onChange={(e) => setSessions(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Price (SGD)</span>
        <input inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label className="field">
        <span>Valid for (days, blank = no expiry)</span>
        <input inputMode="numeric" value={validityDays} onChange={(e) => setValidity(e.target.value)} />
      </label>
      <label className="field checkbox">
        <input type="checkbox" checked={sellsOnline} onChange={(e) => setSellsOnline(e.target.checked)} />
        <span>Sold on the booking page (M5)</span>
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Save package' : 'Add package'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

const saveDiscountCode = call<
  {
    schoolId: string;
    code: string;
    kind: 'percent' | 'amount';
    value: number;
    packageIds: string[];
    validUntil: string | null;
    maxUses: number | null;
    active: boolean;
  },
  { code: string }
>('saveDiscountCode');

const describeOff = (c: DiscountCode) => (c.kind === 'percent' ? `${c.value}% off` : `${formatMoney(c.value)} off`);

function DiscountCodeForm({ initial, packages, onDone }: { initial: (DiscountCode & { id: string }) | null; packages: Row[]; onDone: () => void }) {
  const schoolId = useSchoolId();
  const [code, setCode] = useState(initial?.id ?? '');
  const [kind, setKind] = useState<'percent' | 'amount'>(initial?.kind ?? 'percent');
  const [value, setValue] = useState(initial ? (initial.kind === 'percent' ? String(initial.value) : centsToDecimal(initial.value)) : '');
  const [packageIds, setPackageIds] = useState<string[]>(initial?.packageIds ?? []);
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? '');
  const [maxUses, setMaxUses] = useState(initial?.maxUses ? String(initial.maxUses) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amount = kind === 'percent' ? Number(value) : parseMoney(value);
    if (amount === null || !Number.isFinite(amount) || amount <= 0) return setError(kind === 'percent' ? 'Enter a percentage from 1 to 100.' : 'Enter an amount like 50 or 49.90.');
    const uses = maxUses.trim() ? Number(maxUses) : null;
    if (uses !== null && (!Number.isInteger(uses) || uses < 1)) return setError('Uses must be a whole number, or blank for no limit.');
    setBusy(true);
    setError(null);
    try {
      await saveDiscountCode({
        schoolId,
        code,
        kind,
        value: amount,
        packageIds,
        validUntil: validUntil || null,
        maxUses: uses,
        active: initial?.active ?? true,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field">
        <span>Code</span>
        <input required maxLength={40} value={code} disabled={!!initial} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 1010promo" autoCapitalize="characters" />
      </label>
      <div className="field">
        <span>Discount</span>
        <div className="row discount-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'percent' | 'amount')} aria-label="Discount type">
            <option value="percent">%</option>
            <option value="amount">Amount</option>
          </select>
          <input required inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Discount value" />
        </div>
      </div>
      <fieldset className="field span-all">
        <legend>Valid for (none ticked = every package)</legend>
        {packages
          .filter((p) => p.active !== false)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => (
            <label key={p.id} className="row">
              <input
                type="checkbox"
                checked={packageIds.includes(p.id)}
                onChange={(e) => setPackageIds(e.target.checked ? [...packageIds, p.id] : packageIds.filter((x) => x !== p.id))}
              />
              <span>
                {p.name} · {formatMoney(p.priceCents)}
              </span>
            </label>
          ))}
      </fieldset>
      <label className="field">
        <span>Last day (blank = no end)</span>
        <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </label>
      <label className="field">
        <span>Times it can be used (blank = unlimited)</span>
        <input inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Save code' : 'Add code'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

function DiscountCodes({ packages }: { packages: Row[] }) {
  const schoolId = useSchoolId();
  const codes = useQuery<DiscountCode>(`discountCodes:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'discountCodes')));
  const [editing, setEditing] = useState<(DiscountCode & { id: string }) | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const packageName = new Map(packages.map((p) => [p.id, p.name]));
  const rows = [...codes.data].sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || a.id.localeCompare(b.id));

  async function toggle(c: DiscountCode & { id: string }) {
    setError(null);
    try {
      await saveDiscountCode({
        schoolId,
        code: c.id,
        kind: c.kind,
        value: c.value,
        packageIds: c.packageIds ?? [],
        validUntil: c.validUntil ?? null,
        maxUses: c.maxUses ?? null,
        active: c.active === false,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="stack">
      <div className="page-head">
        <h2>Discount codes</h2>
        {!editing && (
          <button className="btn" onClick={() => setEditing('new')}>
            New code
          </button>
        )}
      </div>
      <p className="muted">Students type a code on the buy page; you can also pick one when selling a package from a student's page.</p>
      {editing && (
        <DiscountCodeForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? null : editing} packages={packages} onDone={() => setEditing(null)} />
      )}
      {(codes.error || error) && <p className="error">{(codes.error ?? { message: error }).message}</p>}
      {rows.length === 0 ? (
        <p className="empty">No discount codes yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Discount</th>
              <th>Packages</th>
              <th>Last day</th>
              <th className="num">Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.active === false ? 'cancelled' : ''}>
                <td>{c.id}</td>
                <td>{describeOff(c)}</td>
                <td>{c.packageIds?.length ? c.packageIds.map((id) => packageName.get(id) ?? id).join(', ') : 'All packages'}</td>
                <td>{c.validUntil ?? '—'}</td>
                <td className="num">
                  {c.usedCount ?? 0}
                  {c.maxUses ? ` / ${c.maxUses}` : ''}
                </td>
                <td>
                  <div className="row">
                    <button className="btn btn-sm" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => void toggle(c)}>
                      {c.active === false ? 'Turn on' : 'Turn off'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Packages() {
  const schoolId = useSchoolId();
  const packages = useQuery<Row>(`allPackages:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'packages')));
  const subjects = useQuery<Subject>(`subjects:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'subjects')));
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const subjectName = new Map(subjects.data.map((s) => [s.id, s.name]));
  const rows = packages.data
    .filter((p) => showArchived || p.active !== false)
    .sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || a.name.localeCompare(b.name));

  const setActive = (p: Row, active: boolean) =>
    updateDoc(doc(db, 'schools', schoolId, 'packages', p.id), { active, updatedAt: serverTimestamp() });

  return (
    <section className="stack">
      <div className="page-head">
        <h1>Packages</h1>
        {!editing && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            New package
          </button>
        )}
      </div>
      {editing && (
        <PackageForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          subjects={subjects.data}
          onDone={() => setEditing(null)}
        />
      )}
      <label className="row muted">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
      </label>
      {packages.error && <p className="error">{packages.error.message}</p>}
      {rows.length === 0 ? (
        <p className="empty">No packages yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Subject</th>
              <th>Type</th>
              <th className="num">Sessions</th>
              <th className="num">Price</th>
              <th className="num">Per session</th>
              <th>Valid for</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.active === false ? 'cancelled' : ''}>
                <td>
                  {p.name}
                  {p.sellsOnline && <span className="badge">online</span>}
                </td>
                <td>{subjectName.get(p.subjectId ?? '') ?? '—'}</td>
                <td>{KIND_LABEL[p.kind ?? 'paid']}</td>
                <td className="num">{p.sessions}</td>
                <td className="num">{formatMoney(p.priceCents)}</td>
                <td className="num">{formatMoney(Math.round(p.priceCents / p.sessions))}</td>
                <td>{p.validityDays ? `${p.validityDays} days` : 'No expiry'}</td>
                <td>
                  <div className="row">
                    <button className="btn btn-sm" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setActive(p, p.active === false)}>
                      {p.active === false ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <DiscountCodes packages={packages.data} />
    </section>
  );
}
