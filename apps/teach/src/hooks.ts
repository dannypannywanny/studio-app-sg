import { collection, doc, onSnapshot, query, type DocumentData, type Query } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@lessonkaki/shared';
import { call, db } from './firebase';
import { useSchoolId, useSession } from './session';
import type { Lesson, School, Student, Teacher, Ts } from './types';

export type WithId<T> = T & { id: string };

interface Live<T> {
  data: T;
  loading: boolean;
  error: Error | null;
}

/** Live document. `path` null = nothing to load. */
export function useDoc<T = DocumentData>(path: string | null): Live<WithId<T> | null> {
  const [state, setState] = useState<Live<WithId<T> | null>>({ data: null, loading: !!path, error: null });
  useEffect(() => {
    if (!path) return setState({ data: null, loading: false, error: null });
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      doc(db, path),
      (snap) =>
        setState({
          data: snap.exists() ? ({ id: snap.id, ...snap.data() } as WithId<T>) : null,
          loading: false,
          error: null,
        }),
      (error) => setState({ data: null, loading: false, error }),
    );
  }, [path]);
  return state;
}

/** Live query. `key` identifies the query: it re-subscribes only when the key changes. */
export function useQuery<T = DocumentData>(key: string | null, make: () => Query): Live<WithId<T>[]> {
  const [state, setState] = useState<Live<WithId<T>[]>>({ data: [], loading: !!key, error: null });
  useEffect(() => {
    if (!key) return setState({ data: [], loading: false, error: null });
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      make(),
      (snap) =>
        setState({
          data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WithId<T>),
          loading: false,
          error: null,
        }),
      (error) => setState({ data: [], loading: false, error }),
    );
    // `make` is rebuilt every render; the key is what identifies the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export function useSchool() {
  return useDoc<School>(`schools/${useSchoolId()}`);
}

export function useTimeZone(): string {
  return useSchool().data?.timezone ?? 'Asia/Singapore';
}

export function useFormatTs() {
  const tz = useTimeZone();
  return (t: Ts | null | undefined) => (t ? formatDateTime(t.toDate(), tz) : '—');
}

const teacherRosterCall = call<{ schoolId: string }, { students: WithId<Student>[] }>('teacherRoster');
let rosterCache: { schoolId: string; at: number; data: WithId<Student>[] } | null = null;

/** Teachers can't read student records; they get names and notes for their own students from the server. */
function useTeacherRoster(schoolId: string, enabled: boolean): Live<WithId<Student>[]> {
  const fresh = rosterCache && rosterCache.schoolId === schoolId && Date.now() - rosterCache.at < 5 * 60_000;
  const [state, setState] = useState<Live<WithId<Student>[]>>({ data: fresh ? rosterCache!.data : [], loading: enabled && !fresh, error: null });
  useEffect(() => {
    if (!enabled || fresh) return;
    let live = true;
    teacherRosterCall({ schoolId })
      .then((r) => {
        rosterCache = { schoolId, at: Date.now(), data: r.students };
        if (live) setState({ data: r.students, loading: false, error: null });
      })
      .catch((error: Error) => live && setState({ data: [], loading: false, error }));
    return () => {
      live = false;
    };
  }, [schoolId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function useStudents() {
  const schoolId = useSchoolId();
  const { role } = useSession();
  const isTeacher = role === 'teacher';
  const live = useQuery<Student>(isTeacher ? null : `students:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'students')));
  const roster = useTeacherRoster(schoolId, isTeacher);
  const source = isTeacher ? roster : live;
  const byId = useMemo(() => new Map(source.data.map((s) => [s.id, s])), [source.data]);
  return { ...source, byId };
}

export function useTeachers() {
  const schoolId = useSchoolId();
  const { role, teacherId } = useSession();
  const isTeacher = role === 'teacher';
  const live = useQuery<Teacher>(isTeacher ? null : `teachers:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'teachers')));
  // A teacher may read only their own teacher doc.
  const own = useDoc<Teacher>(isTeacher && teacherId ? `schools/${schoolId}/teachers/${teacherId}` : null);
  const data = useMemo(() => (isTeacher ? (own.data ? [own.data] : []) : live.data), [isTeacher, own.data, live.data]);
  const byId = useMemo(() => new Map(data.map((t) => [t.id, t])), [data]);
  return { data, loading: isTeacher ? own.loading : live.loading, error: isTeacher ? own.error : live.error, byId };
}

/** Who's on a lesson, e.g. "Mei Lin, John Tan (Trial)". */
export function lessonStudents(l: Pick<Lesson, 'studentIds' | 'trialStudentIds'>, byId: Map<string, Student>): string {
  const trials = new Set(l.trialStudentIds ?? []);
  return l.studentIds.map((id) => `${studentName(byId.get(id))}${trials.has(id) ? ' (Trial)' : ''}`).join(', ');
}

export function studentName(s: Pick<Student, 'firstName' | 'lastName' | 'preferredName'> | undefined): string {
  if (!s) return 'Unknown student';
  return [s.preferredName || s.firstName, s.lastName].filter(Boolean).join(' ');
}
