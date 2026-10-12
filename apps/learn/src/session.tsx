import { onIdTokenChanged, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Claims } from '@lessonkaki/shared';
import { auth } from './firebase';

export interface Session {
  ready: boolean;
  user: User | null;
  /** The school this login is a student of (claims r[school] == 'student'), and their student doc. */
  schoolId: string | null;
  studentId: string | null;
}

const signedOut: Session = { ready: true, user: null, schoolId: null, studentId: null };
const SessionContext = createContext<Session>({ ...signedOut, ready: false });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ ...signedOut, ready: false });

  useEffect(
    () =>
      onIdTokenChanged(auth, async (user) => {
        if (!user) return setSession(signedOut);
        const claims = (await user.getIdTokenResult()).claims as Claims;
        const schoolId = Object.entries(claims.r ?? {}).find(([, role]) => role === 'student')?.[0] ?? null;
        setSession({ ready: true, user, schoolId, studentId: schoolId ? (claims.s?.[schoolId] ?? null) : null });
      }),
    [],
  );

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

/** For pages behind RequireStudent, where both are guaranteed. */
export function useStudentIds(): { schoolId: string; studentId: string } {
  const { schoolId, studentId } = useSession();
  if (!schoolId || !studentId) throw new Error('No student in session');
  return { schoolId, studentId };
}
