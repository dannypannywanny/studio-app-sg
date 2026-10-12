import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import { roleNeedsMfa, type Claims, type Role } from '@lessonkaki/shared';
import type { Actor } from './db';

type AuthData = CallableRequest['auth'];

/** True when this sign-in passed a second factor, or the account is an emulator-only exemption. */
export function hasSecondFactor(token: Record<string, unknown>): boolean {
  const firebase = token.firebase as { sign_in_second_factor?: string } | undefined;
  return Boolean(firebase?.sign_in_second_factor) || (token as Claims).devNoMfa === true;
}

/** Turns verified token claims into an Actor for one school, or throws. */
export function requireRole(auth: AuthData, schoolId: string, allowed: readonly Role[]): Actor {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const claims = auth.token as Claims;
  const role = claims.r?.[schoolId];
  if (!role || !allowed.includes(role)) {
    throw new HttpsError('permission-denied', 'You do not have access to do this');
  }
  if (roleNeedsMfa(role) && !hasSecondFactor(auth.token)) {
    throw new HttpsError('permission-denied', 'Set up two-step sign-in first, then sign in again');
  }
  return { uid: auth.uid, role, teacherId: claims.t?.[schoolId] ?? null, studentId: claims.s?.[schoolId] ?? null };
}
