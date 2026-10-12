import { describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import type { MailSender, OutgoingMail } from '../src/alerts';
import { inviteStudents } from '../src/invites';
import { setMemberRole } from '../src/members';
import { RESEND_GAP_MS, rewriteLink, sendSignInLink } from '../src/signInLinks';
import { addStudent, db, makeSchool, owner } from './helpers';

const auth = getAuth();
const FROM = 'Test <noreply@example.test>';

class FakeSender implements MailSender {
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
    return { id: `m${this.sent.length}` };
  }
}

/** A school with a learn host and one invited student. */
async function setup() {
  const t = await makeSchool();
  const host = `learn-${t.schoolId.replace(/_/g, "-")}.example.test`;
  await db.doc(`publicSchools/${host}`).set({ schoolId: t.schoolId, site: 'learn' });
  await db.doc(`schools/${t.schoolId}`).update({ mail: { from: 'Test School <hi@school.example.test>' } });
  const email = `stu-${t.schoolId}@example.test`;
  await addStudent(t, 'stu');
  await db.doc(`schools/${t.schoolId}/students/stu`).update({ email });
  await inviteStudents(db, auth, { schoolId: t.schoolId, studentIds: ['stu'] }, owner);
  return { t, host, email };
}

describe('sendSignInLink', () => {
  it("emails an invited student a link that opens the learn site, from the school's own sender", async () => {
    const { host, email } = await setup();
    const sender = new FakeSender();
    expect(await sendSignInLink(db, auth, sender, { email: email.toUpperCase(), host }, { defaultFrom: FROM })).toBe('sent');
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail).toMatchObject({ from: 'Test School <hi@school.example.test>', to: [email], subject: 'Your sign-in link for Test School' });
    const link = mail.text.split('\n').find((l) => l.startsWith('https://'))!;
    expect(link.startsWith(`https://${host}/finish-signin?`)).toBe(true);
    expect(new URL(link).searchParams.get('mode')).toBe('signIn');
    expect(mail.html).toContain('Sign in');
  });

  it('sends nothing to people who are not students of the school, and answers the same way', async () => {
    const { t, host } = await setup();
    const sender = new FakeSender();
    expect(await sendSignInLink(db, auth, sender, { email: `nobody-${t.schoolId}@example.test`, host }, { defaultFrom: FROM })).toBe('notStudent');
    const staff = `staff-${t.schoolId}@example.test`;
    await setMemberRole(db, auth, { schoolId: t.schoolId, email: staff, role: 'admin' }, owner);
    expect(await sendSignInLink(db, auth, sender, { email: staff, host }, { defaultFrom: FROM })).toBe('notStudent');
    expect(sender.sent).toHaveLength(0);
  });

  it('limits how often one address gets an email', async () => {
    const { host, email } = await setup();
    const sender = new FakeSender();
    const at = new Date('2027-01-04T10:00:00Z');
    const send = (ms: number) => sendSignInLink(db, auth, sender, { email, host }, { defaultFrom: FROM }, new Date(at.getTime() + ms));
    expect(await send(0)).toBe('sent');
    expect(await send(RESEND_GAP_MS - 1)).toBe('throttled');
    expect(await send(RESEND_GAP_MS)).toBe('sent');
    for (let i = 2; i <= 4; i++) expect(await send(i * RESEND_GAP_MS)).toBe('sent');
    expect(await send(10 * RESEND_GAP_MS)).toBe('throttled'); // 5 in the hour already
    expect(await send(61 * RESEND_GAP_MS)).toBe('sent'); // a new hour
    expect(sender.sent).toHaveLength(6);
  });

  it('refuses sites that are not set up as a learn site', async () => {
    const { email } = await setup();
    await expect(sendSignInLink(db, auth, new FakeSender(), { email, host: 'evil.example.test' }, { defaultFrom: FROM })).rejects.toThrow(/not set up/);
  });

  it('rewrites the Firebase link onto the learn site, keeping its code', () => {
    const link = rewriteLink('https://p.firebaseapp.com/__/auth/action?apiKey=k&mode=signIn&oobCode=abc&continueUrl=x', 'learn.example.test');
    expect(link).toBe('https://learn.example.test/finish-signin?apiKey=k&mode=signIn&oobCode=abc&continueUrl=x');
  });
});
