// Recurring lessons. A series is a weekly template in wall-clock terms (time + weekdays in the school's
// time zone). Lessons are materialised MATERIALISE_WEEKS ahead with deterministic ids
// `${seriesId}_${yyyymmdd}`, so extending twice never duplicates an occurrence.
//
// Edits with scope 'following' or 'all' only rewrite *placeholder* lessons: in the future, still
// scheduled, unmarked, and not individually edited (isException). Past lessons, marked lessons and
// one-off edits are never rewritten, so attendance and credits on them can't change by accident.
import { Timestamp, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  MATERIALISE_WEEKS,
  addDays,
  formatRrule,
  resolvePolicy,
  wallClockToUtc,
  wallDateOf,
  wallTimeOf,
  weeklyOccurrences,
  type Occurrence,
  type Weekday,
} from '@lessonkaki/shared';
import { enqueueAlert } from './alerts';
import { enqueueLessonCancelled, prepareCancelLesson } from './attendance';
import { CreditTx } from './creditTx';
import { audit, notFound, now, readAll, schoolRef, type Actor } from './db';
import { MAX_DURATION_MIN, checkRefs, findClash, teacherWindow, writeLesson, type LessonShape } from './lessons';

const MIN_MS = 60_000;
const HORIZON_DAYS = MATERIALISE_WEEKS * 7;

export interface SeriesTemplate extends LessonShape {
  /** Start time, 'HH:mm' in the school's time zone. */
  time: string;
  byDay: Weekday[];
}

export const lessonIdFor = (seriesId: string, date: string) => `${seriesId}_${date.replaceAll('-', '')}`;

const maxDate = (a: string, b: string) => (a > b ? a : b);

function templateOf(series: FirebaseFirestore.DocumentData): SeriesTemplate {
  return {
    teacherId: series.teacherId,
    subjectId: series.subjectId,
    locationId: series.locationId ?? null,
    isOnline: series.isOnline,
    meetingUrl: series.meetingUrl ?? null,
    durationMin: series.durationMin,
    time: series.time,
    byDay: series.byDay,
  };
}

function assertDuration(min: number): void {
  if (!Number.isInteger(min) || min < 5 || min > MAX_DURATION_MIN) {
    throw new HttpsError('invalid-argument', 'Duration must be between 5 minutes and 12 hours');
  }
}

interface Clash {
  date: string;
  lessonId: string;
}

/** Checks every occurrence against the teacher's other lessons. */
async function findClashes(
  tx: Transaction,
  school: DocumentReference,
  teacherId: string,
  occ: Occurrence[],
  durationMin: number,
  ignore: ReadonlySet<string>,
): Promise<Clash[]> {
  if (occ.length === 0) return [];
  const first = occ[0]!.startAt.getTime();
  const last = occ.at(-1)!.startAt.getTime() + durationMin * MIN_MS;
  const nearby = (await tx.get(teacherWindow(school, teacherId, first, last))).docs;
  const clashes: Clash[] = [];
  for (const o of occ) {
    const start = o.startAt.getTime();
    const hit = findClash(nearby, start, start + durationMin * MIN_MS, ignore);
    if (hit) clashes.push({ date: o.date, lessonId: hit.id });
  }
  return clashes;
}

function clashError(clashes: Clash[]): never {
  const dates = clashes.map((c) => c.date).join(', ');
  throw new HttpsError('already-exists', `The teacher already has a lesson on ${dates}`, { conflicts: clashes });
}

// ---------------------------------------------------------------------------------------------
// createSeries
// ---------------------------------------------------------------------------------------------

export interface CreateSeriesInput extends SeriesTemplate {
  schoolId: string;
  /** First date the series may fall on, 'YYYY-MM-DD'. */
  startDate: string;
  until?: string | null;
  studentIds: string[];
  /** Create the series anyway, leaving out clashing dates (they become exdates). */
  skipConflicts?: boolean;
}

export interface CreateSeriesResult {
  seriesId: string;
  lessonIds: string[];
  skipped: string[];
}

export async function createSeries(
  db: Firestore,
  input: CreateSeriesInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<CreateSeriesResult> {
  const school = schoolRef(db, input.schoolId);
  const studentIds = [...new Set(input.studentIds)];
  if (studentIds.length === 0) throw new HttpsError('invalid-argument', 'Add at least one student');
  if (input.byDay.length === 0) throw new HttpsError('invalid-argument', 'Pick at least one weekday');
  assertDuration(input.durationMin);
  const rrule = formatRrule({ byDay: input.byDay, until: input.until ?? null });

  return db.runTransaction(async (tx) => {
    const schoolSnap = await checkRefs(tx, school, { teacherId: input.teacherId, subjectId: input.subjectId, studentIds });
    const tz = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const horizon = addDays(maxDate(input.startDate, wallDateOf(at, tz)), HORIZON_DAYS);
    const rule = { byDay: input.byDay, until: input.until ?? null };
    let occ = weeklyOccurrences({ startDate: input.startDate, time: input.time, timeZone: tz, rule, from: input.startDate, to: horizon });
    if (occ.length === 0) throw new HttpsError('invalid-argument', 'That series has no lessons in the next 12 weeks');

    const clashes = await findClashes(tx, school, input.teacherId, occ, input.durationMin, new Set());
    if (clashes.length && !input.skipConflicts) clashError(clashes);
    const skipped = clashes.map((c) => c.date);
    occ = occ.filter((o) => !skipped.includes(o.date));

    const seriesRef = school.collection('series').doc();
    tx.create(seriesRef, {
      teacherId: input.teacherId,
      subjectId: input.subjectId,
      locationId: input.locationId ?? null,
      isOnline: input.isOnline,
      meetingUrl: input.meetingUrl ?? null,
      durationMin: input.durationMin,
      time: input.time,
      byDay: rule.byDay,
      timezone: tz,
      rrule,
      startDate: input.startDate,
      until: rule.until,
      exdates: skipped,
      studentIds,
      active: true,
      materialisedThrough: horizon,
      createdBy: actor.uid,
      createdAt: now(),
      updatedAt: now(),
    });
    const lessonIds = occ.map((o) => {
      const ref = school.collection('lessons').doc(lessonIdFor(seriesRef.id, o.date));
      writeLesson(tx, ref, input.schoolId, input, o.startAt.getTime(), studentIds, actor, {
        seriesId: seriesRef.id,
        occurrenceDate: o.date,
      });
      return ref.id;
    });
    enqueueAlert(
      tx,
      school,
      `series_${seriesRef.id}`,
      {
        type: 'series.booked',
        seriesId: seriesRef.id,
        studentIds,
        firstStartAt: occ[0]!.startAt,
        lessons: lessonIds.length,
        byDay: rule.byDay,
      },
      actor,
      at,
    );
    audit(tx, school, actor, 'createSeries', `series/${seriesRef.id}`, { rrule, lessons: lessonIds.length, skipped });
    return { seriesId: seriesRef.id, lessonIds, skipped };
  });
}

// ---------------------------------------------------------------------------------------------
// extendSeries: keep MATERIALISE_WEEKS of lessons ahead (scheduled daily)
// ---------------------------------------------------------------------------------------------

export interface ExtendResult {
  created: number;
  skipped: string[];
}

/** Materialises one series up to today + 12 weeks. Clashing dates are skipped and recorded. */
export async function extendOneSeries(
  db: Firestore,
  schoolId: string,
  seriesId: string,
  at: Date = new Date(),
): Promise<ExtendResult> {
  const school = schoolRef(db, schoolId);
  const actor: Actor = { uid: 'system:extendSeries', role: 'system' };
  return db.runTransaction(async (tx) => {
    const seriesSnap = await tx.get(school.collection('series').doc(seriesId));
    if (!seriesSnap.exists || seriesSnap.get('active') !== true) return { created: 0, skipped: [] };
    const s = seriesSnap.data()!;
    const tz = s.timezone as string;
    const to = addDays(wallDateOf(at, tz), HORIZON_DAYS);
    const from = s.materialisedThrough as string;
    if (from >= to) return { created: 0, skipped: [] };
    const tpl = templateOf(s);
    const occ = weeklyOccurrences({
      startDate: s.startDate,
      time: tpl.time,
      timeZone: tz,
      rule: { byDay: tpl.byDay, until: s.until },
      from,
      to,
      exdates: s.exdates,
    });
    const refs = occ.map((o) => school.collection('lessons').doc(lessonIdFor(seriesId, o.date)));
    const existing = refs.length ? await tx.getAll(...refs) : [];
    const fresh = occ.filter((_, i) => !existing[i]!.exists);
    const clashes = await findClashes(tx, school, tpl.teacherId, fresh, tpl.durationMin, new Set());
    const skipped = clashes.map((c) => c.date);
    let created = 0;
    for (const o of fresh) {
      if (skipped.includes(o.date)) continue;
      const ref = school.collection('lessons').doc(lessonIdFor(seriesId, o.date));
      writeLesson(tx, ref, schoolId, tpl, o.startAt.getTime(), s.studentIds, actor, { seriesId, occurrenceDate: o.date });
      created += 1;
    }
    tx.update(seriesSnap.ref, {
      materialisedThrough: to,
      exdates: [...(s.exdates as string[]), ...skipped],
      updatedAt: now(),
    });
    if (skipped.length) {
      audit(tx, school, actor, 'extendSeries.skipped', `series/${seriesId}`, { skipped, conflicts: clashes });
    }
    return { created, skipped };
  });
}

/** The daily job: every active series in every school. */
export async function extendAllSeries(db: Firestore, at: Date = new Date()): Promise<{ series: number; created: number }> {
  let series = 0;
  let created = 0;
  for (const schoolDoc of (await db.collection('schools').get()).docs) {
    const active = await schoolDoc.ref.collection('series').where('active', '==', true).get();
    for (const s of active.docs) {
      const res = await extendOneSeries(db, schoolDoc.id, s.id, at);
      series += 1;
      created += res.created;
    }
  }
  return { series, created };
}

// ---------------------------------------------------------------------------------------------
// editLesson: reschedule or cancel, scope one | following | all
// ---------------------------------------------------------------------------------------------

export const EDIT_SCOPES = ['one', 'following', 'all'] as const;
export type EditScope = (typeof EDIT_SCOPES)[number];

export interface LessonChanges {
  /** Scope 'one' only: move to this date. */
  date?: string;
  time?: string;
  durationMin?: number;
  teacherId?: string;
  isOnline?: boolean;
  locationId?: string | null;
  meetingUrl?: string | null;
  /** Series scopes only: new weekdays. */
  byDay?: Weekday[];
}

export interface EditLessonInput {
  schoolId: string;
  lessonId: string;
  scope: EditScope;
  changes?: LessonChanges;
  cancel?: { reason?: string | null };
  skipConflicts?: boolean;
}

export interface EditLessonResult {
  updated: number;
  created: number;
  deleted: number;
  cancelled: number;
  restored: number;
  skipped: string[];
  seriesId: string | null;
}

const emptyResult = (seriesId: string | null): EditLessonResult => ({
  updated: 0,
  created: 0,
  deleted: 0,
  cancelled: 0,
  restored: 0,
  skipped: [],
  seriesId,
});

export async function editLesson(
  db: Firestore,
  input: EditLessonInput,
  actor: Actor,
  at: Date = new Date(),
): Promise<EditLessonResult> {
  if (!input.cancel && !input.changes) throw new HttpsError('invalid-argument', 'Nothing to change');
  if (input.changes?.durationMin !== undefined) assertDuration(input.changes.durationMin);
  if (input.scope === 'one') return editOne(db, input, actor, at);
  if (input.changes?.date) {
    throw new HttpsError('invalid-argument', 'To move a series to other days, change its weekdays instead');
  }
  return editSeries(db, input, actor, at);
}

async function editOne(db: Firestore, input: EditLessonInput, actor: Actor, at: Date): Promise<EditLessonResult> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const lessonRef = school.collection('lessons').doc(input.lessonId);
    const [schoolSnap, lessonSnap] = await readAll(tx, school, lessonRef);
    if (!schoolSnap.exists) notFound('School');
    if (!lessonSnap.exists) notFound('Lesson');
    const lesson = lessonSnap.data()!;
    const seriesId = (lesson.seriesId as string | null) ?? null;
    if (lesson.status === 'cancelled') throw new HttpsError('failed-precondition', 'This lesson is cancelled');

    if (input.cancel) {
      const ct = new CreditTx(tx, school, actor, at);
      const reason = input.cancel.reason ?? null;
      const write = await prepareCancelLesson(ct, lessonRef, lesson, resolvePolicy(schoolSnap.get('policy')), reason);
      const restored = write();
      ct.flush();
      enqueueLessonCancelled(ct, input.lessonId, lesson, restored, reason);
      audit(tx, school, actor, 'editLesson.cancel', `lessons/${input.lessonId}`, { scope: 'one', restored });
      return { ...emptyResult(seriesId), cancelled: 1, restored };
    }

    const c = input.changes!;
    const tz = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';
    const oldStart = (lesson.startAt as Timestamp).toDate();
    const date = c.date ?? wallDateOf(oldStart, tz);
    const time = c.time ?? wallTimeOf(oldStart, tz);
    const durationMin = c.durationMin ?? (lesson.durationMin as number);
    const teacherId = c.teacherId ?? (lesson.teacherId as string);
    const start = wallClockToUtc(date, time, tz).getTime();
    const end = start + durationMin * MIN_MS;

    if (c.teacherId && c.teacherId !== lesson.teacherId) {
      const t = await tx.get(school.collection('teachers').doc(c.teacherId));
      if (!t.exists || t.get('active') === false) notFound('Teacher');
    }
    const nearby = (await tx.get(teacherWindow(school, teacherId, start, end))).docs;
    const clash = findClash(nearby, start, end, new Set([input.lessonId]));
    if (clash) {
      throw new HttpsError('already-exists', 'This teacher already has a lesson at that time', {
        conflicts: [{ date, lessonId: clash.id }],
      });
    }
    const attendees = (await tx.get(lessonRef.collection('attendees'))).docs;

    const startTs = Timestamp.fromMillis(start);
    tx.update(lessonRef, {
      startAt: startTs,
      endAt: Timestamp.fromMillis(end),
      durationMin,
      teacherId,
      ...(c.isOnline !== undefined ? { isOnline: c.isOnline } : {}),
      ...(c.locationId !== undefined ? { locationId: c.locationId } : {}),
      ...(c.meetingUrl !== undefined ? { meetingUrl: c.meetingUrl } : {}),
      ...(seriesId ? { isException: true } : {}),
      updatedAt: now(),
    });
    // Attendees carry the start for owed-lesson ordering; attendance itself is untouched.
    for (const a of attendees) tx.update(a.ref, { lessonStartAt: startTs, updatedAt: now() });
    audit(tx, school, actor, 'editLesson', `lessons/${input.lessonId}`, {
      scope: 'one',
      from: oldStart.toISOString(),
      to: startTs.toDate().toISOString(),
      teacherId,
    });
    return { ...emptyResult(seriesId), updated: 1 };
  });
}

async function editSeries(db: Firestore, input: EditLessonInput, actor: Actor, at: Date): Promise<EditLessonResult> {
  const school = schoolRef(db, input.schoolId);
  return db.runTransaction(async (tx) => {
    const lessonRef = school.collection('lessons').doc(input.lessonId);
    const [schoolSnap, pivotSnap] = await readAll(tx, school, lessonRef);
    if (!schoolSnap.exists) notFound('School');
    if (!pivotSnap.exists) notFound('Lesson');
    const seriesId = pivotSnap.get('seriesId') as string | null;
    if (!seriesId) throw new HttpsError('failed-precondition', 'This lesson is not part of a series');
    const seriesRef = school.collection('series').doc(seriesId);
    const seriesSnap = await tx.get(seriesRef);
    if (!seriesSnap.exists) notFound('Series');
    const series = seriesSnap.data()!;
    const tz = series.timezone as string;
    const today = wallDateOf(at, tz);
    const pivotDate =
      input.scope === 'following' ? (pivotSnap.get('occurrenceDate') as string) : (series.startDate as string);

    // Lessons of this series from the pivot on that haven't started yet.
    const all = (await tx.get(school.collection('lessons').where('seriesId', '==', seriesId))).docs;
    const future = all.filter(
      (d) =>
        (d.get('occurrenceDate') as string) >= pivotDate && (d.get('startAt') as Timestamp).toMillis() >= at.getTime(),
    );
    const isPlaceholder = (d: DocumentSnapshot) =>
      d.get('status') === 'scheduled' && d.get('attendanceState') === 'unmarked' && d.get('isException') !== true;
    const placeholders = future.filter(isPlaceholder);
    const kept = future.filter((d) => !isPlaceholder(d));
    const placeholderAttendees = await Promise.all(placeholders.map((d) => tx.get(d.ref.collection('attendees'))));
    const result = emptyResult(seriesId);

    /** Deletes placeholders, except those about to be rewritten under the same id (kept students too). */
    const deletePlaceholders = (rewrite: ReadonlySet<string> = new Set(), students: readonly string[] = []) => {
      placeholders.forEach((d, i) => {
        const same = rewrite.has(d.id);
        for (const a of placeholderAttendees[i]!.docs) if (!same || !students.includes(a.id)) tx.delete(a.ref);
        if (!same) tx.delete(d.ref);
      });
      result.deleted = placeholders.filter((d) => !rewrite.has(d.id)).length;
    };

    if (input.cancel) {
      // End the series: drop the placeholders, cancel (and refund) the kept future lessons.
      const ct = new CreditTx(tx, school, actor, at);
      const policy = resolvePolicy(schoolSnap.get('policy'));
      const reason = input.cancel.reason ?? null;
      const toCancel = kept.filter((d) => d.get('status') !== 'cancelled');
      const writes = [];
      for (const d of toCancel) writes.push(await prepareCancelLesson(ct, d.ref, d.data()!, policy, reason));
      deletePlaceholders();
      for (const w of writes) result.restored += w();
      result.cancelled = toCancel.length;
      ct.flush();
      const until = addDays(input.scope === 'following' ? pivotDate : maxDate(today, series.startDate), -1);
      tx.update(seriesRef, {
        until,
        rrule: formatRrule({ byDay: series.byDay, until }),
        active: until >= series.startDate,
        updatedAt: now(),
      });
      if (result.cancelled + result.deleted > 0) {
        enqueueAlert(
          tx,
          school,
          `seriescancel_${seriesId}_${pivotDate}_${at.getTime()}`,
          {
            type: 'series.cancelled',
            seriesId,
            studentIds: series.studentIds as string[],
            fromDate: maxDate(pivotDate, today),
            cancelled: result.cancelled,
            deleted: result.deleted,
            restored: result.restored,
            reason,
          },
          actor,
          at,
        );
      }
      audit(tx, school, actor, 'editLesson.cancel', `series/${seriesId}`, { scope: input.scope, pivotDate, ...result });
      return result;
    }

    // Reschedule: the new template applies from the pivot (following: a new series; all: this one).
    const c = input.changes!;
    const tpl: SeriesTemplate = {
      ...templateOf(series),
      ...Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== undefined && k !== 'date')),
    };
    if (tpl.byDay.length === 0) throw new HttpsError('invalid-argument', 'Pick at least one weekday');
    if (c.teacherId && c.teacherId !== series.teacherId) {
      const t = await tx.get(school.collection('teachers').doc(c.teacherId));
      if (!t.exists || t.get('active') === false) notFound('Teacher');
    }
    const split = input.scope === 'following' && pivotDate > series.startDate;
    const targetRef = split ? school.collection('series').doc() : seriesRef;
    const startDate = split ? pivotDate : (series.startDate as string);
    // Same horizon the daily extendSeries job keeps: today + 12 weeks (or further if already there).
    const horizon = maxDate(series.materialisedThrough as string, addDays(today, HORIZON_DAYS));
    const exdates = (series.exdates as string[]).filter((d) => d >= startDate);
    // A kept lesson (exception or marked) stands in for its date; don't create a second one.
    const keptDates = new Set(kept.map((d) => d.get('occurrenceDate') as string));
    const occ = weeklyOccurrences({
      startDate,
      time: tpl.time,
      timeZone: tz,
      rule: { byDay: tpl.byDay, until: series.until },
      from: maxDate(pivotDate, today),
      to: horizon,
      exdates,
    }).filter((o) => o.startAt.getTime() >= at.getTime() && !keptDates.has(o.date));

    const ignore = new Set(placeholders.map((d) => d.id));
    const clashes = await findClashes(tx, school, tpl.teacherId, occ, tpl.durationMin, ignore);
    if (clashes.length && !input.skipConflicts) clashError(clashes);
    result.skipped = clashes.map((x) => x.date);
    const create = occ.filter((o) => !result.skipped.includes(o.date));

    const createIds = new Set(create.map((o) => lessonIdFor(targetRef.id, o.date)));
    const rewritten = new Set(placeholders.map((d) => d.id).filter((id) => createIds.has(id)));
    deletePlaceholders(rewritten, series.studentIds);
    for (const o of create) {
      const ref = school.collection('lessons').doc(lessonIdFor(targetRef.id, o.date));
      const occurrence = { seriesId: targetRef.id, occurrenceDate: o.date };
      writeLesson(tx, ref, input.schoolId, tpl, o.startAt.getTime(), series.studentIds, actor, occurrence, rewritten.has(ref.id));
    }
    result.created = create.length;
    result.seriesId = targetRef.id;

    const templateFields = {
      teacherId: tpl.teacherId,
      subjectId: tpl.subjectId,
      locationId: tpl.locationId ?? null,
      isOnline: tpl.isOnline,
      meetingUrl: tpl.meetingUrl ?? null,
      durationMin: tpl.durationMin,
      time: tpl.time,
      byDay: tpl.byDay,
      rrule: formatRrule({ byDay: tpl.byDay, until: series.until }),
      exdates: [...exdates, ...result.skipped],
      materialisedThrough: horizon,
      updatedAt: now(),
    };
    if (split) {
      const until = addDays(pivotDate, -1);
      tx.update(seriesRef, { until, rrule: formatRrule({ byDay: series.byDay, until }), updatedAt: now() });
      tx.create(targetRef, {
        ...templateFields,
        timezone: tz,
        startDate,
        until: series.until ?? null,
        studentIds: series.studentIds,
        active: true,
        splitFrom: seriesId,
        createdBy: actor.uid,
        createdAt: now(),
      });
    } else {
      tx.update(seriesRef, templateFields);
    }
    audit(tx, school, actor, 'editLesson', `series/${targetRef.id}`, { scope: input.scope, pivotDate, changes: c, ...result });
    return result;
  });
}
