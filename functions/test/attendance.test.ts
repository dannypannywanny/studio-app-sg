import { describe, expect, it } from 'vitest';
import {
  addAttendee,
  attendanceStateOf,
  cancelAttendance,
  cancelLesson,
  deleteLesson,
  removeAttendee,
  setAttendance,
  setAttendeePackage,
  setLessonNote,
  type CancelMode,
  type MarkableStatus,
} from '../src/attendance';
import type { Actor } from '../src/db';
import {
  DAY,
  addStudent,
  attendee,
  db,
  ledger,
  lesson,
  lessonDoc,
  lot,
  owner,
  sell,
  summary,
  withInvariant,
  type TestSchool,
} from './helpers';

const HOUR = 3_600_000;
const school = withInvariant();

const mark = (t: TestSchool, lessonId: string, status: MarkableStatus, studentId = t.studentId) =>
  setAttendance(db, { schoolId: t.schoolId, lessonId, studentId, status }, owner);

const cancel = (t: TestSchool, lessonId: string, opts: { mode?: CancelMode; actor?: Actor; studentId?: string } = {}) =>
  cancelAttendance(
    db,
    { schoolId: t.schoolId, lessonId, studentId: opts.studentId ?? t.studentId, mode: opts.mode },
    opts.actor ?? owner,
  );

let slot = 0;
/** A lesson `hours` from now; each call nudges the start by a few minutes so lessons never clash. */
const lessonIn = (t: TestSchool, hours: number, studentIds?: string[]) =>
  lesson(t, new Date(Date.now() + hours * HOUR + slot++ * 61 * 60_000), studentIds);

describe('cancelAttendance', () => {
  it('on time: cancelled, no credit moves', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lessonIn(t, 72);
    const res = await cancel(t, id);
    expect(res).toEqual({ status: 'cancelled', late: false, charge: 'none' });
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect(await attendee(t, id)).toMatchObject({ status: 'cancelled', ledgerEntryId: null });
    expect(await lessonDoc(t, id)).toMatchObject({ attendanceState: 'marked', studentsCancelled: true });
    // Unmarking puts the lesson back on the calendar as a normal one.
    await mark(t, id, 'booked');
    expect(await lessonDoc(t, id)).toMatchObject({ attendanceState: 'unmarked', studentsCancelled: false });
  });

  it('inside lateCancelHours: lateCancelled, and the default policy keeps the credit with the student', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lessonIn(t, 2);
    const res = await cancel(t, id);
    expect(res).toMatchObject({ status: 'lateCancelled', late: true, charge: 'none' });
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });

  it('late cancel uses a credit when the policy says it does not return', async () => {
    const t = await school({ lateCancelReturnsCredit: false });
    const sale = await sell(t, t.pkg30);
    const id = await lessonIn(t, 2);
    const res = await cancel(t, id);
    expect(res).toMatchObject({ status: 'lateCancelled', charge: 'debited' });
    expect((await lot(t, sale.enrolmentId)).sessionsRemaining).toBe(3);
    // An on-time cancel under the same policy uses nothing.
    expect((await cancel(t, await lessonIn(t, 100))).charge).toBe('none');
    expect(await summary(t)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
  });

  it('respects the school lateCancelHours', async () => {
    const t = await school({ lateCancelHours: 48 });
    expect((await cancel(t, await lessonIn(t, 30))).late).toBe(true);
    expect((await cancel(t, await lessonIn(t, 60))).late).toBe(false);
  });

  it('a charged attendee who cancels gets the credit back on the same lot', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    const id = await lessonIn(t, 72);
    await mark(t, id, 'present');
    expect((await cancel(t, id)).charge).toBe('restored');
    expect((await lot(t, sale.enrolmentId)).sessionsRemaining).toBe(4);
    const restore = (await ledger(t)).find((e) => e.type === 'restore');
    expect(restore).toMatchObject({ enrolmentId: sale.enrolmentId, lessonId: id, delta: 1 });
  });

  it('staff can override late/on-time; students cannot', async () => {
    const t = await school({ lateCancelReturnsCredit: false });
    await sell(t, t.pkg30);
    const late = await lessonIn(t, 2);
    expect(await cancel(t, late, { mode: 'onTime' })).toMatchObject({ status: 'cancelled', charge: 'none' });

    const student: Actor = { uid: 'stu', role: 'student', studentId: t.studentId };
    const other: Actor = { uid: 'stu2', role: 'student', studentId: 'someoneElse' };
    const soon = await lessonIn(t, 3);
    await expect(cancel(t, soon, { actor: student, mode: 'onTime' })).rejects.toThrow(/Only staff/);
    await expect(cancel(t, soon, { actor: student })).rejects.toThrow(/contact the studio/);
    await expect(cancel(t, soon, { actor: other })).rejects.toThrow(/your own/);

    const later = await lessonIn(t, 96);
    expect(await cancel(t, later, { actor: student })).toMatchObject({ status: 'cancelled', late: false });
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });
});

describe('addAttendee / removeAttendee', () => {
  it('adds a student once, grows capacity, and is a no-op the second time', async () => {
    const t = await school();
    const ben = await addStudent(t, 'ben');
    const id = await lessonIn(t, 24);
    expect(await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: ben }, owner)).toEqual({ added: true });
    expect(await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: ben }, owner)).toEqual({ added: false });
    const l = await lessonDoc(t, id);
    expect(l.studentIds).toEqual([t.studentId, ben]);
    expect(l.capacity).toBe(2);
    expect(await attendee(t, id, ben)).toMatchObject({ status: 'booked', schoolId: t.schoolId, owed: false });
  });

  it('removing a charged student restores the credit and takes them off the roster', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lessonIn(t, -24);
    await mark(t, id, 'present');
    const res = await removeAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId }, owner);
    expect(res.charge).toBe('restored');
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect(await attendee(t, id)).toMatchObject({ status: 'removed', ledgerEntryId: null });
    const l = await lessonDoc(t, id);
    expect(l.studentIds).toEqual([]);
    expect(l.attendanceState).toBe('unmarked');
    await expect(mark(t, id, 'present')).rejects.toThrow(/Add the student back/);

    // Back on: booked again, and marking charges again.
    await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId }, owner);
    expect(await attendee(t, id)).toMatchObject({ status: 'booked' });
    expect((await mark(t, id, 'present')).charge).toBe('debited');
  });

  it('removing an owed student clears what is owed', async () => {
    const t = await school();
    const id = await lessonIn(t, -24);
    await mark(t, id, 'present');
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 1 });
    await removeAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId }, owner);
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
  });

  it('re-adding a late cancel that kept its credit gives the credit back', async () => {
    const t = await school({ lateCancelReturnsCredit: false });
    await sell(t, t.pkg30);
    const id = await lessonIn(t, 2);
    await cancel(t, id);
    expect((await summary(t)).sessionsAvailable).toBe(3);
    await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId }, owner);
    expect((await summary(t)).sessionsAvailable).toBe(4);
    expect(await attendee(t, id)).toMatchObject({ status: 'booked', cancelledAt: null });
  });
});

describe('cancelLesson', () => {
  it('restores every charged attendee: lot credit, owed lesson, kept late cancel', async () => {
    const t = await school({ lateCancelReturnsCredit: false });
    const ada = t.studentId;
    const ben = await addStudent(t, 'ben');
    const cy = await addStudent(t, 'cy');
    const dee = await addStudent(t, 'dee');
    const sale = await sell(t, t.pkg30);
    await sell(t, t.pkg30, new Date(), undefined, dee);
    const id = await lessonIn(t, 1, [ada, ben, cy, dee]);
    await mark(t, id, 'present', ada); // from Ada's lot
    await mark(t, id, 'present', ben); // owed
    await cancel(t, id, { studentId: dee }); // late, keeps the credit under this policy
    expect(await summary(t, dee)).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });

    const res = await cancelLesson(db, { schoolId: t.schoolId, lessonId: id, reason: 'Teacher ill' }, owner);
    expect(res).toEqual({ restored: 3, alreadyCancelled: false });
    expect(await summary(t, ada)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect(await summary(t, ben)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    expect(await summary(t, dee)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    expect((await lot(t, sale.enrolmentId)).sessionsRemaining).toBe(4);
    for (const s of [ada, ben, cy, dee]) expect((await attendee(t, id, s)).status).toBe('cancelled');
    expect(await lessonDoc(t, id)).toMatchObject({ status: 'cancelled', cancelReason: 'Teacher ill' });

    await expect(mark(t, id, 'present', ada)).rejects.toThrow(/cancelled/);
    expect(await cancelLesson(db, { schoolId: t.schoolId, lessonId: id }, owner)).toEqual({
      restored: 0,
      alreadyCancelled: true,
    });
  });

  it('a credit going back to an expired lot expires again', async () => {
    const t = await school();
    const t0 = new Date(Date.now() - 40 * DAY);
    const sale = await sell(t, t.pkg30, t0);
    const id = await lesson(t, new Date(t0.getTime() + DAY));
    await setAttendance(
      db,
      { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, status: 'present' },
      owner,
      new Date(t0.getTime() + DAY),
    );
    await cancelLesson(db, { schoolId: t.schoolId, lessonId: id }, owner);
    expect(await lot(t, sale.enrolmentId)).toMatchObject({ sessionsRemaining: 3, sessionsUsed: 0, sessionsExpired: 1 });
  });
});

describe('attendanceStateOf', () => {
  it('ignores removed attendees', () => {
    expect(attendanceStateOf(['removed'])).toBe('unmarked');
    expect(attendanceStateOf(['present', 'removed'])).toBe('marked');
    expect(attendanceStateOf(['present', 'booked', 'removed'])).toBe('partial');
  });
});

describe('choosing the package for a lesson', () => {
  const choose = (t: TestSchool, lessonId: string, enrolmentId: string | null) =>
    setAttendeePackage(db, { schoolId: t.schoolId, lessonId, studentId: t.studentId, enrolmentId }, owner);

  it('marking uses the chosen package instead of the earliest-expiring one', async () => {
    const t = await school();
    const soon = await sell(t, t.pkg30);
    const later = await sell(t, t.pkg90);
    const auto = await lesson(t);
    await mark(t, auto, 'present');
    expect((await attendee(t, auto)).enrolmentId).toBe(soon.enrolmentId); // default: earliest expiry

    const chosen = await lesson(t);
    await choose(t, chosen, later.enrolmentId);
    await mark(t, chosen, 'present');
    expect((await attendee(t, chosen)).enrolmentId).toBe(later.enrolmentId);
    expect((await lot(t, later.enrolmentId)).sessionsRemaining).toBe(3);
  });

  it("rejects another student's or unknown package", async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lesson(t);
    await expect(choose(t, id, 'not-a-lot')).rejects.toThrow(/isn't this student's/);
  });

  it('after marking, moves the credit to the chosen package (and back)', async () => {
    const t = await school();
    const soon = await sell(t, t.pkg30);
    const later = await sell(t, t.pkg90);
    const id = await lesson(t);
    await mark(t, id, 'present');
    expect((await attendee(t, id)).enrolmentId).toBe(soon.enrolmentId);

    expect(await choose(t, id, later.enrolmentId)).toEqual({ ok: true, moved: true });
    expect(await attendee(t, id)).toMatchObject({ enrolmentId: later.enrolmentId, owed: false, status: 'present' });
    expect((await lot(t, soon.enrolmentId)).sessionsRemaining).toBe(4);
    expect((await lot(t, later.enrolmentId)).sessionsRemaining).toBe(3);
    expect(await summary(t)).toEqual({ sessionsAvailable: 7, sessionsOwed: 0 });

    // Same package again is a no-op; unmarking gives the credit back to where it now sits.
    expect(await choose(t, id, later.enrolmentId)).toEqual({ ok: true, moved: false });
    await mark(t, id, 'booked');
    expect((await lot(t, later.enrolmentId)).sessionsRemaining).toBe(4);
  });

  it('refuses a package that is used up', async () => {
    const t = await school();
    const soon = await sell(t, t.pkg30);
    const later = await sell(t, t.pkg90);
    for (let i = 0; i < 4; i++) {
      const l = await lesson(t);
      await choose(t, l, later.enrolmentId);
      await mark(t, l, 'present');
    }
    const id = await lesson(t);
    await mark(t, id, 'present');
    expect((await attendee(t, id)).enrolmentId).toBe(soon.enrolmentId);
    await expect(choose(t, id, later.enrolmentId)).rejects.toThrow(/no credits left/);
  });
});

describe('lesson notes for the student', () => {
  it('staff write a note on the attendee; a teacher only on their own lessons', async () => {
    const t = await school();
    const id = await lesson(t);
    await setLessonNote(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, note: '  Breath support, practise scale 3  ' }, owner);
    expect((await attendee(t, id)).sharedNote).toBe('Breath support, practise scale 3');
    const other = { uid: 'teacher-x', role: 'teacher' as const, teacherId: 'someone-else' };
    await expect(setLessonNote(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, note: 'x' }, other)).rejects.toThrow(/own lessons/);
    const mine = { uid: 'teacher-1', role: 'teacher' as const, teacherId: t.teacherId };
    await setLessonNote(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, note: null }, mine);
    expect((await attendee(t, id)).sharedNote).toBeNull();
  });
});

describe('make-ups', () => {
  it('an absence that used a credit gets it back once; packages can cap make-ups', async () => {
    const { grantMakeUp } = await import('../src/jobs');
    const t = await school();
    await db.doc(`schools/${t.schoolId}`).update({ makeUps: { perPackage: 1 } });
    const sale = await sell(t, t.pkg30);
    const first = await lesson(t);
    await mark(t, first, 'absent');
    expect(await summary(t)).toMatchObject({ sessionsAvailable: 3 });
    await grantMakeUp(db, { schoolId: t.schoolId, lessonId: first, studentId: t.studentId }, owner);
    expect(await summary(t)).toMatchObject({ sessionsAvailable: 4 });
    expect((await attendee(t, first)).makeUp).toMatchObject({ enrolmentId: sale.enrolmentId });
    await expect(grantMakeUp(db, { schoolId: t.schoolId, lessonId: first, studentId: t.studentId }, owner)).rejects.toThrow(/already/);
    const second = await lesson(t);
    await mark(t, second, 'absent');
    await expect(grantMakeUp(db, { schoolId: t.schoolId, lessonId: second, studentId: t.studentId }, owner)).rejects.toThrow(/limit is 1/);
  });

  it('present lessons are not eligible', async () => {
    const { grantMakeUp } = await import('../src/jobs');
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lesson(t);
    await mark(t, id, 'present');
    await expect(grantMakeUp(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId }, owner)).rejects.toThrow(/absences and late cancels/);
  });
});

describe('deleteLesson', () => {
  const del = (t: TestSchool, lessonId: string) => deleteLesson(db, { schoolId: t.schoolId, lessonId }, owner);

  it('removes an unmarked lesson and its attendees; no credit moves', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lesson(t);
    expect(await del(t, id)).toEqual({ deleted: true });
    expect((await db.doc(`schools/${t.schoolId}/lessons/${id}`).get()).exists).toBe(false);
    expect((await db.collection(`schools/${t.schoolId}/lessons/${id}/attendees`).get()).empty).toBe(true);
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });

  it('refuses while a credit is used; works once unmarked', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lesson(t);
    await mark(t, id, 'present');
    await expect(del(t, id)).rejects.toThrow(/Unmark the students first/);
    await mark(t, id, 'booked');
    await del(t, id);
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });

  it('deletes a lesson students cancelled on time', async () => {
    const t = await school();
    await sell(t, t.pkg30);
    const id = await lessonIn(t, 72);
    await cancel(t, id);
    await del(t, id);
    expect((await db.doc(`schools/${t.schoolId}/lessons/${id}`).get()).exists).toBe(false);
  });
});
