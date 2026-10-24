// Leads: people who enquired or are coming for a trial, before they become students. A lead is a student
// record with status 'lead', so trial lessons use the normal calendar; it gets no portal login.
import { addDoc, collection, orderBy, query, serverTimestamp } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatDate, LEAD_STAGE_LABEL, wallClockToUtc, wallDateOf, type LeadStage } from '@lessonkaki/shared';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTimeZone, type WithId } from '../hooks';
import type { Lesson, Student } from '../types';
import { useSchoolId } from '../session';

function NewLeadForm({ onDone }: { onDone: () => void }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', notes: '', followUpOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Contact fields only, as for a new student: balances are function-maintained.
      const ref = await addDoc(collection(db, 'schools', schoolId, 'students'), {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        preferredName: null,
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        status: 'lead',
        lead: { stage: 'new', followUpOn: form.followUpOn || null, lostReason: null, closedAt: null },
        createdOn: wallDateOf(new Date(), tz),
        notes: form.notes.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      onDone();
      navigate(`/students/${ref.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field">
        <span>First name</span>
        <input required value={form.firstName} onChange={set('firstName')} />
      </label>
      <label className="field">
        <span>Last name</span>
        <input value={form.lastName} onChange={set('lastName')} />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" value={form.email} onChange={set('email')} />
      </label>
      <label className="field">
        <span>Phone</span>
        <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+65 …" />
      </label>
      <label className="field">
        <span>Follow up on (optional)</span>
        <input type="date" value={form.followUpOn} onChange={set('followUpOn')} />
      </label>
      <label className="field span-all">
        <span>Notes</span>
        <textarea rows={3} maxLength={5000} value={form.notes} onChange={set('notes')} placeholder="What they're after, how they found you…" />
      </label>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add lead'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

type Filter = 'open' | 'won' | 'lost';
const FILTERS: [Filter, string][] = [
  ['open', 'Open'],
  ['won', 'Won'],
  ['lost', 'Lost'],
];

/** Open = still a lead and not lost. Won leads are students now; their lead history stays. */
export function isOpenLead(s: Student): boolean {
  return s.status === 'lead' && s.lead?.stage !== 'lost';
}
const inFilter = (s: Student, f: Filter) => (f === 'open' ? isOpenLead(s) : s.lead?.stage === f);

/** Each lead's trial lessons. orderBy skips lessons without the field, so only lessons that had a trial load. */
function useTrialLessons() {
  const schoolId = useSchoolId();
  const lessons = useQuery<Lesson>(`trialLessons:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons'), orderBy('trialStudentIds')),
  );
  return useMemo(() => {
    const byLead = new Map<string, WithId<Lesson>[]>();
    for (const l of lessons.data) {
      if (l.status === 'cancelled') continue;
      for (const id of l.trialStudentIds ?? []) byLead.set(id, [...(byLead.get(id) ?? []), l]);
    }
    return byLead;
  }, [lessons.data]);
}

/** The soonest upcoming trial, else the latest one. */
function trialOf(list: WithId<Lesson>[] = []): WithId<Lesson> | undefined {
  const now = Date.now();
  const byStart = [...list].sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
  return byStart.find((l) => l.startAt.toMillis() >= now) ?? byStart.at(-1);
}

export function Leads() {
  const students = useStudents();
  const tz = useTimeZone();
  const today = wallDateOf(new Date(), tz);
  const trials = useTrialLessons();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const leads = useMemo(() => students.data.filter((s) => s.status === 'lead' || s.lead), [students.data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads
      .filter((s) => inFilter(s, filter))
      .filter((s) => !q || `${studentName(s)} ${s.email ?? ''} ${s.phone ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => (b.createdAt?.toMillis() ?? Infinity) - (a.createdAt?.toMillis() ?? Infinity));
  }, [leads, filter, search]);
  const showDate = (d: string) => formatDate(wallClockToUtc(d, '12:00', tz), tz);

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="muted">People interested in lessons. Book them a trial, then make them a student.</p>
        </div>
        {!adding && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New lead
          </button>
        )}
      </div>
      {adding && <NewLeadForm onDone={() => setAdding(false)} />}
      <div className="row">
        <div className="tabs" role="group" aria-label="Show">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" className={`tab ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label} · {leads.filter((s) => inFilter(s, f)).length}
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search by name, email or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {students.error && <p className="error">{students.error.message}</p>}
      {students.loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">{filter === 'open' ? 'No open leads. Add one when someone enquires.' : 'None yet.'}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Stage</th>
              <th>Trial</th>
              <th>{filter === 'lost' ? 'Reason' : filter === 'won' ? 'Won on' : 'Follow up'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const stage: LeadStage = s.lead?.stage ?? 'new';
              const t = trialOf(trials.get(s.id));
              const follow = s.lead?.followUpOn ?? null;
              return (
                <tr key={s.id}>
                  <td>
                    <Link to={`/students/${s.id}`}>{studentName(s)}</Link>
                  </td>
                  <td>{[s.email, s.phone].filter(Boolean).join(' · ') || '—'}</td>
                  <td>
                    <span className={`badge badge-${stage}`}>{LEAD_STAGE_LABEL[stage]}</span>
                  </td>
                  <td>{t ? `${formatDate(t.startAt.toDate(), tz)} · ${t.durationMin} min` : '—'}</td>
                  <td>
                    {filter === 'lost' ? (
                      (s.lead?.lostReason ?? '—')
                    ) : filter === 'won' ? (
                      s.lead?.closedAt ? formatDate(s.lead.closedAt.toDate(), tz) : '—'
                    ) : follow ? (
                      <span className={follow <= today ? 'badge badge-warn' : ''}>{showDate(follow)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
