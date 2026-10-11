import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Claims, Role } from '@lessonkaki/shared';
import type { Actor } from './db';

type AuthData = CallableRequest['auth'];

/** Turns verified token claims into an Actor for one school, or throws. */
export function requireRole(auth: AuthData, schoolId: string, allowed: readonly Role[]): Actor {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const claims = auth.token as Claims;
  const role = claims.r?.[schoolId];
  if (!role || !allowed.includes(role)) {
    throw new HttpsError('permission-denied', 'You do not have access to do this');
  }
  return { uid: auth.uid, role, teacherId: claims.t?.[schoolId] ?? null };
}
