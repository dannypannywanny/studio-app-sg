import { collection, doc, onSnapshot, query, type DocumentData, type Query } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@lessonkaki/shared';
import { db } from './firebase';
import { useSchoolId } from './session';
import type { School, Student, Teacher, Ts } from './types';

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

export function useStudents() {
  const schoolId = useSchoolId();
  const live = useQuery<Student>(`students:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'students')));
  const byId = useMemo(() => new Map(live.data.map((s) => [s.id, s])), [live.data]);
  return { ...live, byId };
}

export function useTeachers() {
  const schoolId = useSchoolId();
  const live = useQuery<Teacher>(`teachers:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'teachers')));
  const byId = useMemo(() => new Map(live.data.map((t) => [t.id, t])), [live.data]);
  return { ...live, byId };
}

export function studentName(s: Pick<Student, 'firstName' | 'lastName' | 'preferredName'> | undefined): string {
  if (!s) return 'Unknown student';
  return [s.preferredName || s.firstName, s.lastName].filter(Boolean).join(' ');
}
