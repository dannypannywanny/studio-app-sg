import { describe, expect, it } from 'vitest';
import { getAuth } from 'firebase-admin/auth';
import { addAttendee, removeAttendee, setAttendance } from '../src/attendance';
import { inviteStudents } from '../src/invites';
import { createLesson } from '../src/lessons';
import { createSeries } from '../src/series';
import { attendee, db, lessonDoc, owner, sell, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const HOUR = 3_600_000;

async function addLead(t: TestSchool, id = 'lead1', stage = 'new') {
  await db.doc(`schools/${t.schoolId}/students/${id}`).set({
    firstName: 'John',
    lastName: 'Tan',
    email: `${id}@example.com`,
    status: 'lead',
    lead: { stage },
    summary: { sessionsAvailable: 0, sessionsOwed: 0 },
  });
  return id;
}

let slot = 0;
const trial = (t: TestSchool, studentIds: string[], hours = -24) =>
  createLesson(
    db,
    {
      schoolId: t.schoolId,
      teacherId: t.teacherId,
      subjectId: t.subjectId,
      startAt: new Date(Date.now() + hours * HOUR + slot++ * 61 * 60_000),
      durationMin: 30,
      studentIds,
      isOnline: false,
    },
    owner,
  ).then((r) => r.lessonId);

const stageOf = async (t: TestSchool, id: string) => (await db.doc(`schools/${t.schoolId}/students/${id}`).get()).get('lead.stage');
const mark = (t: TestSchool, lessonId: string, studentId: string, status: 'present' | 'absent' | 'booked') =>
  setAttendance(db, { schoolId: t.schoolId, lessonId, studentId, status }, owner);

describe('trial lessons for leads', () => {
  it('books a lead as a trial: flagged on the lesson and attendee, and the lead moves to "Trial booked"', async () => {
    const t = await school();
    const lead = await addLead(t);
    const id = await trial(t, [lead]);
    expect(await lessonDoc(t, id)).toMatchObject({ studentIds: [lead], trialStudentIds: [lead], durationMin: 30 });
    expect(await attendee(t, id, lead)).toMatchObject({ trial: true, status: 'booked' });
    expect(await stageOf(t, lead)).toBe('trial');
  });

  it('a trial with no package is free: marking present takes nothing and owes nothing', async () => {
    const t = await school();
    const lead = await addLead(t);
    const id = await trial(t, [lead]);
    expect((await mark(t, id, lead, 'present')).charge).toBe('none');
    expect(await attendee(t, id, lead)).toMatchObject({ status: 'present', owed: false, ledgerEntryId: null });
    expect(await summary(t, lead)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    expect((await mark(t, id, lead, 'booked')).charge).toBe('none');
  });

  it('a lead who bought a trial package uses that credit', async () => {
    const t = await school();
    const lead = await addLead(t);
    await db.doc(`schools/${t.schoolId}/packages/trial`).set({
      name: 'Trial lesson',
      sessions: 1,
      priceCents: 3000,
      validityDays: 30,
      kind: 'trial',
      oncePerStudent: true,
      active: true,
    });
    await sell(t, 'trial', new Date(Date.now() - 3 * 24 * HOUR), undefined, lead);
    const id = await trial(t, [lead]);
    expect((await mark(t, id, lead, 'present')).charge).toBe('debited');
    expect(await summary(t, lead)).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    expect((await mark(t, id, lead, 'booked')).charge).toBe('restored');
  });

  it('students on the same lesson are charged as usual', async () => {
    const t = await school();
    const lead = await addLead(t);
    const id = await trial(t, [t.studentId, lead]);
    expect((await lessonDoc(t, id)).trialStudentIds).toEqual([lead]);
    expect((await mark(t, id, t.studentId, 'present')).charge).toBe('owed');
    expect(await attendee(t, id, t.studentId)).not.toHaveProperty('trial');
  });

  it('adding a lead to an existing lesson makes them a trial; won or lost leads keep their stage', async () => {
    const t = await school();
    const lead = await addLead(t);
    const lost = await addLead(t, 'lead2', 'lost');
    const id = await trial(t, [t.studentId], 24);
    await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: lead }, owner);
    await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: lost }, owner);
    expect((await lessonDoc(t, id)).trialStudentIds).toEqual([lead, lost]);
    expect(await attendee(t, id, lead)).toMatchObject({ trial: true });
    expect(await stageOf(t, lead)).toBe('trial');
    expect(await stageOf(t, lost)).toBe('lost');
    // Off and back on: still a trial, still free.
    await removeAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: lead }, owner);
    await addAttendee(db, { schoolId: t.schoolId, lessonId: id, studentId: lead }, owner);
    expect(await attendee(t, id, lead)).toMatchObject({ trial: true, status: 'booked' });
  });

  it('a student converted from a lead is charged normally on new lessons', async () => {
    const t = await school();
    const lead = await addLead(t);
    await db.doc(`schools/${t.schoolId}/students/${lead}`).update({ status: 'active', 'lead.stage': 'won' });
    const id = await trial(t, [lead]);
    expect((await lessonDoc(t, id)).trialStudentIds).toBeUndefined();
    expect((await mark(t, id, lead, 'present')).charge).toBe('owed');
  });

  it('leads cannot be put on weekly lessons', async () => {
    const t = await school();
    const lead = await addLead(t);
    await expect(
      createSeries(
        db,
        {
          schoolId: t.schoolId,
          teacherId: t.teacherId,
          subjectId: t.subjectId,
          startDate: '2026-10-14',
          time: '19:00',
          durationMin: 30,
          byDay: ['WE'],
          studentIds: [lead],
          isOnline: false,
        },
        owner,
        new Date('2026-10-12T00:00:00Z'),
      ),
    ).rejects.toThrow(/single trial lesson/);
  });

  it('leads get no portal login', async () => {
    const t = await school();
    const lead = await addLead(t);
    const [r] = await inviteStudents(db, getAuth(), { schoolId: t.schoolId, studentIds: [lead] }, owner);
    expect(r).toMatchObject({ outcome: 'lead' });
  });
});
