// Time off: blocks on a teacher's calendar (availability/{teacherId}.timeOff). Online booking never offers a
// slot inside one. Lessons already in that time are left alone.
import { arrayRemove, arrayUnion, collection, doc, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { resolveAvailability, type TimeOff } from '@lessonkaki/shared';
import { db } from '../firebase';
import { useQuery, useTeachers } from '../hooks';
import { useSchoolId, useSession } from '../session';

export interface PlacedOff {
  teacherId: string;
  teacherName: string;
  /** The entry exactly as stored, so arrayRemove matches it. */
  raw: Record<string, unknown>;
  entry: TimeOff;
  allDay: boolean;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const offStartMin = (t: TimeOff) => minutes(t.start);
export const offEndMin = (t: TimeOff) => (t.end === '24:00' ? 24 * 60 : minutes(t.end));
export const offLabel = (o: PlacedOff) => (o.allDay ? 'All day' : `${o.entry.start}–${o.entry.end}`);

/** Every teacher's time off, keyed by date. */
export function useTimeOff() {
  const schoolId = useSchoolId();
  const teachers = useTeachers();
  const live = useQuery<Record<string, unknown>>(`availability:${schoolId}`, () =>
    query(collection(db, 'schools', schoolId, 'availability')),
  );
  return useMemo(() => {
    const out: PlacedOff[] = [];
    for (const d of live.data) {
      const raw = (Array.isArray(d.timeOff) ? d.timeOff : []) as Record<string, unknown>[];
      const valid = new Map(resolveAvailability(d).timeOff.map((t) => [t.id, t]));
      for (const r of raw) {
        const entry = valid.get(r.id as string);
        if (!entry) continue;
        out.push({
          teacherId: d.id,
          teacherName: teachers.byId.get(d.id)?.displayName ?? 'Teacher',
          raw: r,
          entry,
          allDay: entry.start === '00:00' && entry.end === '24:00',
        });
      }
    }
    return out.sort((a, b) => (a.entry.date + a.entry.start).localeCompare(b.entry.date + b.entry.start));
  }, [live.data, teachers.byId]);
}

export function TimeOffForm({ initialDate, onDone }: { initialDate: string; onDone: () => void }) {
  const schoolId = useSchoolId();
  const { role, teacherId: me } = useSession();
  const teachers = useTeachers();
  const choices = teachers.data.filter((t) => t.active !== false && (role !== 'teacher' || t.id === me));
  const [teacherId, setTeacherId] = useState(me ?? '');
  const [date, setDate] = useState(initialDate);
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState('12:00');
  const [end, setEnd] = useState('14:00');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = teacherId || choices[0]?.id || '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!who) return setError('Pick a teacher.');
    if (!allDay && end <= start) return setError('The end time must be after the start.');
    setBusy(true);
    setError(null);
    const entry = {
      id: crypto.randomUUID(),
      date,
      start: allDay ? '00:00' : start,
      end: allDay ? '24:00' : end,
      note: note.trim() || null,
    };
    try {
      await setDoc(
        doc(db, 'schools', schoolId, 'availability', who),
        { timeOff: arrayUnion(entry), updatedAt: serverTimestamp() },
        { merge: true },
      );
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2 className="span-all">Block time off</h2>
      {choices.length > 1 && (
        <label className="field">
          <span>Teacher</span>
          <select value={who} onChange={(e) => setTeacherId(e.target.value)}>
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Date</span>
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {!allDay && (
        <>
          <label className="field">
            <span>From</span>
            <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="field">
            <span>Until</span>
            <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </>
      )}
      <label className="field checkbox">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <span>All day</span>
      </label>
      <label className="field span-all">
        <span>Note (optional, staff only)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="e.g. Dentist, holiday" />
      </label>
      <p className="muted span-all">Students can't book this time online. Lessons already in it stay as they are.</p>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Block this time'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

/** Shown when a block on the calendar is clicked. */
export function TimeOffDetail({ off, onDone }: { off: PlacedOff; onDone: () => void }) {
  const schoolId = useSchoolId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'schools', schoolId, 'availability', off.teacherId), {
        timeOff: arrayRemove(off.raw),
        updatedAt: serverTimestamp(),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const when = new Date(`${off.entry.date}T12:00:00Z`).toLocaleDateString('en-SG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return (
    <div className="card stack">
      <h2>Time off</h2>
      <p>
        <strong>{off.teacherName}</strong> · {when} · {offLabel(off)}
        {off.entry.note && <span className="muted"> · {off.entry.note}</span>}
      </p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void remove()}>
          {busy ? 'Removing…' : 'Remove time off'}
        </button>
        <button className="btn btn-ghost" onClick={onDone}>
          Close
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
