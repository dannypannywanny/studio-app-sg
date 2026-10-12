// Student portal access. The owner picks students; each one gets an Auth account for their email with
// student claims (setMemberRole). Nothing is emailed here: students go to the learn site, type their
// email and get Firebase's sign-in link (self sign-up stays disabled, so only invited emails work).
//
// One Auth account can be one student per school, so an email shared by two students is skipped until
// the owner gives each their own address. A staff account is never turned into a student.
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Claims } from '@lessonkaki/shared';
import { schoolRef, type Actor } from './db';
import { setMemberRole } from './members';

export const MAX_INVITES = 100;

export const INVITE_OUTCOMES = [
  /** Account created or linked now (or would be, in a dry run). */
  'invited',
  /** Already has portal access for this student. */
  'already',
  'notFound',
  'archived',
  'noEmail',
  /** Another student in this school has the same email. */
  'sharedEmail',
  /** The email belongs to a staff member of this school. */
  'staffAccount',
  /** The email's account is already linked to a different student. */
  'linkedElsewhere',
] as const;
export type InviteOutcome = (typeof INVITE_OUTCOMES)[number];

export interface InviteStudentsInput {
  schoolId: string;
  studentIds: string[];
  /** Report what would happen without creating accounts. */
  dryRun?: boolean;
}

export interface InviteResult {
  studentId: string;
  outcome: InviteOutcome;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function userByEmail(auth: Auth, email: string): Promise<UserRecord | null> {
  try {
    return await auth.getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') return null;
    throw err;
  }
}

/** Lowercased email -> ids of the school's students using it (archived students don't count). */
async function emailOwners(db: Firestore, schoolId: string): Promise<Map<string, string[]>> {
  const snap = await schoolRef(db, schoolId).collection('students').select('email', 'status').get();
  const owners = new Map<string, string[]>();
  for (const d of snap.docs) {
    const email = String(d.get('email') ?? '').trim().toLowerCase();
    if (!email || d.get('status') === 'archived') continue;
    owners.set(email, [...(owners.get(email) ?? []), d.id]);
  }
  return owners;
}

/** One student's outcome from current data (reads only). */
async function decide(
  db: Firestore,
  auth: Auth,
  schoolId: string,
  studentId: string,
  owners: Map<string, string[]>,
): Promise<{ outcome: InviteOutcome; email?: string }> {
  const snap = await schoolRef(db, schoolId).collection('students').doc(studentId).get();
  if (!snap.exists) return { outcome: 'notFound' };
  if (snap.get('status') === 'archived') return { outcome: 'archived' };
  const email = String(snap.get('email') ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return { outcome: 'noEmail' };
  if ((owners.get(email) ?? []).some((id) => id !== studentId)) return { outcome: 'sharedEmail', email };

  const user = await userByEmail(auth, email);
  const claims = (user?.customClaims ?? {}) as Claims;
  const role = claims.r?.[schoolId];
  if (role && role !== 'student') return { outcome: 'staffAccount', email };
  if (role === 'student') {
    return claims.s?.[schoolId] === studentId ? { outcome: 'already', email } : { outcome: 'linkedElsewhere', email };
  }
  return { outcome: 'invited', email };
}

export async function inviteStudents(db: Firestore, auth: Auth, input: InviteStudentsInput, actor: Actor): Promise<InviteResult[]> {
  const owners = await emailOwners(db, input.schoolId);
  const results: InviteResult[] = [];
  for (const studentId of [...new Set(input.studentIds)]) {
    const { outcome, email } = await decide(db, auth, input.schoolId, studentId, owners);
    if (outcome === 'invited' && !input.dryRun) {
      await setMemberRole(db, auth, { schoolId: input.schoolId, email, role: 'student', studentId }, actor);
    }
    results.push({ studentId, outcome });
  }
  return results;
}
