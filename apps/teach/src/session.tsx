import { onIdTokenChanged, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Claims, Role } from '@lessonkaki/shared';
import { auth } from './firebase';

export interface Session {
  ready: boolean;
  user: User | null;
  claims: Claims;
  /** The school this staff app is working in: the first school where the user is not a student. */
  schoolId: string | null;
  role: Role | null;
  teacherId: string | null;
  /** This sign-in passed a second factor (or the account is an emulator-only devNoMfa exemption). */
  secondFactor: boolean;
}

const signedOut: Session = { ready: true, user: null, claims: {}, schoolId: null, role: null, teacherId: null, secondFactor: false };
const SessionContext = createContext<Session>({ ...signedOut, ready: false });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ ...signedOut, ready: false });

  useEffect(
    () =>
      onIdTokenChanged(auth, async (user) => {
        if (!user) return setSession(signedOut);
        const token = await user.getIdTokenResult();
        const claims: Claims = { r: token.claims.r as Claims['r'], t: token.claims.t as Claims['t'] };
        const secondFactor = Boolean(token.signInSecondFactor) || token.claims.devNoMfa === true;
        const schoolId = Object.entries(claims.r ?? {}).find(([, role]) => role !== 'student')?.[0] ?? null;
        setSession({
          ready: true,
          user,
          claims,
          schoolId,
          role: schoolId ? (claims.r?.[schoolId] ?? null) : null,
          teacherId: schoolId ? (claims.t?.[schoolId] ?? null) : null,
          secondFactor,
        });
      }),
    [],
  );

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

/** For pages under the staff layout, where a school is guaranteed. */
export function useSchoolId(): string {
  const { schoolId } = useSession();
  if (!schoolId) throw new Error('No school in session');
  return schoolId;
}
