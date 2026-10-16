import { describe, expect, it } from 'vitest';
import { setAttendance, type MarkableStatus } from '../src/attendance';
import { createLesson } from '../src/lessons';
import { reconcileStudent } from '../src/reconcile';
import { mergeClaims } from '../src/members';
import { DAY, attendee, db, ledger, lesson, lot, owner, sell, summary, withInvariant, type TestSchool } from './helpers';

const mark = (t: TestSchool, lessonId: string, status: MarkableStatus, at?: Date, actor = owner) =>
  setAttendance(db, { schoolId: t.schoolId, lessonId, studentId: t.studentId, status }, actor, at);

// Every school a test makes is checked against the ledger invariant afterwards.
const school = withInvariant();

describe('sellPackage', () => {
  it('sell -> 4 credits, an invoice with a sequential number, a lot and a grant', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    expect(sale.invoiceNumber).toBe('INV-00001');
    expect(sale.sessionsRemaining).toBe(4);
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });

    const l = await lot(t, sale.enrolmentId);
    expect(l).toMatchObject({ sessionsTotal: 4, sessionsRemaining: 4, sessionsUsed: 0, status: 'active' });
    expect(l.validUntil.toMillis() - l.validFrom.toMillis()).toBe(30 * DAY);

    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${sale.invoiceId}`).get()).data()!;
    expect(inv).toMatchObject({ number: 'INV-00001', totalCents: 30000, pendingCents: 30000, status: 'sent' });

    const entries = await ledger(t);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'grant', delta: 4, enrolmentId: sale.enrolmentId });

    const second = await sell(t, t.pkg90);
    expect(second.invoiceNumber).toBe('INV-00002');
  });

  it('is idempotent: the same key twice is one sale', async () => {
    const t = await school();
    const a = await sell(t, t.pkg30, new Date(), 'key-aaaaaaaa');
    const b = await sell(t, t.pkg30, new Date(), 'key-aaaaaaaa');
    expect(b).toEqual(a);
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect((await db.collection(`schools/${t.schoolId}/invoices`).get()).size).toBe(1);
    expect((await db.doc(`schools/${t.schoolId}/counters/invoice`).get()).get('next')).toBe(2);
    await expect(sell(t, t.pkg90, new Date(), 'key-aaaaaaaa')).rejects.toThrow(/different sale/);
  });
});

describe('setAttendance', () => {
  it('mark present -> 3, with a debit entry on the lot', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const lessonId = await lesson(t);
    const res = await mark(t, lessonId, 'present');
    expect(res.charge).toBe('debited');
    expect(await summary(t)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
    expect((await lot(t, sale.enrolmentId)).sessionsRemaining).toBe(3);
    const debit = (await ledger(t)).find((e) => e.type === 'debit');
    expect(debit).toMatchObject({ delta: -1, enrolmentId: sale.enrolmentId, lessonId });
    expect(await attendee(t, lessonId)).toMatchObject({ status: 'present', ledgerEntryId: debit!.id, owed: false });
    const lessonDoc = (await db.doc(`schools/${t.schoolId}/lessons/${lessonId}`).get()).data()!;
    expect(lessonDoc.attendanceState).toBe('marked');
  });

  it('marking twice does not double-debit (and present -> absent keeps the one debit)', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const lessonId = await lesson(t);
    await mark(t, lessonId, 'present');
    const again = await mark(t, lessonId, 'present');
    expect(again.charge).toBe('none');
    await mark(t, lessonId, 'absent');
    expect(await summary(t)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
    expect((await ledger(t)).filter((e) => e.type === 'debit')).toHaveLength(1);
  });

  it('late cancel restores the credit to the same lot', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const lessonId = await lesson(t);
    await mark(t, lessonId, 'present');
    const res = await mark(t, lessonId, 'lateCancelled');
    expect(res.charge).toBe('restored');
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    const entries = await ledger(t);
    const debit = entries.find((e) => e.type === 'debit')!;
    expect(entries.find((e) => e.type === 'restore')).toMatchObject({
      delta: 1,
      enrolmentId: sale.enrolmentId,
      reversesEntryId: debit.id,
    });
  });

  it('unmark restores too', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const lessonId = await lesson(t);
    await mark(t, lessonId, 'present');
    await mark(t, lessonId, 'booked');
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect(await attendee(t, lessonId)).toMatchObject({ status: 'booked', ledgerEntryId: null, markedBy: null });
  });

  it('no credits -> owed, then a purchase settles it', async () => {
    const t = await school();
    const lessonId = await lesson(t);
    const res = await mark(t, lessonId, 'present');
    expect(res.charge).toBe('owed');
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 1 });
    expect(await attendee(t, lessonId)).toMatchObject({ owed: true, enrolmentId: null });

    const sale = await sell(t, t.pkg30);
    expect(sale.settled).toBe(1);
    expect(await summary(t)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
    const settle = (await ledger(t)).find((e) => e.type === 'settle')!;
    expect(settle).toMatchObject({ delta: -1, enrolmentId: sale.enrolmentId, lessonId });
    expect(await attendee(t, lessonId)).toMatchObject({
      owed: false,
      enrolmentId: sale.enrolmentId,
      ledgerEntryId: settle.id,
    });

    // Undoing a settled lesson gives the credit back to the new lot.
    await mark(t, lessonId, 'booked');
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });

  it('settles owed lessons oldest first and only as many as the package holds', async () => {
    const t = await school();
    const lessons = [];
    for (let i = 0; i < 5; i++) lessons.push(await lesson(t, new Date(Date.now() - (10 - i) * DAY)));
    for (const id of lessons) await mark(t, id, 'present');
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 5 });
    const sale = await sell(t, t.pkg30);
    expect(sale.settled).toBe(4);
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 1 });
    expect((await attendee(t, lessons[4]!)).owed).toBe(true);
    expect((await attendee(t, lessons[0]!)).owed).toBe(false);
    expect((await lot(t, sale.enrolmentId)).status).toBe('completed');
  });

  it('removing an owed lesson clears what is owed', async () => {
    const t = await school();
    const lessonId = await lesson(t);
    await mark(t, lessonId, 'present');
    await mark(t, lessonId, 'lateCancelled');
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
  });

  it('uses the earliest-expiring lot first', async () => {
    const t = await school();
    await sell(t, t.pkgNoExpiry);
    const long = await sell(t, t.pkg90);
    const short = await sell(t, t.pkg30);
    const lessonId = await lesson(t);
    const res = await mark(t, lessonId, 'present');
    expect(res.enrolmentId).toBe(short.enrolmentId);
    expect((await lot(t, short.enrolmentId)).sessionsRemaining).toBe(3);
    expect((await lot(t, long.enrolmentId)).sessionsRemaining).toBe(4);
  });

  it('skips lots that expired before the lesson', async () => {
    const t = await school();
    const old = await sell(t, t.pkg30, new Date(Date.now() - 60 * DAY)); // valid until 30 days ago
    const lessonId = await lesson(t);
    expect((await mark(t, lessonId, 'present')).charge).toBe('owed');

    const fresh = await sell(t, t.pkg30);
    expect(fresh.settled).toBe(1);
    const lesson2 = await lesson(t);
    expect((await mark(t, lesson2, 'present')).enrolmentId).toBe(fresh.enrolmentId);
    expect((await lot(t, old.enrolmentId)).sessionsRemaining).toBe(4);
  });

  it('restoring onto an expired lot writes a matching expire entry', async () => {
    const t = await school();
    const t0 = new Date(Date.now() - 40 * DAY);
    const sale = await sell(t, t.pkg30, t0); // valid until 10 days ago
    const lessonId = await lesson(t, new Date(t0.getTime() + DAY));
    await mark(t, lessonId, 'present', new Date(t0.getTime() + DAY));
    const before = await summary(t);

    const res = await mark(t, lessonId, 'lateCancelled'); // now: the lot has expired
    expect(res.charge).toBe('restoredExpired');
    const entries = (await ledger(t)).filter((e) => e.enrolmentId === sale.enrolmentId);
    expect(entries.map((e) => e.type).sort()).toEqual(['debit', 'expire', 'grant', 'restore']);
    expect(await summary(t)).toEqual(before);
    expect(await lot(t, sale.enrolmentId)).toMatchObject({ sessionsRemaining: 3, sessionsUsed: 0, sessionsExpired: 1 });
  });

  it('absent consumes a credit per policy', async () => {
    const strict = await school();
    await sell(strict, strict.pkg30);
    expect((await mark(strict, await lesson(strict), 'absent')).charge).toBe('debited');
    expect((await summary(strict)).sessionsAvailable).toBe(3);
    expect(await reconcileStudent(db, strict.schoolId, strict.studentId)).toEqual([]);

    const lenient = await school({ absentConsumesCredit: false });
    await sell(lenient, lenient.pkg30);
    expect((await mark(lenient, await lesson(lenient), 'absent')).charge).toBe('none');
    expect((await summary(lenient)).sessionsAvailable).toBe(4);
  });

  it('a teacher may only mark their own lessons', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const lessonId = await lesson(t);
    await expect(
      mark(t, lessonId, 'present', undefined, { uid: 'u2', role: 'teacher', teacherId: 'teacher2' }),
    ).rejects.toThrow(/your own lessons/);
    await expect(mark(t, lessonId, 'present', undefined, { uid: 'u3', role: 'student' })).rejects.toThrow();
    const res = await mark(t, lessonId, 'present', undefined, { uid: 'u1', role: 'teacher', teacherId: t.teacherId });
    expect(res.charge).toBe('debited');
  });

  it('keeps the invariant through a mixed sequence', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await lesson(t));
    const steps: [number, MarkableStatus][] = [
      [0, 'present'], [1, 'absent'], [2, 'present'], [0, 'lateCancelled'], [3, 'present'],
      [4, 'present'], [5, 'present'], [1, 'booked'], [0, 'present'], [2, 'absent'],
    ];
    for (const [i, status] of steps) {
      await mark(t, ids[i]!, status);
      expect(await reconcileStudent(db, t.schoolId, t.studentId)).toEqual([]);
    }
    await sell(t, t.pkg90);
    expect(await summary(t)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
  });
});

describe('createLesson', () => {
  const base = (t: TestSchool, startAt: Date, teacherId = t.teacherId) => ({
    schoolId: t.schoolId,
    teacherId,
    subjectId: t.subjectId,
    startAt,
    durationMin: 60,
    studentIds: [t.studentId],
    isOnline: true,
  });

  it('writes attendee docs with schoolId, studentId, lessonStartAt and owed', async () => {
    const t = await school();
    const start = new Date('2026-11-02T11:00:00Z');
    const { lessonId } = await createLesson(db, base(t, start), owner);
    expect(await attendee(t, lessonId)).toMatchObject({
      schoolId: t.schoolId,
      studentId: t.studentId,
      owed: false,
      status: 'booked',
    });
    expect((await attendee(t, lessonId)).lessonStartAt.toMillis()).toBe(start.getTime());
  });

  it('rejects a teacher conflict; back-to-back and other teachers are fine', async () => {
    const t = await school();
    const start = new Date('2026-11-02T11:00:00Z');
    await createLesson(db, base(t, start), owner);
    await expect(createLesson(db, base(t, new Date('2026-11-02T11:30:00Z')), owner)).rejects.toThrow(
      /already has a lesson/,
    );
    await expect(createLesson(db, base(t, new Date('2026-11-02T10:30:00Z')), owner)).rejects.toThrow(
      /already has a lesson/,
    );
    await expect(createLesson(db, base(t, new Date('2026-11-02T12:00:00Z')), owner)).resolves.toBeTruthy();
    await expect(createLesson(db, base(t, new Date('2026-11-02T10:00:00Z')), owner)).resolves.toBeTruthy();
    await expect(createLesson(db, base(t, start, 'teacher2'), owner)).resolves.toBeTruthy();
  });
});

describe('mergeClaims', () => {
  it('replaces one school and keeps the others', () => {
    const existing = { r: { other: 'student' as const, sywh: 'teacher' as const }, t: { sywh: 'x' }, s: { other: 'st9' } };
    expect(mergeClaims(existing, 'sywh', 'owner', 'tch1', null)).toEqual({
      r: { other: 'student', sywh: 'owner' },
      t: { sywh: 'tch1' },
      s: { other: 'st9' },
    });
  });
});

describe('sellPackage options', () => {
  it('names the line by subject and teacher, and applies expiry, % discount and a note', async () => {
    const { sellPackage } = await import('../src/credits');
    const t = await school();
    await db.doc(`schools/${t.schoolId}/subjects/${t.subjectId}`).set({ name: 'Voice lessons', teacherIds: [t.teacherId] }, { merge: true });
    await db.doc(`schools/${t.schoolId}/teachers/${t.teacherId}`).set({ displayName: 'Daniel Lee' }, { merge: true });
    await db.doc(`schools/${t.schoolId}/packages/${t.pkg30}`).set({ subjectId: t.subjectId }, { merge: true });
    const res = await sellPackage(
      db,
      { schoolId: t.schoolId, studentId: t.studentId, packageId: t.pkg30, idempotencyKey: 'opts-key-1', validUntil: '2030-06-30', discount: { kind: 'percent', value: 10 }, note: 'Paid by mum' },
      owner,
    );
    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${res.invoiceId}`).get()).data()!;
    expect(inv.lines[0].desc).toBe('Voice lessons with Daniel · 4 lessons');
    expect(inv).toMatchObject({ subtotalCents: 30000, discountCents: 3000, totalCents: 27000, pendingCents: 27000, note: 'Paid by mum' });
    const l = await lot(t, res.enrolmentId);
    expect(l.validUntil.toDate().toISOString()).toBe('2030-06-30T15:59:59.999Z');
    expect(l.note).toBe('Paid by mum');
  });

  it('an amount discount, no expiry', async () => {
    const { sellPackage } = await import('../src/credits');
    const t = await school();
    const res = await sellPackage(
      db,
      { schoolId: t.schoolId, studentId: t.studentId, packageId: t.pkg30, idempotencyKey: 'opts-key-2', validUntil: null, discount: { kind: 'amount', value: 5000 } },
      owner,
    );
    const inv = (await db.doc(`schools/${t.schoolId}/invoices/${res.invoiceId}`).get()).data()!;
    expect(inv).toMatchObject({ discountCents: 5000, totalCents: 25000 });
    expect((await lot(t, res.enrolmentId)).validUntil.toDate().getUTCFullYear()).toBeGreaterThan(2900);
  });
});
