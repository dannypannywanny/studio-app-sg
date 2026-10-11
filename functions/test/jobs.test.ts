import { describe, expect, it } from 'vitest';
import { setAttendance } from '../src/attendance';
import { adjustCredits, expireLots, reconcileLedger } from '../src/jobs';
import { DAY, db, ledger, lesson, lot, owner, sell, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();

const adjust = (t: TestSchool, delta: number, extra: { enrolmentId?: string; reason?: string; key?: string } = {}) =>
  adjustCredits(
    db,
    {
      schoolId: t.schoolId,
      studentId: t.studentId,
      delta,
      reason: extra.reason ?? 'Goodwill credit',
      enrolmentId: extra.enrolmentId ?? null,
      idempotencyKey: extra.key ?? `adj-${Math.random().toString(36).slice(2, 12)}`,
    },
    owner,
  );

describe('expireLots', () => {
  it('expires what is left on lots past their validity, once', async () => {
    const t = await school();
    const t0 = new Date(Date.now() - 40 * DAY);
    const old = await sell(t, t.pkg30, t0); // valid until 10 days ago
    const id = await lesson(t, new Date(t0.getTime() + DAY));
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, status: 'present' }, owner, new Date(t0.getTime() + DAY));
    await sell(t, t.pkg30); // fresh
    // Before the job, the date-expired lot still counts (the M1 caveat).
    expect(await summary(t)).toEqual({ sessionsAvailable: 7, sessionsOwed: 0 });

    expect(await expireLots(db, t.schoolId)).toEqual({ lots: 1, sessions: 3 });
    expect(await lot(t, old.enrolmentId)).toMatchObject({ status: 'expired', sessionsRemaining: 0, sessionsExpired: 3 });
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect((await ledger(t)).find((e) => e.type === 'expire')).toMatchObject({ delta: -3, enrolmentId: old.enrolmentId });

    expect(await expireLots(db, t.schoolId)).toEqual({ lots: 0, sessions: 0 });
  });

  it('leaves no-expiry lots alone', async () => {
    const t = await school();
    await sell(t, t.pkgNoExpiry, new Date(Date.now() - 400 * DAY));
    expect(await expireLots(db, t.schoolId)).toEqual({ lots: 0, sessions: 0 });
  });
});

describe('reconcileLedger', () => {
  it('records a clean run, and writes each problem to the audit log', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    expect(await reconcileLedger(db, t.schoolId)).toEqual({ studentsChecked: 1, problemCount: 0 });
    const job = (await db.doc(`schools/${t.schoolId}/jobs/reconcileLedger`).get()).data()!;
    expect(job).toMatchObject({ studentsChecked: 1, problemCount: 0 });

    const student = db.doc(`schools/${t.schoolId}/students/${t.studentId}`);
    await student.update({ 'summary.sessionsAvailable': 99 });
    expect(await reconcileLedger(db, t.schoolId)).toEqual({ studentsChecked: 1, problemCount: 1 });
    const audit = await db.collection(`schools/${t.schoolId}/auditLog`).where('action', '==', 'reconcileLedger.problem').get();
    expect(audit.docs[0]!.data()).toMatchObject({ target: `students/${t.studentId}` });
    expect(audit.docs[0]!.get('detail.problems')[0]).toMatch(/sessionsAvailable 99/);
    await student.update({ 'summary.sessionsAvailable': 4 }); // put it back for the invariant check
  });
});

describe('adjustCredits', () => {
  it('adds credits as a manual lot that also settles owed lessons', async () => {
    const t = await school();
    const id = await lesson(t);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, status: 'present' }, owner);
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 1 });

    const res = await adjust(t, 2, { reason: 'Make-up for a cancelled class' });
    expect(res).toMatchObject({ delta: 2, settled: 1 });
    expect(await summary(t)).toEqual({ sessionsAvailable: 1, sessionsOwed: 0 });
    const l = await lot(t, res.enrolmentIds[0]!);
    expect(l).toMatchObject({ packageName: 'Manual credit', sessionsTotal: 2, sessionsRemaining: 1 });
    expect((await ledger(t)).find((e) => e.type === 'adjust')).toMatchObject({ delta: 2, reason: 'Make-up for a cancelled class' });
  });

  it('takes credits from a given lot, or earliest-expiring first, and never below zero', async () => {
    const t = await school();
    const long = await sell(t, t.pkg90);
    const short = await sell(t, t.pkg30);
    await adjust(t, -1, { enrolmentId: long.enrolmentId });
    expect((await lot(t, long.enrolmentId)).sessionsRemaining).toBe(3);

    const res = await adjust(t, -5);
    expect(res.enrolmentIds).toEqual([short.enrolmentId, long.enrolmentId]);
    expect((await lot(t, short.enrolmentId)).sessionsRemaining).toBe(0);
    expect((await lot(t, long.enrolmentId)).sessionsRemaining).toBe(2);
    expect(await summary(t)).toEqual({ sessionsAvailable: 2, sessionsOwed: 0 });

    await expect(adjust(t, -3)).rejects.toThrow(/only has 2/);
  });

  it('needs a reason, is idempotent, and is staff-only', async () => {
    const t = await school();
    await expect(adjust(t, 1, { reason: ' ' })).rejects.toThrow(/reason/);
    const a = await adjust(t, 1, { key: 'adjust-key-01' });
    expect(await adjust(t, 1, { key: 'adjust-key-01' })).toEqual(a);
    expect((await summary(t)).sessionsAvailable).toBe(1);
    await expect(
      adjustCredits(
        db,
        { schoolId: t.schoolId, studentId: t.studentId, delta: 1, reason: 'x y z', idempotencyKey: 'adjust-key-02' },
        { uid: 'tch', role: 'teacher', teacherId: t.teacherId },
      ),
    ).rejects.toThrow(/owner or admin/);
  });
});
