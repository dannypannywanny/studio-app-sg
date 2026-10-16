// What a school offers: each subject has its lengths (e.g. 30, 45, 60 min) and the teachers who teach it.
// A "lesson type" is one teacher + subject + length, e.g. "Voice lessons with Daniel · 45 min"; picking one
// fills in the teacher, subject and minutes of a new lesson.
// Teachers are linked both ways (subjects.teacherIds and teachers.subjectIds, which online booking reads), so
// the editor updates both. Settings only, no money: plain updates, and saving again repairs a half-done save.
import { addDoc, arrayRemove, arrayUnion, collection, doc, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useMemo, useState, type FormEvent } from 'react';
import { db } from '../firebase';
import { useQuery, useTeachers, type WithId } from '../hooks';
import { useSchoolId } from '../session';
import type { Subject, Teacher } from '../types';

export interface LessonType {
  key: string;
  teacherId: string;
  subjectId: string;
  durationMin: number;
  /** The subject's usual length: the form starts on this one. */
  isDefault: boolean;
  label: string;
}

export const durationsOf = (s: Subject): number[] =>
  s.durations?.length ? [...s.durations].sort((a, b) => a - b) : [s.defaultDurationMin || 60];
const defaultOf = (s: Subject, lengths = durationsOf(s)): number =>
  lengths.includes(s.defaultDurationMin) ? s.defaultDurationMin : (lengths[0] ?? 60);

const teaches = (t: WithId<Teacher>, s: WithId<Subject>) =>
  (t.subjectIds ?? []).includes(s.id) || (s.teacherIds ?? []).includes(t.id);

/** "Daniel" when no other teacher shares the first name, else the full name. */
function shortNames(teachers: WithId<Teacher>[]) {
  const first = (t: Teacher) => t.displayName.trim().split(/\s+/)[0] ?? t.displayName;
  const counts = new Map<string, number>();
  for (const t of teachers) counts.set(first(t), (counts.get(first(t)) ?? 0) + 1);
  return new Map(teachers.map((t) => [t.id, counts.get(first(t)) === 1 ? first(t) : t.displayName]));
}

export function useSubjects() {
  const schoolId = useSchoolId();
  return useQuery<Subject>(`subjects:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'subjects')));
}

/** Every active teacher × subject × length. `onlyTeacher` limits it to one teacher (a teacher's own login). */
export function useLessonTypes(onlyTeacher?: string | null) {
  const subjects = useSubjects();
  const teachers = useTeachers();
  const types = useMemo(() => {
    const active = teachers.data.filter((t) => t.active !== false).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const names = shortNames(active);
    const out: LessonType[] = [];
    for (const t of active) {
      if (onlyTeacher && t.id !== onlyTeacher) continue;
      for (const s of subjects.data.filter((x) => x.active !== false).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!teaches(t, s)) continue;
        for (const min of durationsOf(s)) {
          out.push({
            key: `${t.id}|${s.id}|${min}`,
            teacherId: t.id,
            subjectId: s.id,
            durationMin: min,
            isDefault: min === defaultOf(s),
            label: `${s.name} with ${names.get(t.id)} · ${min} min`,
          });
        }
      }
    }
    return out;
  }, [subjects.data, teachers.data, onlyTeacher]);
  return { types, loading: subjects.loading || teachers.loading };
}

const COMMON_LENGTHS = [30, 45, 60, 90];

function SubjectRow({ subject, teachers }: { subject: WithId<Subject>; teachers: WithId<Teacher>[] }) {
  const schoolId = useSchoolId();
  const [name, setName] = useState(subject.name);
  const [lengths, setLengths] = useState<number[]>(durationsOf(subject));
  const [usual, setUsual] = useState<number>(defaultOf(subject));
  const [capacity, setCapacity] = useState<number>(subject.capacity ?? 1);
  const [teacherIds, setTeacherIds] = useState<string[]>(teachers.filter((t) => teaches(t, subject)).map((t) => t.id));
  const [custom, setCustom] = useState('');
  const [state, setState] = useState<{ busy: boolean; saved: boolean; error: string | null }>({ busy: false, saved: false, error: null });
  const archived = subject.active === false;

  const touched = () => setState({ busy: false, saved: false, error: null });
  const toggleLength = (m: number) => {
    setLengths(lengths.includes(m) ? lengths.filter((x) => x !== m) : [...lengths, m].sort((a, b) => a - b));
    touched();
  };
  const toggleTeacher = (id: string) => {
    setTeacherIds(teacherIds.includes(id) ? teacherIds.filter((x) => x !== id) : [...teacherIds, id]);
    touched();
  };

  function addCustom(e: FormEvent) {
    e.preventDefault();
    const m = Math.round(Number(custom));
    if (m >= 5 && m <= 720 && !lengths.includes(m)) {
      setLengths([...lengths, m].sort((a, b) => a - b));
      touched();
    }
    setCustom('');
  }

  async function save(active = !archived) {
    if (!name.trim()) return setState({ busy: false, saved: false, error: 'Give the subject a name.' });
    if (lengths.length === 0) return setState({ busy: false, saved: false, error: 'Pick at least one length.' });
    setState({ busy: true, saved: false, error: null });
    try {
      await updateDoc(doc(db, 'schools', schoolId, 'subjects', subject.id), {
        name: name.trim(),
        durations: lengths,
        defaultDurationMin: lengths.includes(usual) ? usual : lengths[0],
        teacherIds,
        capacity: Math.min(Math.max(Math.round(capacity) || 1, 1), 200),
        active,
        updatedAt: serverTimestamp(),
      });
      await Promise.all(
        teachers
          .filter((t) => teacherIds.includes(t.id) !== (t.subjectIds ?? []).includes(subject.id))
          .map((t) =>
            updateDoc(doc(db, 'schools', schoolId, 'teachers', t.id), {
              subjectIds: teacherIds.includes(t.id) ? arrayUnion(subject.id) : arrayRemove(subject.id),
              updatedAt: serverTimestamp(),
            }),
          ),
      );
      setState({ busy: false, saved: true, error: null });
    } catch (err) {
      setState({ busy: false, saved: false, error: (err as Error).message });
    }
  }

  const lengthChoices = [...new Set([...COMMON_LENGTHS, ...lengths])].sort((a, b) => a - b);
  return (
    <div className={`subject-row stack ${archived ? 'is-archived' : ''}`}>
      <div className="row subject-row-head">
        <input
          className="subject-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            touched();
          }}
          aria-label="Subject name"
          disabled={archived}
        />
        {archived && <span className="badge badge-archived">Archived</span>}
        <button className="btn btn-sm btn-ghost" disabled={state.busy} onClick={() => void save(archived)}>
          {archived ? 'Restore' : 'Archive'}
        </button>
      </div>
      {!archived && (
        <>
          <div className="field">
            <span>Lengths</span>
            <div className="chips">
              {lengthChoices.map((m) => (
                <label key={m} className={`chip ${lengths.includes(m) ? 'on' : ''}`}>
                  <input type="checkbox" checked={lengths.includes(m)} onChange={() => toggleLength(m)} />
                  {m} min
                </label>
              ))}
              <form onSubmit={addCustom}>
                <input
                  className="length-input"
                  type="number"
                  min={5}
                  max={720}
                  step={5}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Other (min)"
                  aria-label="Other length in minutes"
                />
              </form>
            </div>
          </div>
          {lengths.length > 1 && (
            <label className="field usual-length">
              <span>Usual length (new lessons start on this)</span>
              <select
                value={lengths.includes(usual) ? usual : lengths[0]}
                onChange={(e) => {
                  setUsual(Number(e.target.value));
                  touched();
                }}
              >
                {lengths.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field capacity-field">
            <span>Max students per lesson</span>
            <input
              type="number"
              min={1}
              max={200}
              value={capacity}
              onChange={(e) => {
                setCapacity(Number(e.target.value));
                touched();
              }}
            />
            <span className="field-help">
              {capacity > 1 ? `Group class: a booked time stays open online until ${capacity} students are on it.` : 'One-on-one: a booked time is taken.'}
            </span>
          </label>
          <div className="field">
            <span>Taught by</span>
            <div className="chips">
              {teachers.map((t) => (
                <label key={t.id} className={`chip ${teacherIds.includes(t.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={teacherIds.includes(t.id)} onChange={() => toggleTeacher(t.id)} />
                  {t.displayName}
                </label>
              ))}
            </div>
          </div>
          <div className="row">
            <button className="btn btn-sm btn-primary" disabled={state.busy} onClick={() => void save()}>
              {state.busy ? 'Saving…' : 'Save'}
            </button>
            {state.saved && <span className="success">Saved.</span>}
            {state.error && <span className="error">{state.error}</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** Settings: subjects with their lengths and teachers (owner and admin). */
export function LessonTypesEditor() {
  const schoolId = useSchoolId();
  const subjects = useSubjects();
  const teachers = useTeachers();
  const { types } = useLessonTypes();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const active = teachers.data.filter((t) => t.active !== false).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const rows = [...subjects.data].sort((a, b) => Number(a.active === false) - Number(b.active === false) || a.name.localeCompare(b.name));

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await addDoc(collection(db, 'schools', schoolId, 'subjects'), {
        name: name.trim(),
        durations: [45],
        defaultDurationMin: 45,
        teacherIds: [],
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      {rows.map((s) => (
        // Remount when the teacher list or archive state changes, so the row starts from what's saved.
        <SubjectRow key={`${s.id}:${s.active !== false}:${active.map((t) => t.id).join(',')}`} subject={s} teachers={active} />
      ))}
      <form className="row" onSubmit={add}>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="New subject, e.g. Piano lessons" aria-label="New subject" />
        <button className="btn btn-sm">Add subject</button>
        {error && <span className="error">{error}</span>}
      </form>
      {types.length > 0 && (
        <div className="lesson-types-preview">
          <span className="muted">New lessons can be:</span>
          <ul>
            {types.map((t) => (
              <li key={t.key}>{t.label}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
