import { describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import { db, makeSchool, owner } from './helpers';
import { requireRole } from '../src/auth';
import { resetSecondFactor, setMemberRole } from '../src/members';

type AuthData = Parameters<typeof requireRole>[0];
const as = (token: Record<string, unknown>): AuthData => ({ uid: 'u1', token, rawToken: 'raw' }) as unknown as AuthData;
const TOTP = { firebase: { sign_in_provider: 'password', sign_in_second_factor: 'totp' } };

describe('requireRole second factor', () => {
  it('staff need a second factor', () => {
    expect(() => requireRole(as({ r: { s1: 'owner' } }), 's1', ['owner'])).toThrow(/two-step/);
    expect(() => requireRole(as({ r: { s1: 'teacher' }, t: { s1: 't1' } }), 's1', ['teacher'])).toThrow(/two-step/);
    expect(requireRole(as({ r: { s1: 'owner' }, ...TOTP }), 's1', ['owner']).role).toBe('owner');
  });

  it('accepts the emulator-only devNoMfa claim', () => {
    expect(requireRole(as({ r: { s1: 'admin' }, devNoMfa: true }), 's1', ['admin']).role).toBe('admin');
  });

  it('students need no second factor', () => {
    expect(requireRole(as({ r: { s1: 'student' }, s: { s1: 'st1' } }), 's1', ['student']).studentId).toBe('st1');
  });

  it('role checks still come first', () => {
    expect(() => requireRole(as({ r: { s1: 'teacher' }, ...TOTP }), 's1', ['owner'])).toThrow(/do not have access/);
  });
});

describe('setMemberRole on a demo project', () => {
  it('marks the account devNoMfa (emulator only)', async () => {
    const t = await makeSchool();
    const res = await setMemberRole(db, getAuth(), { schoolId: t.schoolId, email: `${t.schoolId}@example.test`, role: 'admin' }, owner);
    expect(res.claims.devNoMfa).toBe(true);
  });
});

describe('resetSecondFactor', () => {
  it('clears factors for a member of the school and writes an audit entry', async () => {
    const t = await makeSchool();
    const { uid } = await setMemberRole(db, getAuth(), { schoolId: t.schoolId, email: `r-${t.schoolId}@example.test`, role: 'admin' }, owner);
    await resetSecondFactor(db, getAuth(), t.schoolId, uid, owner);
    expect((await getAuth().getUser(uid)).multiFactor?.enrolledFactors ?? []).toHaveLength(0);
    const audit = await db.collection(`schools/${t.schoolId}/auditLog`).where('action', '==', 'resetSecondFactor').get();
    expect(audit.size).toBe(1);
  });

  it('refuses someone who is not a member of the school', async () => {
    const t = await makeSchool();
    await expect(resetSecondFactor(db, getAuth(), t.schoolId, 'nobody', owner)).rejects.toThrow(/Not a member/);
  });
});
