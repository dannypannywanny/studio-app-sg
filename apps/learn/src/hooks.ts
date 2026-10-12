import { Timestamp, collection, collectionGroup, doc, onSnapshot, orderBy, query, where, type DocumentData, type Query } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { resolvePolicy } from '@lessonkaki/shared';
import { db } from './firebase';
import { useSession, useStudentIds } from './session';
import type { Attendee, Enrolment, Invoice, Lesson, Profile, School, Student } from './types';

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
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...snap.data() } as WithId<T>) : null, loading: false, error: null }),
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
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WithId<T>), loading: false, error: null }),
      (error) => setState({ data: [], loading: false, error }),
    );
    // `make` is rebuilt every render; the key is what identifies the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/**
 * Which school this site belongs to, before anyone signs in: publicSchools/{hostname}. After sign-in
 * the school comes from the student's claims instead.
 */
export function useSiteSchoolId(): { schoolId: string | null; loading: boolean } {
  const { schoolId: signedInSchool } = useSession();
  const host = useDoc<{ schoolId: string }>(signedInSchool ? null : `publicSchools/${window.location.hostname}`);
  return { schoolId: signedInSchool ?? host.data?.schoolId ?? null, loading: host.loading };
}

export function useProfile(schoolId: string | null) {
  return useDoc<Profile>(schoolId ? `schools/${schoolId}/public/profile` : null);
}

/** Logo URL from the profile: a path on this site or an https URL, nothing else. */
export function logoSrc(profile: Profile | null | undefined): string | null {
  const url = profile?.logoUrl;
  if (!url) return null;
  return /^\/[A-Za-z0-9._~\/-]+$/.test(url) || /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~%\/-]*$/.test(url) ? url : null;
}

export function useSchool() {
  const { schoolId } = useStudentIds();
  const school = useDoc<School>(`schools/${schoolId}`);
  const timeZone = school.data?.timezone ?? 'Asia/Singapore';
  const policy = resolvePolicy(school.data?.policy);
  return { ...school, timeZone, policy, currency: school.data?.currency ?? 'SGD' };
}

export function useStudent() {
  const { schoolId, studentId } = useStudentIds();
  return useDoc<Student>(`schools/${schoolId}/students/${studentId}`);
}

/** How far back the lesson history goes. */
const HISTORY_DAYS = 180;

export interface MyLesson {
  lesson: WithId<Lesson>;
  attendee: Attendee | null;
}

/** The student's lessons since HISTORY_DAYS ago, joined with their own attendance on each. */
export function useMyLessons() {
  const { schoolId, studentId } = useStudentIds();
  // Fixed per mount so the query key stays stable.
  const [since] = useState(() => Timestamp.fromMillis(Date.now() - HISTORY_DAYS * 86_400_000));
  const lessons = useQuery<Lesson>(`lessons:${schoolId}:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons'), where('studentIds', 'array-contains', studentId), where('startAt', '>=', since), orderBy('startAt')),
  );
  const attendees = useQuery<Attendee>(`attendees:${schoolId}:${studentId}`, () =>
    query(
      collectionGroup(db, 'attendees'),
      where('schoolId', '==', schoolId),
      where('studentId', '==', studentId),
      where('lessonStartAt', '>=', since),
      orderBy('lessonStartAt'),
    ),
  );
  const data = useMemo(() => {
    const byLesson = new Map(attendees.data.map((a) => [a.lessonId, a]));
    return lessons.data.map((lesson): MyLesson => ({ lesson, attendee: byLesson.get(lesson.id) ?? null }));
  }, [lessons.data, attendees.data]);
  return { data, loading: lessons.loading || attendees.loading, error: lessons.error ?? attendees.error };
}

export function useEnrolments() {
  const { schoolId, studentId } = useStudentIds();
  return useQuery<Enrolment>(`enrolments:${schoolId}:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'enrolments'), where('studentId', '==', studentId), where('status', '==', 'active'), orderBy('validUntil')),
  );
}

export function useInvoices() {
  const { schoolId, studentId } = useStudentIds();
  return useQuery<Invoice>(`invoices:${schoolId}:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'invoices'), where('studentId', '==', studentId), orderBy('issueDate', 'desc')),
  );
}

/** "Ada", or the first name of whoever is signed in. */
export function firstName(s: Student | null | undefined): string {
  return (s?.preferredName || s?.firstName || '').trim();
}
