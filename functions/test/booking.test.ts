import { describe, expect, it } from 'vitest';
import { wallClockToUtc, type Availability } from '@lessonkaki/shared';
import { cancelAttendance, setAttendance } from '../src/attendance';
import { bookLesson, getAvailability } from '../src/booking';
import type { Actor } from '../src/db';
import { createLesson } from '../src/lessons';
import { addStudent, attendee, db, ledger, lessonDoc, owner, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const TZ = 'Asia/Singapore';
const sg = (date: string, time: string) => wallClockToUtc(date, time, TZ);
// 2027-01-04 is a Monday; "now" is the Sunday morning before.
const NOW = sg('2027-01-03', '09:00');
const MON = '2027-01-04';
const TUE = '2027-01-05';

const HOURS: Availability = {
  weekly: [
    { day: 'MO', start: '10:00', end: '12:00', inPerson: true, online: true, locationId: 'studio' },
    { day: 'TU', start: '10:00', end: '12:00', inPerson: false, online: true },
  ],
  minNoticeHours: 0,
  horizonDays: 14,
};

async function setup(hours: Availability = HOURS, maxUpcoming?: number) {
  const t = await school();
  await db.doc(`schools/${t.schoolId}/availability/${t.teacherId}`).set({ ...hours, subjectId: t.subjectId });
  if (maxUpcoming !== undefined) await db.doc(`schools/${t.schoolId}`).update({ booking: { maxUpcoming } });
  return t;
}

const student = (t: TestSchool, studentId = t.studentId): Actor => ({ uid: `uid-${studentId}`, role: 'student', studentId });

const book = (t: TestSchool, date: string, time: string, opts: { as?: Actor; mode?: 'inPerson' | 'online'; at?: Date } = {}) =>
  bookLesson(
    db,
    { schoolId: t.schoolId, teacherId: t.teacherId, startAt: sg(date, time), mode: opts.mode ?? 'inPerson' },
    opts.as ?? student(t),
    opts.at ?? NOW,
  );

const hhmm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** Open slot times on one date, as the given actor sees them. */
async function slotTimes(t: TestSchool, as: Actor = student(t), date = MON) {
  const res = await getAvailability(db, { schoolId: t.schoolId }, as, NOW);
  const day = sg(date, '00:00').getTime();
  return res.slots.filter((s) => Date.parse(s.startAt) >= day && Date.parse(s.startAt) < day + 86_400_000).map((s) => hhmm(s.startAt));
}

/** A 45-minute lesson the owner scheduled. */
async function staffLesson(t: TestSchool, date: string, time: string, studentId: string, teacherId = t.teacherId) {
  const { lessonId } = await createLesson(
    db,
    { schoolId: t.schoolId, teacherId, subjectId: t.subjectId, startAt: sg(date, time), durationMin: 45, studentIds: [studentId], isOnline: false },
    owner,
  );
  return lessonId;
}

describe('getAvailability', () => {
  it('lists open slots for bookable teachers', async () => {
    const t = await setup();
    const res = await getAvailability(db, { schoolId: t.schoolId }, student(t), NOW);
    expect(res.teachers).toEqual([{ teacherId: t.teacherId, name: 'Teacher One', lessonMin: 45, inPerson: true, online: true }]);
    expect(res.upcoming).toEqual({ booked: 0, max: null }); // no cap unless the school sets one
    expect(await slotTimes(t)).toEqual(['10:00', '10:30', '11:00']);
    const tuesday = res.slots.find((s) => Date.parse(s.startAt) >= sg(TUE, '00:00').getTime());
    expect(tuesday).toMatchObject({ inPerson: false, online: true });
  });

  it("blocks the teacher's other lessons plus the buffer, and frees a slot once its student cancels", async () => {
    const t = await setup();
    const other = await addStudent(t, 'other');
    const lessonId = await staffLesson(t, MON, '11:15', other);
    expect(await slotTimes(t)).toEqual(['10:00']);
    await cancelAttendance(db, { schoolId: t.schoolId, lessonId, studentId: other }, owner, NOW);
    expect(await slotTimes(t)).toEqual(['10:00', '10:30', '11:00']);
  });

  it("hides times that clash with the student's own lessons with anyone", async () => {
    const t = await setup();
    await staffLesson(t, MON, '10:30', t.studentId, 'teacher2');
    expect(await slotTimes(t)).toEqual([]);
    await addStudent(t, 'other');
    expect(await slotTimes(t, student(t, 'other'))).toEqual(['10:00', '10:30', '11:00']);
  });

  it('skips teachers who are not bookable or have no hours', async () => {
    const t = await setup({ ...HOURS, bookable: false });
    await db.doc(`schools/${t.schoolId}/availability/teacher2`).set({ weekly: [] });
    expect((await getAvailability(db, { schoolId: t.schoolId }, student(t), NOW)).teachers).toEqual([]);
  });

  it('lets staff preview, without a student', async () => {
    const t = await setup();
    const res = await getAvailability(db, { schoolId: t.schoolId }, owner, NOW);
    expect(res.slots).toHaveLength(12); // two Mondays and two Tuesdays, three starts each
    expect(res.upcoming).toBeNull();
  });
});

describe('bookLesson', () => {
  it('creates a one-on-one portal lesson, alerts the owner and charges nothing', async () => {
    const t = await setup();
    const { lessonId, existing } = await book(t, MON, '10:30');
    expect(existing).toBe(false);
    const l = await lessonDoc(t, lessonId);
    expect(l).toMatchObject({
      teacherId: t.teacherId,
      subjectId: t.subjectId,
      studentIds: [t.studentId],
      durationMin: 45,
      isOnline: false,
      locationId: 'studio',
      status: 'scheduled',
    });
    expect(l.startAt.toDate()).toEqual(sg(MON, '10:30'));
    expect(await attendee(t, lessonId)).toMatchObject({ status: 'booked', source: 'portal', ledgerEntryId: null });
    expect(await ledger(t)).toEqual([]);
    const alert = (await db.doc(`schools/${t.schoolId}/alerts/lesson_${lessonId}`).get()).data()!;
    expect(alert).toMatchObject({ type: 'lesson.booked', actorRole: 'student', data: { source: 'portal', studentIds: [t.studentId], payment: null } });
    // Another student: 10:30 plus the 15-minute buffer covers every Monday start.
    await addStudent(t, 'other');
    expect(await slotTimes(t, student(t, 'other'))).toEqual([]);
  });

  it('is never blocked by credit: a student with none books, and the lesson goes owed when marked', async () => {
    const t = await setup();
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    const { lessonId } = await book(t, MON, '10:00', { mode: 'online' });
    expect((await lessonDoc(t, lessonId)).isOnline).toBe(true);
    await setAttendance(db, { schoolId: t.schoolId, lessonId, studentId: t.studentId, status: 'present' }, owner);
    expect(await summary(t)).toEqual({ sessionsAvailable: 0, sessionsOwed: 1 });
  });

  it('returns the existing lesson when the same booking is sent twice', async () => {
    const t = await setup();
    const first = await book(t, MON, '10:00');
    expect(await book(t, MON, '10:00')).toEqual({ lessonId: first.lessonId, existing: true });
    expect((await db.collection(`schools/${t.schoolId}/lessons`).get()).size).toBe(1);
  });

  it('refuses a taken or overlapping time', async () => {
    const t = await setup();
    await addStudent(t, 'other');
    await book(t, MON, '10:00');
    await expect(book(t, MON, '10:00', { as: student(t, 'other') })).rejects.toThrow(/no longer available/);
    await expect(book(t, MON, '10:30', { as: student(t, 'other') })).rejects.toThrow(/no longer available/);
  });

  it('serialises racing bookings for the same teacher and day', async () => {
    const t = await setup();
    await addStudent(t, 'other');
    const results = await Promise.allSettled([book(t, MON, '10:00'), book(t, MON, '10:30', { as: student(t, 'other') })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.collection(`schools/${t.schoolId}/lessons`).get()).size).toBe(1);
  });

  it('only accepts times inside the hours, notice, horizon and mode', async () => {
    const t = await setup({ ...HOURS, minNoticeHours: 2 });
    await expect(book(t, MON, '11:30')).rejects.toThrow(/no longer available/); // runs past the end of the block
    await expect(book(t, MON, '10:15')).rejects.toThrow(/no longer available/); // not on the 30-minute step
    await expect(book(t, TUE, '10:00', { mode: 'inPerson' })).rejects.toThrow(/online only/);
    await expect(book(t, MON, '10:00', { at: sg(MON, '09:00') })).rejects.toThrow(/no longer available/); // under 2 h notice
    await expect(book(t, MON, '10:00', { at: sg('2026-12-01', '09:00') })).rejects.toThrow(/no longer available/); // past the horizon
    await db.doc(`schools/${t.schoolId}/availability/${t.teacherId}`).update({ exceptions: [{ date: MON, closed: true }] });
    await expect(book(t, MON, '10:00')).rejects.toThrow(/no longer available/);
  });

  it('has no cap on upcoming bookings by default', async () => {
    const t = await setup();
    await book(t, MON, '10:00');
    await book(t, MON, '11:00', { mode: 'online' });
    await expect(book(t, TUE, '10:00', { mode: 'online' })).resolves.toMatchObject({ existing: false });
  });

  it('caps upcoming portal bookings per student when the school sets one; lessons staff scheduled do not count', async () => {
    const t = await setup(HOURS, 1);
    await book(t, MON, '10:00');
    await expect(book(t, TUE, '11:00', { mode: 'online' })).rejects.toThrow(/up to 1 upcoming/);
    const t2 = await setup(HOURS, 1);
    await staffLesson(t2, '2027-01-06', '15:00', t2.studentId);
    await expect(book(t2, MON, '10:00')).resolves.toMatchObject({ existing: false });
  });

  it('refuses a time the student already has a lesson at, with anyone', async () => {
    const t = await setup();
    await staffLesson(t, MON, '10:30', t.studentId, 'teacher2');
    await expect(book(t, MON, '10:00')).rejects.toThrow(/already have a lesson/);
  });

  it('is for students only, and not for archived students or unbookable teachers', async () => {
    const t = await setup();
    await expect(book(t, MON, '10:00', { as: owner })).rejects.toThrow(/Only students/);
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ status: 'archived' });
    await expect(book(t, MON, '10:00')).rejects.toThrow(/archived/);
    const t2 = await setup({ ...HOURS, bookable: false });
    await expect(book(t2, MON, '10:00')).rejects.toThrow(/not taking bookings/);
  });

  it("a student's on-time cancel frees the slot for someone else", async () => {
    const t = await setup();
    await addStudent(t, 'other');
    const { lessonId } = await book(t, MON, '10:00');
    await cancelAttendance(db, { schoolId: t.schoolId, lessonId, studentId: t.studentId }, student(t), NOW);
    await expect(book(t, MON, '10:00', { as: student(t, 'other') })).resolves.toMatchObject({ existing: false });
  });
});

describe('group lessons (subject capacity)', () => {
  const groupOf = async (t: TestSchool, capacity: number) => {
    await db.doc(`schools/${t.schoolId}/subjects/${t.subjectId}`).update({ capacity });
    return t;
  };

  it('capacity 1 (default): a booked time disappears', async () => {
    const t = await setup();
    await book(t, MON, '10:30');
    const other = await addStudent(t, 'other');
    expect(await slotTimes(t, student(t, other))).toEqual([]);
  });

  it('a lesson with places left stays bookable at its own time only, and booking joins it', async () => {
    const t = await groupOf(await setup(), 3);
    const first = await book(t, MON, '10:30');
    const b = await addStudent(t, 'b');
    const c = await addStudent(t, 'c');
    const d = await addStudent(t, 'd');
    const res = await getAvailability(db, { schoolId: t.schoolId }, student(t, b), NOW);
    const mon = res.slots.filter((s) => Date.parse(s.startAt) < sg(TUE, '00:00').getTime());
    expect(mon.map((s) => [hhmm(s.startAt), s.spotsLeft])).toEqual([['10:30', 2]]); // 10:00 and 11:00 overlap it
    const joined = await book(t, MON, '10:30', { as: student(t, b) });
    expect(joined.lessonId).toBe(first.lessonId);
    await book(t, MON, '10:30', { as: student(t, c) });
    const l = await lessonDoc(t, first.lessonId);
    expect([...l.studentIds].sort()).toEqual([t.studentId, b, c].sort());
    expect(await attendee(t, first.lessonId, c)).toMatchObject({ status: 'booked', source: 'portal' });
    // Full now: gone for everyone else, and booking it fails.
    expect(await slotTimes(t, student(t, d))).toEqual([]);
    await expect(book(t, MON, '10:30', { as: student(t, d) })).rejects.toThrow(/no longer available/);
  });

  it('a group lesson of another length or subject is just busy', async () => {
    const t = await groupOf(await setup(), 5);
    const other = await addStudent(t, 'other');
    await createLesson(
      db,
      { schoolId: t.schoolId, teacherId: t.teacherId, subjectId: t.subjectId, startAt: sg(MON, '10:30'), durationMin: 60, studentIds: [other], isOnline: false },
      owner,
    );
    expect(await slotTimes(t)).toEqual([]);
  });
});
