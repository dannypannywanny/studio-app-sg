import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Role } from '@lessonkaki/shared';

/** Who is acting. Built from verified claims by the callables, or by scripts/tests directly. */
export interface Actor {
  uid: string;
  role: Role | 'system';
  /** The caller's teacher doc in this school, if any (claims.t[schoolId]). */
  teacherId?: string | null;
  /** The caller's student doc in this school, if any (claims.s[schoolId]). */
  studentId?: string | null;
}

export const schoolRef = (db: Firestore, schoolId: string): DocumentReference => db.collection('schools').doc(schoolId);

export const now = () => FieldValue.serverTimestamp();

type Snaps<T extends readonly unknown[]> = { [K in keyof T]: DocumentSnapshot };

/** tx.getAll with one snapshot per ref, typed as a tuple so destructuring is safe. */
export async function readAll<T extends readonly DocumentReference[]>(tx: Transaction, ...refs: T): Promise<Snaps<T>> {
  return (await tx.getAll(...refs)) as unknown as Snaps<T>;
}

/** Staff-visible audit trail, written in the same transaction as the change. */
export function audit(
  tx: Transaction,
  school: DocumentReference,
  actor: Actor,
  action: string,
  target: string,
  detail: Record<string, unknown> = {},
): void {
  tx.create(school.collection('auditLog').doc(), {
    actorUid: actor.uid,
    action,
    target,
    detail,
    at: now(),
  });
}

export function notFound(what: string): never {
  throw new HttpsError('not-found', `${what} not found`);
}
