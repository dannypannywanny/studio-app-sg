import { describe, expect, it } from 'vitest';
import { setAttendance } from '../src/attendance';
import { expireLots } from '../src/jobs';
import {
  applyReplay,
  linkEvents,
  reopenForPending,
  planReplay,
  planTotals,
  promoSessions,
  sessionsForPrice,
  type CcBooking,
  type CcEvent,
  type CcInvoice,
  type ReplayInput,
} from '../src/replay';
import { addStudent, db, owner, reconcileSchool, summary, withInvariant, type TestSchool } from './helpers';

const NOW = '2026-10-13T04:00:00.000Z';
const actor = { uid: 'script:replay', role: 'system' as const };

const booking = (o: Partial<CcBooking> & { bookingId: string }): CcBooking => ({
  ccId: '10',
  invoiceId: '100',
  startUTC: '2026-01-05T08:00',
  endUTC: '2026-01-05T08:45',
  kind: 'L',
  createdUTC: '2026-01-01T02:00:00',
  ...o,
});
const event = (o: Partial<CcEvent> & { eventId: string }): CcEvent => ({
  startUTC: '2026-01-05T08:00',
  endUTC: '2026-01-05T08:45',
  tag: 'C',
  marked: true,
  classId: 'c1',
  online: true,
  createdUTC: '2026-01-01T02:00:00',
  ...o,
});
const invoice = (o: Partial<CcInvoice> & { invoiceId: string }): CcInvoice => ({
  number: `N${o.invoiceId}`,
  ccId: '10',
  date: '2026-01-01',
  amountSGD: 300,
  paid: true,
  ...o,
});
const input = (o: Partial<ReplayInput>): ReplayInput => ({
  bookings: [],
  events: [],
  invoices: [],
  studentKeys: { '10': 'doc:s10' },
  now: NOW,
  ...o,
});

describe('package sizes', () => {
  it('sizes by price, promo by purchase date, and flags the Dec-2025 promo', () => {
    expect(sessionsForPrice(750, '2026-01-01')).toEqual({ sessions: 12, check: false });
    expect(sessionsForPrice(300, '2026-01-01')).toEqual({ sessions: 4, check: false });
    expect(sessionsForPrice(100, '2026-01-01')).toEqual({ sessions: 1, check: false });
    expect(sessionsForPrice(195, '2026-09-07')).toEqual({ sessions: 4, check: false });
    expect(sessionsForPrice(195, '2026-09-20')).toEqual({ sessions: 3, check: false });
    expect(sessionsForPrice(150, '2025-12-10')).toEqual({ sessions: 4, check: true });
    expect(sessionsForPrice(61, '2026-01-01')).toBeNull();
    expect(promoSessions('2026-10-02')).toBe(3);
  });
});

describe('linkEvents', () => {
  it('links by created second + start, then order, then start, then near created time', () => {
    const bookings = [
      booking({ bookingId: 'b1', startUTC: '2026-01-05T08:00', createdUTC: '2026-01-01T02:00:00' }),
      // two bookings made together; the second lesson was moved, so only the order can pair it
      booking({ bookingId: 'b2', startUTC: '2026-01-06T08:00', createdUTC: '2026-01-02T02:00:00' }),
      booking({ bookingId: 'b3', startUTC: '2026-01-13T08:00', createdUTC: '2026-01-02T02:00:00' }),
      booking({ bookingId: 'b4', startUTC: '2026-02-02T08:00', createdUTC: '2026-01-10T00:00:00' }),
      booking({ bookingId: 'b5', startUTC: '2026-03-02T08:00', createdUTC: '2026-01-20T10:00:00' }),
    ];
    const events = [
      event({ eventId: 'e1', startUTC: '2026-01-05T08:00', createdUTC: '2026-01-01T02:00:00' }),
      event({ eventId: 'e2', startUTC: '2026-01-06T08:00', createdUTC: '2026-01-02T02:00:00' }),
      event({ eventId: 'e3', startUTC: '2026-01-14T09:00', createdUTC: '2026-01-02T02:00:00' }),
      // created another time, same start as b4
      event({ eventId: 'e4', startUTC: '2026-02-02T08:00', createdUTC: '2026-01-11T09:00:00' }),
      // moved lesson, created one second apart from b5
      event({ eventId: 'e5', startUTC: '2026-03-05T08:00', createdUTC: '2026-01-20T10:00:01' }),
    ];
    const links = linkEvents(events, bookings);
    expect(links.get('e1')).toEqual({ bookingId: 'b1', how: 'created+start' });
    expect(links.get('e2')).toEqual({ bookingId: 'b2', how: 'created+start' });
    expect(links.get('e3')).toEqual({ bookingId: 'b3', how: 'created+order' });
    expect(links.get('e4')).toEqual({ bookingId: 'b4', how: 'start' });
    expect(links.get('e5')).toEqual({ bookingId: 'b5', how: 'created~' });
    expect(new Set([...links.values()].map((l) => l.bookingId)).size).toBe(5);
  });

  it('never links a booking twice and leaves package rows alone', () => {
    const bookings = [
      booking({ bookingId: 'b1' }),
      booking({ bookingId: 'p1', kind: 'P4', startUTC: '2026-01-01T00:00', createdUTC: '2026-01-01T02:00:00' }),
    ];
    const events = [event({ eventId: 'e1' }), event({ eventId: 'e2', createdUTC: '2026-01-01T02:00:01' })];
    const links = linkEvents(events, bookings);
    expect([...links.values()].map((l) => l.bookingId)).toEqual(['b1']);
  });
});

describe('planReplay', () => {
  it('turns invoices into lots and events into lessons: past marked, past unmarked, future', () => {
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100', amountSGD: 300 })],
        bookings: [
          booking({ bookingId: 'b1', startUTC: '2026-01-05T08:00' }),
          booking({ bookingId: 'b2', startUTC: '2026-01-12T08:00', createdUTC: '2026-01-02T02:00:00' }),
          booking({ bookingId: 'b3', startUTC: '2026-12-01T08:00', createdUTC: '2026-01-03T02:00:00' }),
        ],
        events: [
          event({ eventId: 'e1', startUTC: '2026-01-05T08:00', marked: true }),
          event({ eventId: 'e2', startUTC: '2026-01-12T08:00', marked: false, createdUTC: '2026-01-02T02:00:00' }),
          event({ eventId: 'e3', startUTC: '2026-12-01T08:00', marked: false, createdUTC: '2026-01-03T02:00:00' }),
        ],
      }),
    );
    expect(plan.lots).toHaveLength(1);
    expect(plan.lots[0]).toMatchObject({ sessions: 4, sizeSource: 'price rule', studentKey: 'doc:s10', invoiceNumber: 'N100' });
    // 30 days assumed, but never before the last lesson booked on the package
    expect(plan.lots[0]!.validUntil).toBe('2026-12-01T08:00:00.000Z');
    expect(plan.lots[0]!.validityAssumed).toBe(true);
    expect(plan.stats).toMatchObject({ lessons: 3, pastMarked: 1, pastUnmarked: 1, future: 1 });
  });

  it('keeps one lesson for the same student and start, marked if either was', () => {
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100' })],
        bookings: [booking({ bookingId: 'b1' })],
        events: [
          event({ eventId: 'e1', marked: false }),
          event({ eventId: 'e2', marked: true, createdUTC: '2026-01-01T02:00:05', classId: 'c1' }),
        ],
      }),
    );
    expect(plan.lessons).toHaveLength(1);
    expect(plan.lessons[0]!.marked).toBe(true);
    expect(plan.duplicates).toBe(1);
  });

  it('finds the student of an event with no booking by its class, lists the rest', () => {
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100' })],
        bookings: [booking({ bookingId: 'b1' })],
        events: [
          event({ eventId: 'e1' }),
          event({ eventId: 'e2', startUTC: '2026-01-12T08:00', createdUTC: '2026-01-02T00:00:00', classId: 'c1', online: false }),
          event({ eventId: 'e3', startUTC: '2026-01-19T08:00', createdUTC: '2026-01-03T00:00:00', classId: 'other', online: false }),
        ],
      }),
    );
    expect(plan.lessons.map((l) => [l.id, l.link])).toEqual([
      ['cc-e1', 'created+start'],
      ['cc-e2', 'class'],
    ]);
    expect(plan.unidentified).toEqual([{ eventId: 'e3', startUTC: '2026-01-19T08:00', marked: true, online: false }]);
  });

  it('uses each package row as its own lot, with its own validity, and sizes promos by date', () => {
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100', amountSGD: 750 }), invoice({ invoiceId: '200', date: '2026-09-20', amountSGD: 195 })],
        bookings: [
          booking({ bookingId: 'r1', kind: 'P4', startUTC: '2026-01-06T00:00', endUTC: '2026-02-05T00:00' }),
          booking({ bookingId: 'r2', kind: 'P4', startUTC: '2026-02-10T00:00', endUTC: '2026-03-12T00:00' }),
          booking({ bookingId: 'r3', kind: 'PROMO', invoiceId: '200', startUTC: '2026-09-21T00:00', endUTC: '2026-10-21T00:00' }),
        ],
      }),
    );
    expect(plan.lots.map((l) => [l.key, l.sessions, l.validUntil])).toEqual([
      ['100-1', 4, '2026-02-05T00:00:00.000Z'],
      ['100-2', 4, '2026-03-12T00:00:00.000Z'],
      ['200', 3, '2026-10-21T00:00:00.000Z'],
    ]);
  });

  it('falls back to the lessons booked on a package it cannot size, and says so', () => {
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100', amountSGD: 61 })],
        bookings: [booking({ bookingId: 'b1' }), booking({ bookingId: 'b2', startUTC: '2026-01-12T08:00', createdUTC: '2026-01-02T00:00:00' })],
        events: [
          event({ eventId: 'e1' }),
          event({ eventId: 'e2', startUTC: '2026-01-12T08:00', createdUTC: '2026-01-02T00:00:00' }),
        ],
      }),
    );
    expect(plan.lots[0]).toMatchObject({ sessions: 2, sizeSource: 'lessons booked' });
    expect(plan.unsized).toEqual([
      { invoiceId: '100', invoiceNumber: 'N100', lessonsBooked: 2, suggested: 4, reason: 'S$61: size unknown' },
    ]);
  });

  it('makes a lot for an invoice older than the data from the lessons booked on it', () => {
    const plan = planReplay(
      input({
        bookings: [booking({ bookingId: 'b1', invoiceId: '999' })],
        events: [event({ eventId: 'e1' })],
      }),
    );
    expect(plan.lots[0]).toMatchObject({ invoiceId: '999', sessions: 1, sizeSource: 'lessons booked (unlisted invoice)', invoiceNumber: null });
  });

  it('lists students it has no LessonKaki student for, and skips them', () => {
    const plan = planReplay(
      input({
        studentKeys: {},
        invoices: [invoice({ invoiceId: '100' })],
        bookings: [booking({ bookingId: 'b1' })],
        events: [event({ eventId: 'e1' })],
      }),
    );
    expect(plan.unmappedStudents).toEqual(['10']);
    expect(plan.lessons).toEqual([]);
    expect(plan.lots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Applied to the emulator
// ---------------------------------------------------------------------------------------------

const school = withInvariant();

async function replaySchool(): Promise<TestSchool> {
  const t = await school();
  await db.doc(`schools/${t.schoolId}/teachers/piano-teacher`).set({ displayName: 'Piano Teacher', active: true });
  await db.doc(`schools/${t.schoolId}/subjects/piano`).set({ name: 'Piano', defaultDurationMin: 45, active: true });
  await addStudent(t, 's10');
  return t;
}

const opts = {
  teacherIds: { owner: 'teacher1', piano: 'piano-teacher' },
  subjectIds: { voice: 'voice', piano: 'piano' },
  at: new Date(NOW),
  concurrency: 2,
};

/** One 4-pack: lessons on 5 and 12 Jan marked, 19 Jan unmarked, 7 Dec 2026 still to come. */
function fourLessons(): ReplayInput {
  const days = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-12-07'];
  return input({
    invoices: [invoice({ invoiceId: '100', amountSGD: 300 })],
    bookings: days.map((d, i) => booking({ bookingId: `b${i}`, startUTC: `${d}T08:00`, createdUTC: `2026-01-0${i + 1}T00:00:00` })),
    events: days.map((d, i) =>
      event({
        eventId: `e${i}`,
        startUTC: `${d}T08:00`,
        endUTC: `${d}T08:45`,
        marked: i < 2,
        createdUTC: `2026-01-0${i + 1}T00:00:00`,
      }),
    ),
  });
}

const lessonId = (t: TestSchool, id: string) => db.doc(`schools/${t.schoolId}/lessons/cc-${id}`);

describe('applyReplay', () => {
  it('creates the lot and lessons, debits marked ones; unmarked stay booked, future upcoming', async () => {
    const t = await replaySchool();
    const res = await applyReplay(db, t.schoolId, planReplay(fourLessons()), actor, opts);
    // the lot expired by NOW (30 days from 1 Jan): what was unused is not carried over
    expect(res).toMatchObject({ lotsCreated: 1, lessonsCreated: 4, lessonsMarked: 2, unknownStudents: [] });
    expect(res.expired).toEqual({ lots: 0, sessions: 0 }); // lot extended to its last booked lesson, still valid

    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 2, sessionsOwed: 0 });
    const lot = (await db.doc(`schools/${t.schoolId}/enrolments/cc-100`).get()).data()!;
    expect(lot).toMatchObject({ sessionsTotal: 4, sessionsUsed: 2, sessionsRemaining: 2, status: 'active', legacyInvoiceNumber: 'N100' });

    const status = async (id: string) => (await lessonId(t, id).collection('attendees').doc('s10').get()).get('status');
    expect(await status('e0')).toBe('present');
    expect(await status('e1')).toBe('present');
    expect(await status('e2')).toBe('booked');
    expect(await status('e3')).toBe('booked');
    expect((await lessonId(t, 'e0').get()).data()).toMatchObject({
      teacherId: 'teacher1',
      subjectId: 'voice',
      isOnline: true,
      durationMin: 45,
      attendanceState: 'marked',
    });
    const markedAt = (await lessonId(t, 'e0').collection('attendees').doc('s10').get()).get('markedAt');
    expect(markedAt.toDate().toISOString()).toBe('2026-01-05T08:45:00.000Z');

    // no owner email alerts came out of it
    expect((await db.collection(`schools/${t.schoolId}/alerts`).get()).size).toBe(0);
    expect(await reconcileSchool(t.schoolId)).toEqual([]);
  });

  it('is idempotent', async () => {
    const t = await replaySchool();
    const plan = planReplay(fourLessons());
    await applyReplay(db, t.schoolId, plan, actor, opts);
    const before = (await db.collection(`schools/${t.schoolId}/ledger`).get()).size;
    const again = await applyReplay(db, t.schoolId, plan, actor, opts);
    expect(again).toMatchObject({ lotsCreated: 0, lessonsCreated: 0, lessonsMarked: 0 });
    expect((await db.collection(`schools/${t.schoolId}/ledger`).get()).size).toBe(before);
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 2, sessionsOwed: 0 });
  });

  it('leaves a lesson the owner has since marked differently alone', async () => {
    const t = await replaySchool();
    const planned = planReplay({
      ...fourLessons(),
      events: fourLessons().events.map((e) => ({ ...e, marked: true })),
    });
    await applyReplay(db, t.schoolId, { ...planned, lessons: planned.lessons.filter((l) => l.id === 'cc-e2') }, actor, opts);
    await lessonId(t, 'e2').collection('attendees').doc('s10').update({ status: 'absent' });
    const again = await applyReplay(db, t.schoolId, { ...planned, lessons: planned.lessons.filter((l) => l.id === 'cc-e2') }, actor, opts);
    expect(again.lessonsMarked).toBe(0);
    expect((await lessonId(t, 'e2').collection('attendees').doc('s10').get()).get('status')).toBe('absent');
  });

  it('draws on the lot that existed at the time, and does not carry an expired package over', async () => {
    const t = await replaySchool();
    const plan = planReplay(
      input({
        invoices: [
          invoice({ invoiceId: '100', date: '2026-01-01', amountSGD: 300 }),
          invoice({ invoiceId: '200', date: '2026-06-01', amountSGD: 300 }),
        ],
        bookings: [booking({ bookingId: 'b1', startUTC: '2026-01-05T08:00', invoiceId: '100' })],
        events: [event({ eventId: 'e1', startUTC: '2026-01-05T08:00', endUTC: '2026-01-05T08:45' })],
      }),
    );
    const res = await applyReplay(db, t.schoolId, plan, actor, opts);
    expect(res.lotsCreated).toBe(2);
    expect(res.expired).toEqual({ lots: 2, sessions: 7 }); // 3 left on the first, 4 on the second
    const first = (await db.doc(`schools/${t.schoolId}/enrolments/cc-100`).get()).data()!;
    expect(first).toMatchObject({ sessionsUsed: 1, sessionsExpired: 3, sessionsRemaining: 0, status: 'expired' });
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
  });

  it('puts piano lessons on the piano teacher and subject', async () => {
    const t = await replaySchool();
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100', date: '2026-10-01' })],
        bookings: [booking({ bookingId: 'b1', startUTC: '2026-10-20T08:00', createdUTC: '2026-10-02T00:00:00' })],
        events: [event({ eventId: 'e1', tag: 'CP', startUTC: '2026-10-20T08:00', createdUTC: '2026-10-02T00:00:00', marked: false })],
      }),
    );
    await applyReplay(db, t.schoolId, plan, actor, opts);
    expect((await lessonId(t, 'e1').get()).data()).toMatchObject({
      teacherId: 'piano-teacher',
      subjectId: 'piano',
      status: 'scheduled',
      attendanceState: 'unmarked',
    });
  });

  it('reports students that are not in the school and replays nothing for them', async () => {
    const t = await replaySchool();
    const plan = planReplay(
      input({
        studentKeys: { '10': 'doc:nobody' },
        invoices: [invoice({ invoiceId: '100' })],
        bookings: [booking({ bookingId: 'b1' })],
        events: [event({ eventId: 'e1' })],
      }),
    );
    const res = await applyReplay(db, t.schoolId, plan, actor, opts);
    expect(res).toMatchObject({ lotsCreated: 0, lessonsCreated: 0, unknownStudents: ['doc:nobody'] });
  });

  it('finds students added after the export by their Classcard code', async () => {
    const t = await replaySchool();
    await db.doc(`schools/${t.schoolId}/students/late1`).set({
      firstName: 'Late',
      lastName: 'Joiner',
      status: 'active',
      legacyId: 'SYWH272',
      summary: { sessionsAvailable: 0, sessionsOwed: 0 },
    });
    const plan = planReplay(
      input({
        studentKeys: { '10': 'code:SYWH272' },
        invoices: [invoice({ invoiceId: '100', date: '2026-10-05' })],
        bookings: [booking({ bookingId: 'b1', startUTC: '2026-10-06T08:00', createdUTC: '2026-10-05T00:00:00' })],
        events: [
          event({ eventId: 'e1', startUTC: '2026-10-06T08:00', endUTC: '2026-10-06T08:45', createdUTC: '2026-10-05T00:00:00' }),
        ],
      }),
    );
    const res = await applyReplay(db, t.schoolId, plan, actor, opts);
    expect(res.unknownStudents).toEqual([]);
    expect(await summary(t, 'late1')).toEqual({ sessionsAvailable: 3, sessionsOwed: 0 });
    expect(planTotals(plan)).toEqual({ lots: 1, sessions: 4, students: 1 });
  });

  it('deducts lessons attended in Classcard that sit on no placed lesson, from the oldest lot, before expiry', async () => {
    const t = await replaySchool();
    const plan = planReplay({
      ...input({
        invoices: [
          invoice({ invoiceId: '100', date: '2026-01-01', amountSGD: 300 }),
          invoice({ invoiceId: '200', date: '2026-09-20', amountSGD: 300 }),
        ],
        bookings: [booking({ bookingId: 'b1', startUTC: '2026-01-05T08:00', invoiceId: '100' })],
        events: [event({ eventId: 'e1', startUTC: '2026-01-05T08:00', endUTC: '2026-01-05T08:45' })],
      }),
      attended: { '10': 3 }, // 1 placed, 2 on events with no student
    });
    expect(plan.unlinked).toEqual([{ studentKey: 'doc:s10', count: 2 }]);
    const res = await applyReplay(db, t.schoolId, plan, actor, opts);
    expect(res).toMatchObject({ unlinkedDeducted: 2, unlinkedShortfall: 0 });
    const first = (await db.doc(`schools/${t.schoolId}/enrolments/cc-100`).get()).data()!;
    // 4 sessions: 1 placed + 2 unplaced used (the adjust shrinks the lot), 1 left expires; the new one is whole
    expect(first).toMatchObject({ sessionsUsed: 1, sessionsTotal: 2, sessionsExpired: 1, sessionsRemaining: 0, status: 'expired' });
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 4, sessionsOwed: 0 });
  });

  it('keeps sessions for lessons still to be marked inside an expired package (and settles owed ones)', async () => {
    const t = await replaySchool();
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100', date: '2026-01-01', amountSGD: 300 })],
        bookings: [
          booking({ bookingId: 'b1', startUTC: '2026-01-05T08:00' }),
          booking({ bookingId: 'b2', startUTC: '2026-01-12T08:00', createdUTC: '2026-01-02T00:00:00' }),
          booking({ bookingId: 'b3', startUTC: '2026-01-19T08:00', createdUTC: '2026-01-03T00:00:00' }),
        ],
        events: [
          event({ eventId: 'e1', startUTC: '2026-01-05T08:00', endUTC: '2026-01-05T08:45', marked: true }),
          event({ eventId: 'e2', startUTC: '2026-01-12T08:00', endUTC: '2026-01-12T08:45', marked: false, createdUTC: '2026-01-02T00:00:00' }),
          event({ eventId: 'e3', startUTC: '2026-01-19T08:00', endUTC: '2026-01-19T08:45', marked: false, createdUTC: '2026-01-03T00:00:00' }),
        ],
      }),
    );
    const res = await applyReplay(db, t.schoolId, plan, actor, opts);
    // 4 sessions, 1 used, 3 would expire; 2 pending lessons are inside the validity: 2 given back
    expect(res.expired).toEqual({ lots: 1, sessions: 3 });
    expect(res.reopened).toEqual({ sessions: 2, settled: 0 });
    const lotDoc = (await db.doc(`schools/${t.schoolId}/enrolments/cc-100`).get()).data()!;
    expect(lotDoc).toMatchObject({ status: 'active', sessionsRemaining: 2, sessionsExpired: 1, sessionsUsed: 1 });
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 2, sessionsOwed: 0 });

    // marking them now draws on the reopened lot
    await setAttendance(db, { schoolId: t.schoolId, lessonId: 'cc-e2', studentId: 's10', status: 'present' }, owner);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: 'cc-e3', studentId: 's10', status: 'present' }, owner);
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
    // and the nightly expiry has nothing left to take
    expect(await reopenForPending(db, t.schoolId, actor, new Date(NOW))).toEqual({ sessions: 0, settled: 0 });
  });

  it('settles a lesson that was marked after the grace period let its package expire again', async () => {
    const t = await replaySchool();
    const plan = planReplay(
      input({
        invoices: [invoice({ invoiceId: '100', date: '2026-01-01', amountSGD: 300 })],
        bookings: [booking({ bookingId: 'b1', startUTC: '2026-01-05T08:00' })],
        events: [event({ eventId: 'e1', startUTC: '2026-01-05T08:00', endUTC: '2026-01-05T08:45', marked: false })],
      }),
    );
    await applyReplay(db, t.schoolId, plan, actor, opts);
    expect((await db.doc(`schools/${t.schoolId}/enrolments/cc-100`).get()).get('sessionsRemaining')).toBe(1);

    // the review didn't get to it before the grace period ended: the nightly expiry takes the session
    const later = new Date(Date.parse(NOW) + 200 * 86_400_000);
    expect(await expireLots(db, t.schoolId, later)).toEqual({ lots: 1, sessions: 1 });
    await setAttendance(db, { schoolId: t.schoolId, lessonId: 'cc-e1', studentId: 's10', status: 'present' }, owner, later);
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 0, sessionsOwed: 1 });

    expect(await reopenForPending(db, t.schoolId, actor, later)).toEqual({ sessions: 1, settled: 1 });
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 0, sessionsOwed: 0 });
  });

  it('leaves the real engine to take over: marking a replayed unmarked lesson debits as usual', async () => {
    const t = await replaySchool();
    await applyReplay(db, t.schoolId, planReplay(fourLessons()), actor, opts);
    await setAttendance(db, { schoolId: t.schoolId, lessonId: 'cc-e2', studentId: 's10', status: 'present' }, owner);
    expect(await summary(t, 's10')).toEqual({ sessionsAvailable: 1, sessionsOwed: 0 });
  });
});
