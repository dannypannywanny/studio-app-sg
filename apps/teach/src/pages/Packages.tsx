// S07 Packages: what the school sells. Staff edit these directly (rules allow it); prices and session
// counts on invoices already sold never change because each sale copies them.
import { addDoc, collection, doc, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { centsToDecimal, formatMoney, parseMoney } from '@lessonkaki/shared';
import { db } from '../firebase';
import { useQuery } from '../hooks';
import { useSchoolId } from '../session';
import type { Package, Subject } from '../types';

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
    </section>
  );
}
