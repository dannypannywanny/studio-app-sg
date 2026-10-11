import { describe, expect, it } from 'vitest';
import { setAttendance } from '../src/attendance';
import { createLesson } from '../src/lessons';
import { createSeries, editLesson, extendOneSeries, lessonIdFor, type CreateSeriesInput } from '../src/series';
import { DAY, attendee, db, lessonDoc, owner, sell, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();

// Mon 12 Oct 2026, 10:00 in Singapore. The series starts Wed 14 Oct, 19:00 SGT (11:00 UTC).
const AT = new Date('2026-10-12T02:00:00Z');
const WEDNESDAYS = [
  '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11', '2026-11-18',
  '2026-11-25', '2026-12-02', '2026-12-09', '2026-12-16', '2026-12-23', '2026-12-30',
];

const base = (t: TestSchool, extra: Partial<CreateSeriesInput> = {}): CreateSeriesInput => ({
  schoolId: t.schoolId,
  teacherId: t.teacherId,
  subjectId: t.subjectId,
  startDate: '2026-10-14',
  time: '19:00',
  durationMin: 60,
  byDay: ['WE'],
  studentIds: [t.studentId],
  isOnline: false,
  ...extra,
});

async function seriesLessons(t: TestSchool, seriesId: string) {
  const snap = await db.collection(`schools/${t.schoolId}/lessons`).where('seriesId', '==', seriesId).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, any> & { id: string })
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
}

const single = (t: TestSchool, iso: string) =>
  createLesson(
    db,
    {
      schoolId: t.schoolId,
      teacherId: t.teacherId,
      subjectId: t.subjectId,
      startAt: new Date(iso),
      durationMin: 60,
      studentIds: [t.studentId],
      isOnline: false,
    },
    owner,
  );

describe('createSeries', () => {
  it('materialises 12 weeks of lessons at the wall-clock time, with deterministic ids', async () => {
    const t = await school();
    const res = await createSeries(db, base(t), owner, AT);
    expect(res.skipped).toEqual([]);
    expect(res.lessonIds).toEqual(WEDNESDAYS.map((d) => lessonIdFor(res.seriesId, d)));

    const lessons = await seriesLessons(t, res.seriesId);
    expect(lessons).toHaveLength(12);
    expect(lessons[0]!.startAt.toDate().toISOString()).toBe('2026-10-14T11:00:00.000Z');
    expect(lessons[0]).toMatchObject({ occurrenceDate: '2026-10-14', status: 'scheduled', isException: false });
    expect(await attendee(t, lessons[0]!.id)).toMatchObject({ status: 'booked', schoolId: t.schoolId });

    const series = (await db.doc(`schools/${t.schoolId}/series/${res.seriesId}`).get()).data()!;
    expect(series).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
      time: '19:00',
      timezone: 'Asia/Singapore',
      materialisedThrough: '2027-01-06',
      active: true,
    });
  });

  it('handles several weekdays', async () => {
    const t = await school();
    const res = await createSeries(db, base(t, { byDay: ['MO', 'WE'] }), owner, AT);
    expect(res.lessonIds).toHaveLength(24);
  });

  it('conflict-checks every occurrence; skipConflicts leaves the clashing dates out', async () => {
    const t = await school();
    await single(t, '2026-10-28T11:30:00Z');
    await expect(createSeries(db, base(t), owner, AT)).rejects.toThrow(/2026-10-28/);
    expect((await db.collection(`schools/${t.schoolId}/series`).get()).size).toBe(0);

    const res = await createSeries(db, base(t, { skipConflicts: true }), owner, AT);
    expect(res.skipped).toEqual(['2026-10-28']);
    expect(res.lessonIds).toHaveLength(11);
    const series = (await db.doc(`schools/${t.schoolId}/series/${res.seriesId}`).get()).data()!;
    expect(series.exdates).toEqual(['2026-10-28']);
  });

  it('stops at until', async () => {
    const t = await school();
    const res = await createSeries(db, base(t, { until: '2026-11-04' }), owner, AT);
    expect(res.lessonIds).toHaveLength(4);
  });
});

describe('extendSeries', () => {
  it('adds the next weeks once, skipping clashes', async () => {
    const t = await school();
    const { seriesId } = await createSeries(db, base(t), owner, AT);
    await single(t, '2027-01-13T11:00:00Z'); // clashes with the second new Wednesday

    const later = new Date(AT.getTime() + 14 * DAY);
    expect(await extendOneSeries(db, t.schoolId, seriesId, later)).toEqual({ created: 1, skipped: ['2027-01-13'] });
    expect(await extendOneSeries(db, t.schoolId, seriesId, later)).toEqual({ created: 0, skipped: [] });
    const lessons = await seriesLessons(t, seriesId);
    expect(lessons.map((l) => l.occurrenceDate).slice(-2)).toEqual(['2026-12-30', '2027-01-06']);
    const series = (await db.doc(`schools/${t.schoolId}/series/${seriesId}`).get()).data()!;
    expect(series.exdates).toEqual(['2027-01-13']);
    expect(series.materialisedThrough).toBe('2027-01-18');
  });
});

describe('editLesson', () => {
  it("scope one moves a single occurrence and marks it as an exception", async () => {
    const t = await school();
    const { seriesId } = await createSeries(db, base(t), owner, AT);
    const id = lessonIdFor(seriesId, '2026-10-21');
    const res = await editLesson(db, { schoolId: t.schoolId, lessonId: id, scope: 'one', changes: { time: '19:30' } }, owner, AT);
    expect(res.updated).toBe(1);
    const l = await lessonDoc(t, id);
    expect(l.startAt.toDate().toISOString()).toBe('2026-10-21T11:30:00.000Z');
    expect(l.isException).toBe(true);
    expect((await attendee(t, id)).lessonStartAt.toMillis()).toBe(l.startAt.toMillis());

    await single(t, '2026-10-28T13:00:00Z');
    await expect(
      editLesson(db, { schoolId: t.schoolId, lessonId: lessonIdFor(seriesId, '2026-10-28'), scope: 'one', changes: { time: '21:30' } }, owner, AT),
    ).rejects.toThrow(/already has a lesson/);
  });

  it('scope following splits the series and never touches past, marked or one-off lessons', async () => {
    const t = await school();
    await sell(t, t.pkg90);
    const { seriesId } = await createSeries(db, base(t), owner, AT);
    const id = (d: string) => lessonIdFor(seriesId, d);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id('2026-10-14'), studentId: t.studentId, status: 'present' }, owner);
    await editLesson(db, { schoolId: t.schoolId, lessonId: id('2026-11-11'), scope: 'one', changes: { durationMin: 45 } }, owner, AT);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id('2026-11-18'), studentId: t.studentId, status: 'present' }, owner);
    const before14 = await lessonDoc(t, id('2026-10-14'));

    const at = new Date('2026-10-20T00:00:00Z');
    const res = await editLesson(
      db,
      { schoolId: t.schoolId, lessonId: id('2026-11-04'), scope: 'following', changes: { time: '18:00' } },
      owner,
      at,
    );
    expect(res).toMatchObject({ created: 8, deleted: 7, skipped: [] });
    expect(res.seriesId).not.toBe(seriesId);

    // Old series: up to 3 Nov, and its pre-pivot lessons, the one-off and the marked lesson stay.
    const old = await seriesLessons(t, seriesId);
    expect(old.map((l) => l.occurrenceDate)).toEqual(['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-11', '2026-11-18']);
    expect(await lessonDoc(t, id('2026-10-14'))).toEqual(before14);
    expect(await attendee(t, id('2026-10-14'))).toMatchObject({ status: 'present' });
    expect((await db.doc(`schools/${t.schoolId}/series/${seriesId}`).get()).get('until')).toBe('2026-11-03');

    // New series from 4 Nov at 18:00, without the dates the kept lessons stand in for.
    const fresh = await seriesLessons(t, res.seriesId!);
    expect(fresh.map((l) => l.occurrenceDate)).toEqual([
      '2026-11-04', '2026-11-25', '2026-12-02', '2026-12-09', '2026-12-16', '2026-12-23', '2026-12-30',
      '2027-01-06', // today + 12 weeks, the same horizon extendSeries keeps
    ]);
    expect(fresh[0]!.startAt.toDate().toISOString()).toBe('2026-11-04T10:00:00.000Z');
    const newSeries = (await db.doc(`schools/${t.schoolId}/series/${res.seriesId}`).get()).data()!;
    expect(newSeries).toMatchObject({ startDate: '2026-11-04', time: '18:00', splitFrom: seriesId, active: true });
    expect(await summary(t)).toEqual({ sessionsAvailable: 2, sessionsOwed: 0 });
  });

  it('scope all rewrites every future placeholder in place and leaves the past alone', async () => {
    const t = await school();
    const { seriesId } = await createSeries(db, base(t), owner, AT);
    const at = new Date('2026-10-20T00:00:00Z');
    const res = await editLesson(
      db,
      { schoolId: t.schoolId, lessonId: lessonIdFor(seriesId, '2026-11-04'), scope: 'all', changes: { time: '18:30', durationMin: 45 } },
      owner,
      at,
    );
    expect(res.seriesId).toBe(seriesId);
    const lessons = await seriesLessons(t, seriesId);
    expect(lessons).toHaveLength(13); // 14 Oct (past) + 21 Oct .. 6 Jan
    expect(lessons[0]!.startAt.toDate().toISOString()).toBe('2026-10-14T11:00:00.000Z'); // past: untouched
    expect(lessons[1]!.startAt.toDate().toISOString()).toBe('2026-10-21T10:30:00.000Z');
    expect(lessons[1]!.durationMin).toBe(45);
    expect(await attendee(t, lessons[1]!.id)).toMatchObject({ status: 'booked' });
    expect((await db.doc(`schools/${t.schoolId}/series/${seriesId}`).get()).get('time')).toBe('18:30');
  });

  it('cancel following ends the series: placeholders go, kept future lessons are cancelled and refunded', async () => {
    const t = await school();
    await sell(t, t.pkg90);
    const { seriesId } = await createSeries(db, base(t), owner, AT);
    const id = (d: string) => lessonIdFor(seriesId, d);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: id('2026-11-18'), studentId: t.studentId, status: 'present' }, owner);
    expect((await summary(t)).sessionsAvailable).toBe(3);

    const res = await editLesson(
      db,
      { schoolId: t.schoolId, lessonId: id('2026-11-04'), scope: 'following', cancel: { reason: 'Moving away' } },
      owner,
      AT,
    );
    expect(res).toMatchObject({ deleted: 8, cancelled: 1, restored: 1 });
    expect(await summary(t)).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
    const left = await seriesLessons(t, seriesId);
    expect(left.map((l) => [l.occurrenceDate, l.status])).toEqual([
      ['2026-10-14', 'scheduled'],
      ['2026-10-21', 'scheduled'],
      ['2026-10-28', 'scheduled'],
      ['2026-11-18', 'cancelled'],
    ]);
    const series = (await db.doc(`schools/${t.schoolId}/series/${seriesId}`).get()).data()!;
    expect(series).toMatchObject({ until: '2026-11-03', active: true });
    // Extending later never goes past until.
    expect((await extendOneSeries(db, t.schoolId, seriesId, new Date(AT.getTime() + 30 * DAY))).created).toBe(0);
  });

  it('cancel one leaves the rest of the series alone', async () => {
    const t = await school();
    const { seriesId } = await createSeries(db, base(t), owner, AT);
    const res = await editLesson(
      db,
      { schoolId: t.schoolId, lessonId: lessonIdFor(seriesId, '2026-10-21'), scope: 'one', cancel: {} },
      owner,
      AT,
    );
    expect(res.cancelled).toBe(1);
    const lessons = await seriesLessons(t, seriesId);
    expect(lessons.filter((l) => l.status === 'cancelled').map((l) => l.occurrenceDate)).toEqual(['2026-10-21']);
    expect(lessons).toHaveLength(12);
  });
});
