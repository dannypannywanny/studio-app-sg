// Student sign-in emails sent by LessonKaki itself (Resend, from the school's own domain) instead of
// Firebase's noreply@<project>.firebaseapp.com, which lands in spam. The link is Firebase's email
// sign-in link, rewritten to open the learn site's /finish-signin directly (it accepts action links).
//
// The same email carries a 6-digit code. Typed into the page that asked for it, the code signs in
// *that* browser, so a student whose mail app opens links in its own built-in browser still stays
// signed in where they actually use the portal. The code is stored hashed, works once, for
// CODE_TTL_MS, and MAX_CODE_TRIES wrong guesses burn it.
//
// Only invited students get an email. Everyone else gets the same "check your inbox" answer, so the
// form doesn't reveal who is a student. Requests are rate-limited per address.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Auth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Claims } from '@lessonkaki/shared';
import type { MailSender } from './alerts';

/** At least this long between two emails to the same address. */
export const RESEND_GAP_MS = 60_000;
/** At most this many emails per address per hour. */
export const MAX_PER_HOUR = 5;
const HOUR_MS = 3_600_000;
/** How long an emailed code works. */
export const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses before a code stops working. */
export const MAX_CODE_TRIES = 5;

export interface SendSignInLinkInput {
  email: string;
  /** Hostname the request came from (the learn site); decides the school and where the link opens. */
  host: string;
}

export type SendSignInLinkOutcome = 'sent' | 'notStudent' | 'throttled';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function signInEmail(schoolName: string, link: string, code: string) {
  const subject = `${code} is your sign-in code for ${schoolName}`;
  const text = [
    'Hi,',
    '',
    `Your sign-in code for ${schoolName} is:`,
    '',
    code,
    '',
    'Type it on the sign-in page, or tap the link below to sign in and see your lessons, book and cancel:',
    '',
    link,
    '',
    'The code works for 10 minutes and the link for an hour, once each. If you did not ask for them, you can ignore this email.',
    '',
    schoolName,
  ].join('\n');
  const name = escapeHtml(schoolName);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#161616">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
<p style="margin:0 0 16px;font-size:20px;font-weight:600">${name}</p>
<p style="margin:0 0 8px;font-size:16px;line-height:1.5">Your sign-in code:</p>
<p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5">Type it on the sign-in page, or tap the button to sign in and see your lessons, book and cancel.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#c9ad92;color:#161616;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px">Sign in</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#55555a">The code works for 10 minutes and the link for an hour, once each. If you did not ask for them, you can ignore this email.</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Firebase's link opens its hosted handler first; point it at the learn site's own page instead. */
export function rewriteLink(firebaseLink: string, host: string): string {
  const url = new URL(firebaseLink);
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${scheme}://${host}/finish-signin${url.search}`;
}

/** The code is hashed with its doc id (the hashed email), so the stored value says nothing alone. */
const hashCode = (docId: string, code: string) => createHash('sha256').update(`${docId}:${code}`).digest();

/** The learn site's school for a request's hostname. */
async function learnSchool(db: Firestore, host: string): Promise<string> {
  const site = await db.collection('publicSchools').doc(host).get();
  if (!site.exists || site.get('site') !== 'learn') throw new HttpsError('failed-precondition', 'This site is not set up for sign-in');
  return site.get('schoolId') as string;
}

const codeDoc = (db: Firestore, schoolId: string, email: string) =>
  db.collection('schools').doc(schoolId).collection('signInLinks').doc(createHash('sha256').update(email).digest('hex'));

export async function sendSignInLink(
  db: Firestore,
  auth: Auth,
  sender: MailSender | null,
  input: SendSignInLinkInput,
  opts: { defaultFrom: string },
  at: Date = new Date(),
): Promise<SendSignInLinkOutcome> {
  const email = input.email.trim().toLowerCase();
  const schoolId = await learnSchool(db, input.host);

  let claims: Claims = {};
  try {
    claims = ((await auth.getUserByEmail(email)).customClaims ?? {}) as Claims;
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }
  if (claims.r?.[schoolId] !== 'student') return 'notStudent';

  // Rate limit per address (hashed, so the doc id isn't the email).
  const school = db.collection('schools').doc(schoolId);
  const ref = codeDoc(db, schoolId, email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = (snap.get('lastSentAt') as Timestamp | undefined)?.toMillis() ?? 0;
    const windowStart = (snap.get('windowStart') as Timestamp | undefined)?.toMillis() ?? 0;
    const inWindow = at.getTime() - windowStart < HOUR_MS;
    const count = inWindow ? ((snap.get('count') as number | undefined) ?? 0) : 0;
    if (at.getTime() - last < RESEND_GAP_MS || count >= MAX_PER_HOUR) return false;
    tx.set(ref, {
      lastSentAt: Timestamp.fromDate(at),
      windowStart: Timestamp.fromMillis(inWindow ? windowStart : at.getTime()),
      count: count + 1,
      codeHash: hashCode(ref.id, code),
      codeExpiresAt: Timestamp.fromMillis(at.getTime() + CODE_TTL_MS),
      codeTries: 0,
      expireAt: Timestamp.fromMillis(at.getTime() + 24 * HOUR_MS),
    });
    return true;
  });
  if (!allowed) return 'throttled';

  if (!sender) throw new HttpsError('unavailable', 'Email is not set up yet');
  const schoolSnap = await school.get();
  const schoolName = (schoolSnap.get('name') as string | undefined) ?? 'Student portal';
  const from = (schoolSnap.get('mail.from') as string | undefined) || opts.defaultFrom;
  const firebaseLink = await auth.generateSignInWithEmailLink(email, { url: `https://${input.host}/finish-signin`, handleCodeInApp: true });
  const mail = signInEmail(schoolName, rewriteLink(firebaseLink, input.host), code);
  await sender.send({ from, to: [email], ...mail, idempotencyKey: `signin/${ref.id}/${at.getTime()}` });
  return 'sent';
}

export interface VerifySignInCodeInput {
  email: string;
  code: string;
  /** Hostname the request came from (the learn site); decides the school. */
  host: string;
}

const WRONG_CODE = 'That code is wrong or has expired. Check the latest email, or get a new code.';

/**
 * Checks an emailed code and returns a custom token for the student, which the page signs in with.
 * Custom-token sign-in skips the second factor, so it's for plain student logins only: anyone with
 * a staff role anywhere, or a second factor enrolled, signs in by link (and two-step) instead.
 */
export async function verifySignInCode(db: Firestore, auth: Auth, input: VerifySignInCodeInput, at: Date = new Date()): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const schoolId = await learnSchool(db, input.host);
  const ref = codeDoc(db, schoolId, email);
  const given = hashCode(ref.id, input.code.replace(/\s/g, ''));

  const result = await db.runTransaction(async (tx): Promise<'ok' | 'wrong' | 'used up'> => {
    const snap = await tx.get(ref);
    const stored = snap.get('codeHash') as Buffer | undefined;
    const expires = (snap.get('codeExpiresAt') as Timestamp | undefined)?.toMillis() ?? 0;
    if (!stored || at.getTime() >= expires) return 'wrong';
    const tries = ((snap.get('codeTries') as number | undefined) ?? 0) + 1;
    const burn = { codeHash: FieldValue.delete(), codeExpiresAt: FieldValue.delete(), codeTries: FieldValue.delete() };
    if (stored.length === given.length && timingSafeEqual(stored, given)) {
      tx.update(ref, burn);
      return 'ok';
    }
    tx.update(ref, tries >= MAX_CODE_TRIES ? burn : { codeTries: tries });
    return tries >= MAX_CODE_TRIES ? 'used up' : 'wrong';
  });
  if (result === 'used up') throw new HttpsError('resource-exhausted', 'Too many wrong codes. Get a new code and try again.');
  if (result === 'wrong') throw new HttpsError('permission-denied', WRONG_CODE);

  const user = await auth.getUserByEmail(email).catch(() => null);
  const claims = (user?.customClaims ?? {}) as Claims;
  if (!user || user.disabled || claims.r?.[schoolId] !== 'student') throw new HttpsError('permission-denied', WRONG_CODE);
  const staff = Object.values(claims.r ?? {}).some((role) => role !== 'student');
  if (staff || (user.multiFactor?.enrolledFactors.length ?? 0) > 0) {
    throw new HttpsError('failed-precondition', 'This login has two-step sign-in. Use the link in the email instead.');
  }
  return auth.createCustomToken(user.uid);
}
