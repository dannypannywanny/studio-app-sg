// Settings: each teacher's online booking hours (schools/{s}/availability/{teacherId}), which the learn
// site turns into open slots. Staff and the teacher themself may write it (rules); the functions read
// it through resolveAvailability, which drops anything malformed.
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import {
  AVAILABILITY_DEFAULTS,
  WEEKDAYS,
  formatDateTime,
  isWallDate,
  openSlots,
  resolveAvailability,
  type HoursException,
  type WeeklyHours,
  type Weekday,
} from '@lessonkaki/shared';
import { db } from '../firebase';
import { useDoc, useTeachers, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';

const DAY_NAMES: Record<Weekday, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const NUMBERS = [
  ['lessonMin', 'Lesson length (min)'],
  ['stepMin', 'Start times every (min)'],
  ['bufferMin', 'Gap around other lessons (min)'],
  ['minNoticeHours', 'Book at least (hours ahead)'],
  ['horizonDays', 'Book up to (days ahead)'],
] as const;
type NumberKey = (typeof NUMBERS)[number][0];

interface Draft {
  bookable: boolean;
  weekly: WeeklyHours[];
  closed: string[];
  numbers: Record<NumberKey, number>;
}

function draftFrom(raw: unknown): Draft {
  const av = resolveAvailability(raw);
  return {
    bookable: raw ? av.bookable : false,
    weekly: av.weekly,
    closed: av.exceptions.filter((e) => e.closed).map((e) => e.date),
    numbers: { lessonMin: av.lessonMin, stepMin: av.stepMin, bufferMin: av.bufferMin, minNoticeHours: av.minNoticeHours, horizonDays: av.horizonDays },
  };
}

function TeacherHours({ teacherId, name }: { teacherId: string; name: string }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const stored = useDoc<Record<string, unknown>>(`schools/${schoolId}/availability/${teacherId}`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newClosed, setNewClosed] = useState('');
  const [state, setState] = useState<{ busy: boolean; saved: boolean; error: string | null }>({ busy: false, saved: false, error: null });

  useEffect(() => {
    if (!stored.loading && !draft) setDraft(draftFrom(stored.data));
  }, [stored.loading, stored.data, draft]);
  if (!draft) return <p className="muted">Loading…</p>;

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setState({ busy: false, saved: false, error: null });
  };
  const setRow = (i: number, patch: Partial<WeeklyHours>) => set({ weekly: draft.weekly.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  // Keep anything the form doesn't edit (replacement-hours exceptions, subject) as it was.
  const keptExceptions = resolveAvailability(stored.data).exceptions.filter((e) => !e.closed);
  const doc_ = {
    bookable: draft.bookable,
    weekly: draft.weekly,
    exceptions: [...keptExceptions, ...draft.closed.map((date): HoursException => ({ date, closed: true }))],
    ...draft.numbers,
  };
  const resolved = resolveAvailability(doc_);
  const invalid = resolved.weekly.length !== draft.weekly.length;
  const preview = openSlots(resolved, { timeZone: tz, now: new Date(), busy: [] }).slice(0, 4);

  async function save() {
    setState({ busy: true, saved: false, error: null });
    try {
      await setDoc(doc(db, 'schools', schoolId, 'availability', teacherId), { ...doc_, updatedAt: serverTimestamp() }, { merge: true });
      setState({ busy: false, saved: true, error: null });
    } catch (err) {
      setState({ busy: false, saved: false, error: (err as Error).message });
    }
  }

  return (
    <div className="stack">
      <h3>{name}</h3>
      <div className="row">
        <label className="field checkbox">
          <input type="checkbox" checked={draft.bookable} onChange={(e) => set({ bookable: e.target.checked })} />
          <span>Students can book {name} online</span>
        </label>
      </div>
      {draft.weekly.map((w, i) => (
        <div className="row" key={i}>
          <select value={w.day} onChange={(e) => setRow(i, { day: e.target.value as Weekday })} aria-label="Day">
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {DAY_NAMES[d]}
              </option>
            ))}
          </select>
          <input type="time" value={w.start} onChange={(e) => setRow(i, { start: e.target.value })} aria-label="From" />
          <span className="muted">to</span>
          <input type="time" value={w.end} onChange={(e) => setRow(i, { end: e.target.value })} aria-label="Until" />
          <label className="field checkbox">
            <input type="checkbox" checked={w.inPerson} onChange={(e) => setRow(i, { inPerson: e.target.checked, locationId: e.target.checked ? (w.locationId ?? 'studio') : null })} />
            <span>In person</span>
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={w.online} onChange={(e) => setRow(i, { online: e.target.checked })} />
            <span>Online</span>
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => set({ weekly: draft.weekly.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => set({ weekly: [...draft.weekly, { day: 'MO', start: '10:00', end: '18:00', inPerson: true, online: true, locationId: 'studio' }] })}
        >
          Add hours
        </button>
      </div>
      <div className="form-grid">
        {NUMBERS.map(([key, label]) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              type="number"
              min={key === 'minNoticeHours' || key === 'bufferMin' ? 0 : 1}
              value={draft.numbers[key]}
              onChange={(e) => set({ numbers: { ...draft.numbers, [key]: Number(e.target.value || AVAILABILITY_DEFAULTS[key]) } })}
            />
          </label>
        ))}
      </div>
      <div className="row">
        <span className="muted">Closed dates:</span>
        {draft.closed.length === 0 && <span className="muted">none</span>}
        {draft.closed.map((d) => (
          <button key={d} type="button" className="btn btn-ghost" onClick={() => set({ closed: draft.closed.filter((c) => c !== d) })} title="Remove">
            {d} ×
          </button>
        ))}
        <input type="date" value={newClosed} onChange={(e) => setNewClosed(e.target.value)} aria-label="Closed date" />
        <button
          type="button"
          className="btn"
          disabled={!isWallDate(newClosed)}
          onClick={() => {
            if (!draft.closed.includes(newClosed)) set({ closed: [...draft.closed, newClosed].sort() });
            setNewClosed('');
          }}
        >
          Close this date
        </button>
      </div>
      {invalid ? (
        <p className="error">Check the hours: each row needs an end after its start, and in person or online ticked.</p>
      ) : (
        <p className="muted">
          {preview.length
            ? `Next open times (before existing lessons): ${preview.map((s) => formatDateTime(s.startAt, tz)).join('; ')}`
            : 'No open times with these settings.'}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={save} disabled={state.busy || invalid}>
          {state.busy ? 'Saving…' : 'Save hours'}
        </button>
        {state.saved && <span className="success">Saved.</span>}
        {state.error && <span className="error">{state.error}</span>}
      </div>
    </div>
  );
}

export function BookingHours() {
  const teachers = useTeachers();
  const active = teachers.data.filter((t) => t.active !== false);
  if (teachers.loading) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      {active.map((t) => (
        <TeacherHours key={t.id} teacherId={t.id} name={t.displayName} />
      ))}
    </div>
  );
}
