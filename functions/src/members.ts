import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Claims, Role } from '@lessonkaki/shared';
import { now, schoolRef, type Actor } from './db';

export interface SetMemberRoleInput {
  schoolId: string;
  /** Either an existing uid, or an email (the auth user is created if it doesn't exist yet). */
  uid?: string;
  email?: string;
  role: Role;
  teacherId?: string | null;
  studentId?: string | null;
}

export interface SetMemberRoleResult {
  uid: string;
  claims: Claims;
}

async function findOrCreateUser(auth: Auth, input: SetMemberRoleInput): Promise<UserRecord> {
  if (input.uid) return auth.getUser(input.uid);
  const email = input.email?.trim().toLowerCase();
  if (!email) throw new HttpsError('invalid-argument', 'Give a uid or an email');
  try {
    return await auth.getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    return auth.createUser({ email, emailVerified: false });
  }
}

/** Claims for one school are replaced; other schools' claims are kept. */
export function mergeClaims(
  existing: Claims,
  schoolId: string,
  role: Role,
  teacherId: string | null,
  studentId: string | null,
): Claims {
  const r = { ...(existing.r ?? {}), [schoolId]: role };
  const t = { ...(existing.t ?? {}) };
  const s = { ...(existing.s ?? {}) };
  delete t[schoolId];
  delete s[schoolId];
  if (teacherId) t[schoolId] = teacherId;
  if (studentId) s[schoolId] = studentId;
  const next: Claims = { r };
  if (Object.keys(t).length) next.t = t;
  if (Object.keys(s).length) next.s = s;
  return next;
}

/**
 * Sets the caller-independent part of a role change: claims + the members/{uid} mirror + doc links.
 * Owner-only checks live in the callable; seed scripts call this directly.
 */
export async function setMemberRole(
  db: Firestore,
  auth: Auth,
  input: SetMemberRoleInput,
  actor: Actor,
): Promise<SetMemberRoleResult> {
  const school = schoolRef(db, input.schoolId);
  const teacherId = input.teacherId ?? null;
  const studentId = input.studentId ?? null;

  if (input.role === 'teacher' && !teacherId) throw new HttpsError('invalid-argument', 'A teacher needs a teacherId');
  if (input.role === 'student' && !studentId) throw new HttpsError('invalid-argument', 'A student needs a studentId');
  if (input.role !== 'student' && studentId) {
    throw new HttpsError('invalid-argument', 'Only students link to a student record');
  }

  const [schoolSnap, teacherSnap, studentSnap] = await db.getAll(
    school,
    school.collection('teachers').doc(teacherId ?? '_none'),
    school.collection('students').doc(studentId ?? '_none'),
  );
  if (!schoolSnap!.exists) throw new HttpsError('not-found', 'School not found');
  if (teacherId && !teacherSnap!.exists) throw new HttpsError('not-found', 'Teacher not found');
  if (studentId && !studentSnap!.exists) throw new HttpsError('not-found', 'Student not found');

  const user = await findOrCreateUser(auth, input);
  const claims = mergeClaims((user.customClaims ?? {}) as Claims, input.schoolId, input.role, teacherId, studentId);
  if (JSON.stringify(claims).length > 900) {
    throw new HttpsError('resource-exhausted', 'Too many school memberships for one account');
  }
  await auth.setCustomUserClaims(user.uid, claims);

  const batch = db.batch();
  batch.set(
    school.collection('members').doc(user.uid),
    {
      role: input.role,
      email: user.email ?? null,
      teacherId,
      studentId,
      active: true,
      updatedBy: actor.uid,
      updatedAt: now(),
    },
    { merge: true },
  );
  if (teacherId) batch.update(school.collection('teachers').doc(teacherId), { uid: user.uid, updatedAt: now() });
  if (studentId) batch.update(school.collection('students').doc(studentId), { uid: user.uid, updatedAt: now() });
  batch.create(school.collection('auditLog').doc(), {
    actorUid: actor.uid,
    action: 'setMemberRole',
    target: `members/${user.uid}`,
    detail: { role: input.role, teacherId, studentId },
    at: now(),
  });
  await batch.commit();

  return { uid: user.uid, claims };
}
