import { describe, expect, it } from 'vitest';
import { setAttendance } from '../src/attendance';
import { teacherPay, teacherRoster } from '../src/teachers';
import { DAY, db, lesson, owner, sell, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const range = () => ({ from: new Date(Date.now() - 30 * DAY).toISOString(), to: new Date(Date.now() + DAY).toISOString() });
const asTeacher = (t: TestSchool) => ({ uid: 'tu', role: 'teacher' as const, teacherId: t.teacherId });

async function taughtTwo(t: TestSchool) {
  await sell(t, t.pkg30); // 30000 for 4 sessions = 7500 per credit
  for (const status of ['present', 'absent'] as const) {
    const id = await lesson(t); // 60 min
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id, studentId: t.studentId, status }, owner);
  }
  await lesson(t); // not marked: not paid
}

describe('teacherPay', () => {
  it('per lesson, hourly and percent', async () => {
    const t = await school();
    await taughtTwo(t);
    const ref = db.doc(`schools/${t.schoolId}/teachers/${t.teacherId}`);
    const pay = async () => (await teacherPay(db, { schoolId: t.schoolId, ...range() }, owner)).rows.find((r) => r.teacherId === t.teacherId)!;
    await ref.update({ pay: { method: 'perLesson', rateCents: 4000 } });
    expect(await pay()).toMatchObject({ lessons: 2, minutes: 120, amountCents: 8000 });
    await ref.update({ pay: { method: 'hourly', rateCents: 5000 } });
    expect((await pay()).amountCents).toBe(10000);
    await ref.update({ pay: { method: 'percent', percent: 60 } });
    expect(await pay()).toMatchObject({ creditValueCents: 15000, amountCents: 9000, unvalued: 0 });
  });

  it('a teacher sees only their own', async () => {
    const t = await school();
    await taughtTwo(t);
    const res = await teacherPay(db, { schoolId: t.schoolId, ...range() }, asTeacher(t));
    expect(res.rows.map((r) => r.teacherId)).toEqual([t.teacherId]);
    await expect(teacherPay(db, { schoolId: t.schoolId, ...range(), teacherId: 'other' }, asTeacher(t))).rejects.toThrow(/only their own/);
  });
});

describe('teacherRoster', () => {
  it('names and notes of students on the teacher’s lessons only', async () => {
    const t = await school();
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ notes: 'Asthma: keep water nearby', email: 'x@y.test' });
    await lesson(t);
    const res = await teacherRoster(db, { schoolId: t.schoolId }, asTeacher(t));
    expect(res.students).toHaveLength(1);
    expect(res.students[0]).toMatchObject({ id: t.studentId, notes: 'Asthma: keep water nearby' });
    expect(res.students[0]).not.toHaveProperty('email');
  });
});
