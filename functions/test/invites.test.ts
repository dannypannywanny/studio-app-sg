import { describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import { inviteStudents } from '../src/invites';
import { setMemberRole } from '../src/members';
import { addStudent, db, makeSchool, owner, type TestSchool } from './helpers';

const auth = getAuth();

async function withEmail(t: TestSchool, studentId: string, email: string | null) {
  await addStudent(t, studentId);
  await db.doc(`schools/${t.schoolId}/students/${studentId}`).update({ email });
}

const invite = (t: TestSchool, studentIds: string[], dryRun = false) =>
  inviteStudents(db, auth, { schoolId: t.schoolId, studentIds, dryRun }, owner);

const outcomes = async (t: TestSchool, studentIds: string[], dryRun = false) =>
  Object.fromEntries((await invite(t, studentIds, dryRun)).map((r) => [r.studentId, r.outcome]));

describe('inviteStudents', () => {
  it('creates a student account with claims and links it to the student', async () => {
    const t = await makeSchool();
    const email = `ada-${t.schoolId}@example.test`;
    await withEmail(t, 'ada', email);
    expect(await outcomes(t, ['ada'])).toEqual({ ada: 'invited' });
    const user = await auth.getUserByEmail(email);
    expect(user.customClaims).toMatchObject({ r: { [t.schoolId]: 'student' }, s: { [t.schoolId]: 'ada' } });
    expect((await db.doc(`schools/${t.schoolId}/students/ada`).get()).get('uid')).toBe(user.uid);
    expect((await db.doc(`schools/${t.schoolId}/members/${user.uid}`).get()).data()).toMatchObject({ role: 'student', studentId: 'ada' });
    // Running it again changes nothing.
    expect(await outcomes(t, ['ada'])).toEqual({ ada: 'already' });
  });

  it('a dry run reports without creating accounts', async () => {
    const t = await makeSchool();
    const email = `dry-${t.schoolId}@example.test`;
    await withEmail(t, 'dry', email);
    expect(await outcomes(t, ['dry'], true)).toEqual({ dry: 'invited' });
    await expect(auth.getUserByEmail(email)).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('skips an email shared by two students, whatever its case', async () => {
    const t = await makeSchool();
    const email = `family-${t.schoolId}@example.test`;
    await withEmail(t, 'mum', email);
    await withEmail(t, 'son', email.toUpperCase());
    expect(await outcomes(t, ['mum', 'son'])).toEqual({ mum: 'sharedEmail', son: 'sharedEmail' });
    await expect(auth.getUserByEmail(email)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    // Once the other student is archived, the address is theirs alone.
    await db.doc(`schools/${t.schoolId}/students/son`).update({ status: 'archived' });
    expect(await outcomes(t, ['mum', 'son'])).toEqual({ mum: 'invited', son: 'archived' });
  });

  it('never turns a staff account into a student', async () => {
    const t = await makeSchool();
    const email = `staff-${t.schoolId}@example.test`;
    const { uid } = await setMemberRole(db, auth, { schoolId: t.schoolId, email, role: 'admin' }, owner);
    await withEmail(t, 'me', email);
    expect(await outcomes(t, ['me'])).toEqual({ me: 'staffAccount' });
    expect((await auth.getUser(uid)).customClaims?.r).toEqual({ [t.schoolId]: 'admin' });
  });

  it('reports an account already linked to another student', async () => {
    const t = await makeSchool();
    const email = `moved-${t.schoolId}@example.test`;
    await withEmail(t, 'first', email);
    await invite(t, ['first']);
    await db.doc(`schools/${t.schoolId}/students/first`).update({ email: `new-${email}` });
    await withEmail(t, 'second', email);
    expect(await outcomes(t, ['second'])).toEqual({ second: 'linkedElsewhere' });
  });

  it('reports missing students and emails', async () => {
    const t = await makeSchool();
    await withEmail(t, 'blank', null);
    await withEmail(t, 'junk', 'not an email');
    expect(await outcomes(t, ['nobody', 'blank', 'junk'])).toEqual({ nobody: 'notFound', blank: 'noEmail', junk: 'noEmail' });
  });
});

describe('inviteStudents welcome email', () => {
  const mailer = () => {
    const sent: { to: string[]; subject: string; text: string }[] = [];
    return { sent, sender: { send: async (m: any) => (sent.push(m), { id: 'x' }) }, defaultFrom: 'Test <t@example.test>' };
  };

  it('emails how to sign in to a newly invited student, once', async () => {
    const t = await makeSchool();
    const email = `welcome-${t.schoolId}@example.test`;
    await withEmail(t, 'wel', email);
    await db.doc(`schools/${t.schoolId}`).update({ 'hosts.learn': 'learn.example.test' });
    const m = mailer();
    const run = () => inviteStudents(db, auth, { schoolId: t.schoolId, studentIds: ['wel'] }, owner, m);
    expect(await run()).toEqual([{ studentId: 'wel', outcome: 'invited', welcomed: true }]);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]!.to).toEqual([email]);
    expect(m.sent[0]!.text).toContain('https://learn.example.test');
    // Already has access: no second email.
    expect(await run()).toEqual([{ studentId: 'wel', outcome: 'already' }]);
    expect(m.sent).toHaveLength(1);
  });

  it('still invites when the email fails, and says it was not sent', async () => {
    const t = await makeSchool();
    await withEmail(t, 'bad', `bad-${t.schoolId}@example.test`);
    const sender = { send: async () => { throw new Error('boom'); } };
    const res = await inviteStudents(db, auth, { schoolId: t.schoolId, studentIds: ['bad'] }, owner, { sender, defaultFrom: 'x' });
    expect(res).toEqual([{ studentId: 'bad', outcome: 'invited', welcomed: false }]);
    expect((await auth.getUserByEmail(`bad-${t.schoolId}@example.test`)).customClaims).toMatchObject({ s: { [t.schoolId]: 'bad' } });
  });
});
