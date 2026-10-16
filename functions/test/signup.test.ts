import { describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import type { MailSender, OutgoingMail } from '../src/alerts';
import { setMemberRole } from '../src/members';
import { normalisePhone, signUpStudent } from '../src/signup';
import { addStudent, db, makeSchool, owner } from './helpers';

const auth = getAuth();
const OPTS = { defaultFrom: 'Test <t@example.test>' };

class FakeSender implements MailSender {
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
    return { id: 'x' };
  }
}

async function setup() {
  const t = await makeSchool();
  const host = `learn-${t.schoolId.replace(/_/g, '-')}.example.test`;
  await db.doc(`publicSchools/${host}`).set({ schoolId: t.schoolId, site: 'learn' });
  return { t, host };
}

const form = (host: string, email: string, extra: Partial<Parameters<typeof signUpStudent>[3]> = {}) => ({
  firstName: 'Nova',
  lastName: 'Tan',
  email,
  phone: '9123 4567',
  host,
  consent: true,
  ...extra,
});

describe('signUpStudent', () => {
  it('creates a student and login with consent recorded, then emails the sign-in link', async () => {
    const { t, host } = await setup();
    const email = `new-${t.schoolId}@example.test`;
    const sender = new FakeSender();
    expect(await signUpStudent(db, auth, sender, form(host, email.toUpperCase()), OPTS)).toBe('created');
    const students = await db.collection(`schools/${t.schoolId}/students`).where('email', '==', email).get();
    expect(students.size).toBe(1);
    expect(students.docs[0]!.data()).toMatchObject({ firstName: 'Nova', lastName: 'Tan', phone: '+6591234567', signupSource: 'learn', status: 'active' });
    expect(students.docs[0]!.get('consent.acceptedAt')).toBeTruthy();
    expect((await auth.getUserByEmail(email)).customClaims).toMatchObject({ r: { [t.schoolId]: 'student' }, s: { [t.schoolId]: students.docs[0]!.id } });
    expect(sender.sent.map((m) => m.to[0])).toEqual([email]);
  });

  it('links a student the studio already has instead of making a duplicate', async () => {
    const { t, host } = await setup();
    const email = `known-${t.schoolId}@example.test`;
    await addStudent(t, 'known');
    await db.doc(`schools/${t.schoolId}/students/known`).update({ email });
    expect(await signUpStudent(db, auth, new FakeSender(), form(host, email), OPTS)).toBe('linked');
    expect((await db.collection(`schools/${t.schoolId}/students`).where('email', '==', email).get()).size).toBe(1);
    expect((await auth.getUserByEmail(email)).customClaims?.s).toEqual({ [t.schoolId]: 'known' });
  });

  it('signing up again says the account exists (no email); staff logins are left alone', async () => {
    const { t, host } = await setup();
    const email = `twice-${t.schoolId}@example.test`;
    await signUpStudent(db, auth, new FakeSender(), form(host, email), OPTS);
    const again = new FakeSender();
    expect(await signUpStudent(db, auth, again, form(host, email), OPTS)).toBe('existing');
    expect(again.sent).toHaveLength(0);
    const staff = `staff-${t.schoolId}@example.test`;
    await setMemberRole(db, auth, { schoolId: t.schoolId, email: staff, role: 'admin' }, owner);
    const sender = new FakeSender();
    expect(await signUpStudent(db, auth, sender, form(host, staff), OPTS)).toBe('existing');
    expect(sender.sent).toHaveLength(0);
    expect((await auth.getUserByEmail(staff)).customClaims?.r).toEqual({ [t.schoolId]: 'admin' });
  });

  it('needs consent and a usable phone number', async () => {
    const { host } = await setup();
    await expect(signUpStudent(db, auth, null, form(host, 'a@example.test', { consent: false }), OPTS)).rejects.toThrow(/privacy/);
    await expect(signUpStudent(db, auth, null, form(host, 'a@example.test', { phone: '123' }), OPTS)).rejects.toThrow(/phone/);
  });

  it('normalises phone numbers', () => {
    expect(normalisePhone('9123 4567')).toBe('+6591234567');
    expect(normalisePhone('65 9123 4567')).toBe('+6591234567');
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('12345')).toBeNull();
  });
});
