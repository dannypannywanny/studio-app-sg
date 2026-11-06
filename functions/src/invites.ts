// Student portal access. The owner picks students; each one gets an Auth account for their email with
// student claims (setMemberRole). With `welcome` set, a newly invited student is also emailed how to sign
// in (the email carries no link or code: they ask for one on the learn site, so nothing goes stale).
//
// One Auth account can be one student per school, so an email shared by two students is skipped until
// the owner gives each their own address. A staff account is never turned into a student.
import type { Auth, UserRecord } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Claims } from '@lessonkaki/shared';
import { schoolRef, type Actor } from './db';
import { setMemberRole } from './members';
import type { MailSender } from './alerts';

export const MAX_INVITES = 100;

export const INVITE_OUTCOMES = [
  /** Account created or linked now (or would be, in a dry run). */
  'invited',
  /** Already has portal access for this student. */
  'already',
  'notFound',
  'archived',
  /** A lead (prospect): make them a student first. */
  'lead',
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
  /** Set when a welcome email was asked for and went out for this newly invited student. */
  welcomed?: boolean;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** How to sign in, sent when a student first gets portal access. */
export function welcomeEmail(schoolName: string, firstName: string, learnUrl: string | null) {
  const where = learnUrl ?? 'the student site';
  const steps = [
    `Go to ${where}`,
    'Type the email address this message was sent to and ask for a sign-in code',
    'Open the email we send you (check spam or promotions if it is not there) and type the 6-digit code, or tap the link in it',
  ];
  const subject = `Welcome to ${schoolName}: how to sign in and book your lessons`;
  const text = [
    `Hi ${firstName},`,
    '',
    `You can now book and manage your lessons online with ${schoolName}. To sign in:`,
    '',
    ...steps.map((t, i) => `${i + 1}. ${t}`),
    '',
    'There is no password. Next time, repeat the same steps. Once in, you can see your lessons and sessions left, book, cancel, buy packages and see invoices.',
    '',
    'If you need a hand, just reply to the studio.',
    '',
    schoolName,
  ].join('\n');
  const name = escapeHtml(schoolName);
  const button = learnUrl
    ? `<p style="margin:0 0 24px"><a href="${escapeHtml(learnUrl)}" style="display:inline-block;background:#c9ad92;color:#161616;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px">Go to sign in</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#161616">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
<p style="margin:0 0 16px;font-size:20px;font-weight:600">${name}</p>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5">Hi ${escapeHtml(firstName)}, you can now book and manage your lessons online. To sign in:</p>
<ol style="margin:0 0 24px;padding-left:20px;font-size:16px;line-height:1.6">${steps.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>
${button}<p style="margin:0;font-size:13px;line-height:1.5;color:#55555a">There is no password: next time, repeat the same steps. If you need a hand, just reply to the studio.</p>
</div></body></html>`;
  return { subject, text, html };
}

export interface WelcomeMail {
  sender: MailSender;
  defaultFrom: string;
}

/** Best effort: a mail problem never undoes the invite. */
async function sendWelcome(db: Firestore, mail: WelcomeMail, schoolId: string, studentId: string): Promise<boolean> {
  try {
    const school = schoolRef(db, schoolId);
    const [schoolSnap, student] = await Promise.all([school.get(), school.collection('students').doc(studentId).get()]);
    const email = String(student.get('email') ?? '').trim().toLowerCase();
    const host = schoolSnap.get('hosts.learn') as string | null | undefined;
    const content = welcomeEmail(
      (schoolSnap.get('name') as string | undefined) ?? 'Student portal',
      String(student.get('preferredName') || student.get('firstName') || 'there'),
      host ? `https://${host}` : null,
    );
    const from = (schoolSnap.get('mail.from') as string | undefined) || mail.defaultFrom;
    await mail.sender.send({ from, to: [email], ...content, idempotencyKey: `welcome/${schoolId}/${studentId}` });
    return true;
  } catch (err) {
    console.warn(`welcome email for ${studentId} failed`, err);
    return false;
  }
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
  if (snap.get('status') === 'lead') return { outcome: 'lead' };
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

export async function inviteStudents(
  db: Firestore,
  auth: Auth,
  input: InviteStudentsInput,
  actor: Actor,
  welcome?: WelcomeMail | null,
): Promise<InviteResult[]> {
  const owners = await emailOwners(db, input.schoolId);
  const results: InviteResult[] = [];
  for (const studentId of [...new Set(input.studentIds)]) {
    const { outcome, email } = await decide(db, auth, input.schoolId, studentId, owners);
    if (outcome === 'invited' && !input.dryRun) {
      await setMemberRole(db, auth, { schoolId: input.schoolId, email, role: 'student', studentId }, actor);
      if (welcome) {
        results.push({ studentId, outcome, welcomed: await sendWelcome(db, welcome, input.schoolId, studentId) });
        continue;
      }
    }
    results.push({ studentId, outcome });
  }
  return results;
}
