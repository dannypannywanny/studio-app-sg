// Student sign-in emails sent by LessonKaki itself (Resend, from the school's own domain) instead of
// Firebase's noreply@<project>.firebaseapp.com, which lands in spam. The link is Firebase's email
// sign-in link, rewritten to open the learn site's /finish-signin directly (it accepts action links).
//
// Only invited students get an email. Everyone else gets the same "check your inbox" answer, so the
// form doesn't reveal who is a student. Requests are rate-limited per address.
import { createHash } from 'node:crypto';
import type { Auth } from 'firebase-admin/auth';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Claims } from '@lessonkaki/shared';
import type { MailSender } from './alerts';

/** At least this long between two emails to the same address. */
export const RESEND_GAP_MS = 60_000;
/** At most this many emails per address per hour. */
export const MAX_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

export interface SendSignInLinkInput {
  email: string;
  /** Hostname the request came from (the learn site); decides the school and where the link opens. */
  host: string;
}

export type SendSignInLinkOutcome = 'sent' | 'notStudent' | 'throttled';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function signInEmail(schoolName: string, link: string) {
  const subject = `Your sign-in link for ${schoolName}`;
  const text = [
    'Hi,',
    '',
    `Tap the link below to sign in to ${schoolName} and see your lessons, book and cancel:`,
    '',
    link,
    '',
    'The link works once. If you did not ask for it, you can ignore this email.',
    '',
    schoolName,
  ].join('\n');
  const name = escapeHtml(schoolName);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#161616">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
<p style="margin:0 0 16px;font-size:20px;font-weight:600">${name}</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5">Tap the button to sign in and see your lessons, book and cancel.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#c9ad92;color:#161616;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px">Sign in</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#55555a">The link works once. If you did not ask for it, you can ignore this email.</p>
</div></body></html>`;
  return { subject, text, html };
}

/** Firebase's link opens its hosted handler first; point it at the learn site's own page instead. */
export function rewriteLink(firebaseLink: string, host: string): string {
  const url = new URL(firebaseLink);
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${scheme}://${host}/finish-signin${url.search}`;
}

export async function sendSignInLink(
  db: Firestore,
  auth: Auth,
  sender: MailSender | null,
  input: SendSignInLinkInput,
  opts: { defaultFrom: string },
  at: Date = new Date(),
): Promise<SendSignInLinkOutcome> {
  const email = input.email.trim().toLowerCase();
  const site = await db.collection('publicSchools').doc(input.host).get();
  if (!site.exists || site.get('site') !== 'learn') throw new HttpsError('failed-precondition', 'This site is not set up for sign-in');
  const schoolId = site.get('schoolId') as string;

  let claims: Claims = {};
  try {
    claims = ((await auth.getUserByEmail(email)).customClaims ?? {}) as Claims;
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
  }
  if (claims.r?.[schoolId] !== 'student') return 'notStudent';

  // Rate limit per address (hashed, so the doc id isn't the email).
  const school = db.collection('schools').doc(schoolId);
  const ref = school.collection('signInLinks').doc(createHash('sha256').update(email).digest('hex'));
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
  const mail = signInEmail(schoolName, rewriteLink(firebaseLink, input.host));
  await sender.send({ from, to: [email], ...mail, idempotencyKey: `signin/${ref.id}/${at.getTime()}` });
  return 'sent';
}
