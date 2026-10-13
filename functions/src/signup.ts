// Self sign-up on the learn site. A new person gives their name, email and phone and accepts the
// privacy notice; LessonKaki creates their student record and login (Auth self sign-up stays off),
// then emails the usual sign-in link. Someone the studio already has on file (same email) gets that
// record instead of a duplicate. Staff logins are never touched. The answer is the same either way.
import type { Auth } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Claims } from '@lessonkaki/shared';
import type { MailSender } from './alerts';
import { now } from './db';
import { inviteStudents } from './invites';
import { setMemberRole } from './members';
import { sendSignInLink } from './signInLinks';

/** New sign-ups per school per hour, before the form says to try later (abuse guard). */
export const MAX_SIGNUPS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

export interface SignUpInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  host: string;
  /** Ticked "I agree to the privacy notice". */
  consent: boolean;
}

/** Singapore numbers without +65 get it; anything else must already be international. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, '');
  if (/^[3689]\d{7}$/.test(digits)) return `+65${digits}`;
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^65[3689]\d{7}$/.test(digits)) return `+${digits}`;
  return null;
}

export type SignUpOutcome = 'created' | 'linked' | 'existing';

export async function signUpStudent(
  db: Firestore,
  auth: Auth,
  sender: MailSender | null,
  input: SignUpInput,
  opts: { defaultFrom: string },
  at: Date = new Date(),
): Promise<SignUpOutcome> {
  if (!input.consent) throw new HttpsError('invalid-argument', 'Please agree to the privacy notice');
  const phone = normalisePhone(input.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Enter a phone number like 9123 4567 or +44 7700 900123');
  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName) throw new HttpsError('invalid-argument', 'Enter your first name');

  const site = await db.collection('publicSchools').doc(input.host).get();
  if (!site.exists || site.get('site') !== 'learn') throw new HttpsError('failed-precondition', 'This site is not set up for sign-up');
  const schoolId = site.get('schoolId') as string;
  const school = db.collection('schools').doc(schoolId);
  const actor = { uid: 'signup', role: 'system' as const };
  // No mail sender (emulator): the account is still made; the dev page asks Firebase for the link.
  const link = () => (sender ? sendSignInLink(db, auth, sender, { email, host: input.host }, opts, at) : Promise.resolve(null));

  // Already has a login here: just send the link (staff get nothing, as on the sign-in form).
  let claims: Claims = {};
  try {
    claims = ((await auth.getUserByEmail(email)).customClaims ?? {}) as Claims;
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }
  if (claims.r?.[schoolId]) {
    await link();
    return 'existing';
  }

  // On file already (e.g. moved from the old system): link that record.
  const onFile = (await school.collection('students').where('email', '==', email).get()).docs.filter((d) => d.get('status') !== 'archived');
  if (onFile.length > 1) throw new HttpsError('failed-precondition', 'This email is shared by more than one student. Please contact the studio.');
  if (onFile.length === 1) {
    const [r] = await inviteStudents(db, auth, { schoolId, studentIds: [onFile[0]!.id] }, actor);
    if (r!.outcome !== 'invited' && r!.outcome !== 'already') throw new HttpsError('failed-precondition', 'Please contact the studio to sign in.');
    await link();
    return 'linked';
  }

  // New person. Cap sign-ups per hour so a bot can't fill the student list.
  const counter = school.collection('counters').doc('signups');
  await db.runTransaction(async (tx) => {
    const c = await tx.get(counter);
    const start = (c.get('windowStart') as Timestamp | undefined)?.toMillis() ?? 0;
    const inWindow = at.getTime() - start < HOUR_MS;
    const count = inWindow ? ((c.get('count') as number | undefined) ?? 0) : 0;
    if (count >= MAX_SIGNUPS_PER_HOUR) throw new HttpsError('resource-exhausted', 'Too many sign-ups right now. Please try again in an hour.');
    tx.set(counter, { windowStart: Timestamp.fromMillis(inWindow ? start : at.getTime()), count: count + 1 });
  });
  const schoolSnap = await school.get();
  const ref = school.collection('students').doc();
  await ref.create({
    firstName,
    lastName,
    preferredName: null,
    email,
    phone,
    status: 'active',
    studentCode: null,
    legacyId: null,
    referralSource: null,
    signupSource: 'learn',
    consent: { pdpaNoticeVersion: (schoolSnap.get('pdpa.noticeVersion') as string | undefined) ?? null, acceptedAt: Timestamp.fromDate(at), marketing: false },
    summary: { sessionsAvailable: 0, sessionsOwed: 0, outstandingCents: 0, moneyCreditCents: 0 },
    createdAt: now(),
    updatedAt: now(),
  });
  await setMemberRole(db, auth, { schoolId, email, role: 'student', studentId: ref.id }, actor);
  await link();
  return 'created';
}
