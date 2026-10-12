// Migration from Classcard: lessons replay. Instead of typing in balances, Classcard's history is
// replayed through the normal engine: one `migrate` lot per package, one lesson per real lesson, and the
// lessons Classcard marked get marked present via setAttendance, so lots are debited exactly as they
// would have been. What is left on each lot is the student's balance.
//
// planReplay is pure (Classcard rows in, a plan out); applyReplay writes it, idempotently: every doc id
// and idempotency key comes from a Classcard id, so a re-run only adds what is missing.
//
// Classcard's bookings keep the ORIGINAL time of a lesson; its calendar has the actual (rescheduled)
// time. The calendar is the truth for lessons, a booking says which student and invoice it was for.
import { Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { NO_EXPIRY } from '@lessonkaki/shared';
import { setAttendance } from './attendance';
import { CreditTx } from './creditTx';
import { audit, now, schoolRef, type Actor } from './db';
import { adjustCredits, expireLots } from './jobs';
import { writeLesson } from './lessons';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Input: Classcard rows as read (MCP, read-only) and saved to migration/raw (never in git)
// ---------------------------------------------------------------------------------------------

export interface CcBooking {
  bookingId: string;
  /** Classcard student (user_detail) id. */
  ccId: string;
  invoiceId: string;
  /** 'YYYY-MM-DDTHH:MM' UTC. For package rows, start/end are the package's validity. */
  startUTC: string;
  endUTC: string;
  /** L = lesson, P4 = 4-session package, PROMO = promo package. */
  kind: 'L' | 'P4' | 'PROMO';
  createdUTC: string;
}

export interface CcEvent {
  eventId: string;
  startUTC: string;
  endUTC: string;
  /** C = class, CB = Bernadette's, CP = piano (teacher Allie). */
  tag: 'C' | 'CB' | 'CP';
  marked: boolean;
  classId: string;
  online: boolean;
  createdUTC: string;
}

export interface CcInvoice {
  invoiceId: string;
  number: string;
  ccId: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amountSGD: number;
  paid: boolean;
}

export interface ReplayInput {
  bookings: CcBooking[];
  events: CcEvent[];
  invoices: CcInvoice[];
  /** Classcard student id -> student key (`doc:<id>` or `code:<legacyId>`). Unmapped students are listed. */
  studentKeys: Record<string, string>;
  /** Owner-confirmed sizes for packages Classcard's data can't size, by invoice id. */
  sizes?: Record<string, { sessions: number; validUntil?: string | null }>;
  /**
   * Lessons attended per Classcard student (its attendance report). Some marked lessons are on
   * events with no student (scheduled by hand); the difference to what was replayed is deducted.
   */
  attended?: Record<string, number>;
  /** ISO instant of the replay: lessons from here on are future, earlier ones are past. */
  now: string;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export type SizeSource = 'package rows' | 'price rule' | 'price rule (check)' | 'owner' | 'lessons booked' | 'lessons booked (unlisted invoice)';

export interface ReplayLot {
  /** Stable key: invoice id, plus `-n` for the n-th package row of the same invoice. */
  key: string;
  studentKey: string;
  invoiceId: string;
  invoiceNumber: string | null;
  packageName: string;
  sessions: number;
  /** ISO UTC. */
  validFrom: string;
  /** ISO UTC, or null for no expiry. */
  validUntil: string | null;
  sizeSource: SizeSource;
  /** True when validity is assumed (no package row said), not read. */
  validityAssumed: boolean;
}

export interface ReplayLesson {
  /** `cc-<eventId>`; the lesson doc id. */
  id: string;
  studentKey: string;
  startUTC: string;
  endUTC: string;
  teacher: 'owner' | 'piano';
  online: boolean;
  /** Classcard marked it: replayed as present. */
  marked: boolean;
  invoiceId: string | null;
  link: 'created+start' | 'created+order' | 'start' | 'created~' | 'class';
}

export interface ReplayPlan {
  lots: ReplayLot[];
  lessons: ReplayLesson[];
  /** Events with no student: date/time only, for the owner to identify. */
  unidentified: { eventId: string; startUTC: string; marked: boolean; online: boolean }[];
  /** Packages Classcard's data couldn't size: a fallback was used, for the owner to confirm. */
  unsized: { invoiceId: string; invoiceNumber: string | null; lessonsBooked: number; suggested: number; reason: string }[];
  /** Attended in Classcard but on no lesson we could place: deducted from the student's lots. */
  unlinked: { studentKey: string; count: number }[];
  /** Students the replay marked more lessons for than Classcard's attendance report says. */
  attendanceExceeds: number;
  /** Lessons dropped as duplicates of the same student and start. */
  duplicates: number;
  /** Classcard students in the rows with no LessonKaki student. */
  unmappedStudents: string[];
  stats: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Linking calendar events to bookings
// ---------------------------------------------------------------------------------------------

export interface Link {
  bookingId: string;
  how: 'created+start' | 'created+order' | 'start' | 'created~';
}

const iso = (utcMinute: string) => `${utcMinute}:00.000Z`;
const ms = (utcMinute: string) => Date.parse(iso(utcMinute));
const secs = (createdUTC: string) => Date.parse(`${createdUTC}Z`) / 1000;
const dayOf = (utcMinute: string) => new Date(ms(utcMinute) + 8 * 3_600_000).toISOString().slice(0, 10);
const addDays = (isoUtc: string, days: number) => new Date(Date.parse(isoUtc) + days * DAY_MS).toISOString();

/**
 * An event and its booking were created in the same second, with the original lesson time kept on the
 * booking. Layers, each on what the one before left: same created second (start-time match first, then
 * order); same start time; created within two minutes. Every booking links at most once.
 */
export function linkEvents(events: CcEvent[], bookings: CcBooking[]): Map<string, Link> {
  const lessons = bookings.filter((b) => b.kind === 'L');
  const links = new Map<string, Link>();
  const used = new Set<string>();
  const take = (e: CcEvent, b: CcBooking, how: Link['how']) => {
    links.set(e.eventId, { bookingId: b.bookingId, how });
    used.add(b.bookingId);
  };

  const byCreated = new Map<string, CcBooking[]>();
  for (const b of lessons) byCreated.set(b.createdUTC, [...(byCreated.get(b.createdUTC) ?? []), b]);
  const eventsByCreated = new Map<string, CcEvent[]>();
  for (const e of events) eventsByCreated.set(e.createdUTC, [...(eventsByCreated.get(e.createdUTC) ?? []), e]);
  for (const [created, es] of eventsByCreated) {
    const bs = [...(byCreated.get(created) ?? [])];
    if (!bs.length) continue;
    const left: CcEvent[] = [];
    for (const e of es) {
      const i = bs.findIndex((b) => b.startUTC === e.startUTC);
      if (i >= 0) take(e, bs.splice(i, 1)[0]!, 'created+start');
      else left.push(e);
    }
    left.sort((a, b) => a.startUTC.localeCompare(b.startUTC));
    bs.sort((a, b) => a.startUTC.localeCompare(b.startUTC));
    left.forEach((e, i) => bs[i] && take(e, bs[i]!, 'created+order'));
  }

  const byStart = new Map<string, CcBooking[]>();
  for (const b of lessons) if (!used.has(b.bookingId)) byStart.set(b.startUTC, [...(byStart.get(b.startUTC) ?? []), b]);
  for (const e of events) {
    if (links.has(e.eventId)) continue;
    const c = (byStart.get(e.startUTC) ?? []).filter((b) => !used.has(b.bookingId));
    if (!c.length) continue;
    c.sort((a, b) => Math.abs(secs(a.createdUTC) - secs(e.createdUTC)) - Math.abs(secs(b.createdUTC) - secs(e.createdUTC)));
    take(e, c[0]!, 'start');
  }

  const rest = lessons.filter((b) => !used.has(b.bookingId));
  for (const e of events.filter((x) => !links.has(x.eventId)).sort((a, b) => a.createdUTC.localeCompare(b.createdUTC))) {
    let best: { d: number; b: CcBooking } | null = null;
    for (const b of rest) {
      if (used.has(b.bookingId)) continue;
      const d = Math.abs(secs(b.createdUTC) - secs(e.createdUTC));
      if (d <= 120 && (!best || d < best.d)) best = { d, b };
    }
    if (best) take(e, best.b, 'created~');
  }
  return links;
}

// ---------------------------------------------------------------------------------------------
// Package sizes
// ---------------------------------------------------------------------------------------------

/** Grand-opening promo (S$195): bought by ~7 Sep 2026 = 4 sessions, after that = 3. */
export const promoSessions = (date: string) => (date <= '2026-09-10' ? 4 : 3);

/** Sessions for a price (Classcard has no sessions-left field). Null = unknown, ask the owner. */
export function sessionsForPrice(amountSGD: number, date: string): { sessions: number; check: boolean } | null {
  if ([750, 700, 675, 650, 600, 525].includes(amountSGD)) return { sessions: 12, check: false };
  if ([300, 270, 240, 210].includes(amountSGD)) return { sessions: 4, check: false };
  if (amountSGD === 100) return { sessions: 1, check: false };
  if ([195, 390, 585].includes(amountSGD) && date >= '2026-08-15') return { sessions: (amountSGD / 195) * promoSessions(date), check: false };
  if ([150, 200].includes(amountSGD)) return { sessions: 4, check: true }; // Dec-2025 promo price
  return null;
}

/** Validity assumed when Classcard data doesn't say (package rows exist for 1-month 4-packs only). */
export const DEFAULT_VALIDITY_DAYS: Record<number, number> = { 1: 30, 4: 30, 12: 90 };

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

export function planReplay(input: ReplayInput): ReplayPlan {
  const bookingById = new Map(input.bookings.map((b) => [b.bookingId, b]));
  const invoiceById = new Map(input.invoices.map((i) => [i.invoiceId, i]));
  const links = linkEvents(input.events, input.bookings);
  const nowMs = Date.parse(input.now);

  // classId -> student, from linked events (a class is one student's lessons)
  const classStudents = new Map<string, Set<string>>();
  for (const e of input.events) {
    const l = links.get(e.eventId);
    if (l) classStudents.set(e.classId, (classStudents.get(e.classId) ?? new Set()).add(bookingById.get(l.bookingId)!.ccId));
  }

  const unmapped = new Set<string>();
  const keyOf = (cc: string): string | null => {
    const k = input.studentKeys[cc] ?? null;
    if (!k) unmapped.add(cc);
    return k;
  };

  // ---- lessons ----
  const unidentified: ReplayPlan['unidentified'] = [];
  const byKey = new Map<string, ReplayLesson>();
  let duplicates = 0;
  for (const e of input.events) {
    const l = links.get(e.eventId);
    const booking = l ? bookingById.get(l.bookingId)! : null;
    let cc = booking?.ccId ?? null;
    let how: ReplayLesson['link'] | null = l?.how ?? null;
    if (!cc) {
      const s = classStudents.get(e.classId);
      if (s && s.size === 1) {
        cc = [...s][0]!;
        how = 'class';
      }
    }
    if (!cc) {
      unidentified.push({ eventId: e.eventId, startUTC: e.startUTC, marked: e.marked, online: e.online });
      continue;
    }
    const studentKey = keyOf(cc);
    if (!studentKey) continue;
    const lesson: ReplayLesson = {
      id: `cc-${e.eventId}`,
      studentKey,
      startUTC: e.startUTC,
      endUTC: e.endUTC,
      teacher: e.tag === 'CP' ? 'piano' : 'owner',
      online: e.online,
      marked: e.marked,
      invoiceId: booking?.invoiceId ?? null,
      link: how ?? 'class',
    };
    const dupKey = `${studentKey}|${e.startUTC}`;
    const prev = byKey.get(dupKey);
    if (prev) {
      duplicates += 1;
      prev.marked = prev.marked || lesson.marked;
      prev.invoiceId = prev.invoiceId ?? lesson.invoiceId;
      continue;
    }
    byKey.set(dupKey, lesson);
  }
  const lessons = [...byKey.values()].sort((a, b) => a.startUTC.localeCompare(b.startUTC) || a.id.localeCompare(b.id));

  // ---- lots ----
  const lessonsByInvoice = new Map<string, ReplayLesson[]>();
  for (const l of lessons) if (l.invoiceId) lessonsByInvoice.set(l.invoiceId, [...(lessonsByInvoice.get(l.invoiceId) ?? []), l]);
  const rowsByInvoice = new Map<string, CcBooking[]>();
  for (const b of input.bookings) if (b.kind !== 'L') rowsByInvoice.set(b.invoiceId, [...(rowsByInvoice.get(b.invoiceId) ?? []), b]);

  const lots: ReplayLot[] = [];
  const unsized: ReplayPlan['unsized'] = [];
  const invoiceIds = new Set<string>([...invoiceById.keys(), ...rowsByInvoice.keys(), ...lessonsByInvoice.keys()]);

  for (const invoiceId of invoiceIds) {
    const inv = invoiceById.get(invoiceId) ?? null;
    const rows = (rowsByInvoice.get(invoiceId) ?? []).sort((a, b) => a.startUTC.localeCompare(b.startUTC));
    const booked = lessonsByInvoice.get(invoiceId) ?? [];
    // The student: the invoice's, else whoever its lessons or package rows are for.
    const studentKey = inv ? keyOf(inv.ccId) : (booked[0]?.studentKey ?? (rows[0] ? keyOf(rows[0].ccId) : null));
    if (!studentKey) continue;
    const date = inv?.date ?? (rows[0] ? dayOf(rows[0].createdUTC.slice(0, 16)) : booked[0] ? dayOf(booked[0].startUTC) : input.now.slice(0, 10));
    const push = (lot: Omit<ReplayLot, 'studentKey' | 'invoiceId' | 'invoiceNumber'>) =>
      lots.push({ ...lot, studentKey, invoiceId, invoiceNumber: inv?.number ?? null });

    if (rows.length) {
      // Package rows: each is its own window of validity (a 12-session invoice can be three 4-packs).
      rows.forEach((r, i) => {
        const sessions = r.kind === 'PROMO' ? promoSessions(date) : 4;
        push({
          key: rows.length > 1 ? `${invoiceId}-${i + 1}` : invoiceId,
          packageName: r.kind === 'PROMO' ? `Promo, ${sessions} sessions` : '1 Month Package, 4 sessions',
          sessions,
          validFrom: iso(r.startUTC),
          validUntil: iso(r.endUTC),
          sizeSource: 'package rows',
          validityAssumed: false,
        });
      });
      continue;
    }

    const owner = input.sizes?.[invoiceId];
    const priced = inv ? sessionsForPrice(inv.amountSGD, inv.date) : null;
    let sessions: number;
    let sizeSource: SizeSource;
    let validUntil: string | null;
    let assumed = false;
    if (owner) {
      sessions = owner.sessions;
      sizeSource = 'owner';
      validUntil = owner.validUntil ? `${owner.validUntil}T15:59:59.999Z` : null;
    } else if (priced) {
      sessions = priced.sessions;
      sizeSource = priced.check ? 'price rule (check)' : 'price rule';
      const days = DEFAULT_VALIDITY_DAYS[sessions];
      validUntil = days ? addDays(`${date}T00:00:00.000Z`, days) : null;
      assumed = true;
    } else {
      // Unknown: as many sessions as lessons booked on it, so nothing is phantom and nothing owed.
      sessions = booked.length;
      sizeSource = inv ? 'lessons booked' : 'lessons booked (unlisted invoice)';
      validUntil = null;
      const suggested = [1, 4, 12].find((n) => n >= booked.length) ?? booked.length;
      unsized.push({
        invoiceId,
        invoiceNumber: inv?.number ?? null,
        lessonsBooked: booked.length,
        suggested,
        reason: inv ? `S$${inv.amountSGD}: size unknown` : 'invoice older than the data pulled',
      });
      if (sessions === 0) continue;
    }
    // Classcard let these lessons happen: never expire a package before its last booked lesson.
    const last = booked.reduce((m, l) => (l.startUTC > m ? l.startUTC : m), '');
    if (validUntil && last && ms(last) > Date.parse(validUntil)) validUntil = iso(last);
    const first = booked[0]?.startUTC;
    const bought = inv ? `${date}T00:00:00.000Z` : null;
    const validFrom = !bought || (first && ms(first) < Date.parse(bought)) ? iso(first ?? `${date}T00:00`) : bought;
    push({
      key: invoiceId,
      packageName: sessions === 1 ? 'Single lesson' : `${sessions} sessions`,
      sessions,
      validFrom,
      validUntil,
      sizeSource,
      validityAssumed: assumed,
    });
  }
  lots.sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.key.localeCompare(b.key));

  // Attendance Classcard has but the replay couldn't place on a lesson, per student.
  const attendedByKey = new Map<string, number>();
  for (const [cc, n] of Object.entries(input.attended ?? {})) {
    const k = input.studentKeys[cc];
    if (k) attendedByKey.set(k, (attendedByKey.get(k) ?? 0) + n);
  }
  const markedByKey = new Map<string, number>();
  for (const l of lessons) if (l.marked && ms(l.startUTC) < nowMs) markedByKey.set(l.studentKey, (markedByKey.get(l.studentKey) ?? 0) + 1);
  const unlinked: ReplayPlan['unlinked'] = [];
  let attendanceExceeds = 0;
  for (const [studentKey, n] of attendedByKey) {
    const diff = n - (markedByKey.get(studentKey) ?? 0);
    if (diff > 0) unlinked.push({ studentKey, count: diff });
    else if (diff < 0) attendanceExceeds += 1;
  }

  const past = (l: ReplayLesson) => ms(l.startUTC) < nowMs;
  const stats: Record<string, number> = {
    lots: lots.length,
    lotSessions: lots.reduce((n, l) => n + l.sessions, 0),
    lessons: lessons.length,
    pastMarked: lessons.filter((l) => past(l) && l.marked).length,
    pastUnmarked: lessons.filter((l) => past(l) && !l.marked).length,
    future: lessons.filter((l) => !past(l)).length,
    studentsWithLessons: new Set(lessons.map((l) => l.studentKey)).size,
    studentsWithLots: new Set(lots.map((l) => l.studentKey)).size,
    piano: lessons.filter((l) => l.teacher === 'piano').length,
    viaClassOnly: lessons.filter((l) => l.link === 'class').length,
    unlinkedAttended: unlinked.reduce((n, u) => n + u.count, 0),
  };
  return { lots, lessons, unidentified, unsized, unlinked, attendanceExceeds, duplicates, unmappedStudents: [...unmapped], stats };
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export interface ReplayOptions {
  teacherIds: { owner: string; piano: string };
  subjectIds: { voice: string; piano: string };
  /**
   * Students replayed in parallel (a student's own history is always in order). Default 1: concurrent
   * transactions that query a collection lock each other out ("transaction lock timeout").
   */
  concurrency?: number;
  /** "Now" for expiry and for what counts as past. Default: the current time. */
  at?: Date;
  onProgress?: (done: number, total: number) => void;
}

export interface ReplayResult {
  lotsCreated: number;
  lessonsCreated: number;
  lessonsMarked: number;
  /** Attended lessons with no date, deducted from lots; and what had no credit left to take from. */
  unlinkedDeducted: number;
  unlinkedShortfall: number;
  unknownStudents: string[];
  expired: { lots: number; sessions: number };
  /** Sessions given back to expired lots for lessons still to be marked, and owed lessons settled. */
  reopened: { sessions: number; settled: number };
}

type Item = { at: number; order: 0 | 1; lot?: ReplayLot; lesson?: ReplayLesson };

export async function applyReplay(
  db: Firestore,
  schoolId: string,
  plan: ReplayPlan,
  actor: Actor,
  opts: ReplayOptions,
): Promise<ReplayResult> {
  const school = schoolRef(db, schoolId);
  const at = opts.at ?? new Date();
  if (!(await school.get()).exists) throw new Error(`School ${schoolId} not found`);
  for (const [kind, ref] of [
    ['teacher', school.collection('teachers').doc(opts.teacherIds.owner)],
    ['teacher', school.collection('teachers').doc(opts.teacherIds.piano)],
    ['subject', school.collection('subjects').doc(opts.subjectIds.voice)],
    ['subject', school.collection('subjects').doc(opts.subjectIds.piano)],
  ] as const) {
    if (!(await ref.get()).exists) throw new Error(`Replay needs ${kind} "${ref.id}" in school ${schoolId}`);
  }

  // student keys -> student doc ids
  const keys = new Set([...plan.lots.map((l) => l.studentKey), ...plan.lessons.map((l) => l.studentKey)]);
  const docIdOf = new Map<string, string>();
  const unknown: string[] = [];
  const byCode = new Map<string, string[]>();
  if ([...keys].some((k) => k.startsWith('code:'))) {
    for (const d of (await school.collection('students').get()).docs) {
      const code = d.get('legacyId') as string | null;
      if (code) byCode.set(code, [...(byCode.get(code) ?? []), d.id]);
    }
  }
  for (const k of keys) {
    if (k.startsWith('doc:')) {
      const id = k.slice(4);
      if ((await school.collection('students').doc(id).get()).exists) docIdOf.set(k, id);
      else unknown.push(k);
    } else {
      const ids = byCode.get(k.slice(5)) ?? [];
      if (ids.length === 1) docIdOf.set(k, ids[0]!);
      else unknown.push(k);
    }
  }

  const items = new Map<string, Item[]>();
  const push = (studentKey: string, item: Item) => items.set(studentKey, [...(items.get(studentKey) ?? []), item]);
  for (const lot of plan.lots) if (docIdOf.has(lot.studentKey)) push(lot.studentKey, { at: Date.parse(lot.validFrom), order: 0, lot });
  for (const lesson of plan.lessons) {
    if (docIdOf.has(lesson.studentKey)) push(lesson.studentKey, { at: ms(lesson.startUTC), order: 1, lesson });
  }

  const result: ReplayResult = { lotsCreated: 0, lessonsCreated: 0, lessonsMarked: 0, unlinkedDeducted: 0, unlinkedShortfall: 0, unknownStudents: unknown, expired: { lots: 0, sessions: 0 }, reopened: { sessions: 0, settled: 0 } };
  const shape = (l: ReplayLesson) => ({
    teacherId: l.teacher === 'piano' ? opts.teacherIds.piano : opts.teacherIds.owner,
    subjectId: l.teacher === 'piano' ? opts.subjectIds.piano : opts.subjectIds.voice,
    locationId: l.online ? 'online' : 'studio',
    isOnline: l.online,
    durationMin: Math.max(5, Math.round((ms(l.endUTC) - ms(l.startUTC)) / MIN_MS)),
  });

  const createLot = async (lot: ReplayLot, studentId: string) => {
    const created = await db.runTransaction(async (tx) => {
      const idem = school.collection('idempotency').doc(`replayLot_${lot.key}`);
      if ((await tx.get(idem)).exists) return false;
      const ct = new CreditTx(tx, school, actor, at);
      ct.newLot(
        school.collection('enrolments').doc(`cc-${lot.key}`),
        {
          studentId,
          packageId: null,
          packageName: lot.packageName,
          invoiceId: null,
          legacyId: `replay:${lot.key}`,
          legacyInvoiceNumber: lot.invoiceNumber,
          validFrom: Timestamp.fromDate(new Date(lot.validFrom)),
          validUntil: Timestamp.fromDate(lot.validUntil ? new Date(lot.validUntil) : NO_EXPIRY),
        },
        lot.sessions,
        { type: 'migrate', reason: `Replayed from Classcard (invoice ${lot.invoiceNumber ?? lot.invoiceId})`, idempotencyKey: `replayLot:${lot.key}` },
      );
      ct.flush();
      tx.create(idem, { lotKey: lot.key, studentId, createdAt: now() });
      return true;
    });
    if (created) result.lotsCreated += 1;
  };

  const createLesson = async (l: ReplayLesson, studentId: string) => {
    const created = await db.runTransaction(async (tx) => {
      const ref = school.collection('lessons').doc(l.id);
      if ((await tx.get(ref)).exists) return false;
      writeLesson(tx, ref, schoolId, shape(l), ms(l.startUTC), [studentId], actor);
      return true;
    });
    if (created) result.lessonsCreated += 1;
  };

  const mark = async (l: ReplayLesson, studentId: string) => {
    const att = await school.collection('lessons').doc(l.id).collection('attendees').doc(studentId).get();
    if (att.get('status') !== 'booked') return; // already marked (or changed by hand): leave it
    // Marked at the lesson's own end, so the history reads as it happened.
    await setAttendance(db, { schoolId, lessonId: l.id, studentId, status: 'present' }, actor, new Date(iso(l.endUTC)));
    result.lessonsMarked += 1;
  };

  const unlinkedByKey = new Map(plan.unlinked.map((u) => [u.studentKey, u.count]));
  // students with only an unplaced attendance still get their deduction
  for (const u of plan.unlinked) if (docIdOf.has(u.studentKey) && !items.has(u.studentKey)) items.set(u.studentKey, []);
  const students = [...items.entries()];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < students.length) {
      const [studentKey, list] = students[next++]!;
      const studentId = docIdOf.get(studentKey)!;
      // In time order, a lot at its own start: a lesson only ever draws on a lot that existed then.
      list.sort((a, b) => a.at - b.at || a.order - b.order);
      for (const item of list) {
        if (item.lot) await createLot(item.lot, studentId);
        else {
          await createLesson(item.lesson!, studentId);
          if (item.lesson!.marked && ms(item.lesson!.startUTC) < at.getTime()) await mark(item.lesson!, studentId);
        }
      }
      // Attended in Classcard on a lesson with no student: first-in first-out, off the oldest lot,
      // before expiry runs (those lessons happened while the old lots were still valid).
      const unlinked = unlinkedByKey.get(studentKey) ?? 0;
      const doneRef = school.collection('idempotency').doc(`replayUnlinked_${studentKey.replace(/[^A-Za-z0-9_-]/g, '_')}`);
      if (unlinked > 0 && !(await doneRef.get()).exists) {
        const available = ((await school.collection('students').doc(studentId).get()).get('summary.sessionsAvailable') as number | undefined) ?? 0;
        const take = Math.min(unlinked, available);
        if (take > 0) {
          await adjustCredits(
            db,
            {
              schoolId,
              studentId,
              delta: -take,
              reason: 'Attended in Classcard on a lesson whose date was not recorded (migration)',
              idempotencyKey: `replayUnlinked:${studentKey}`,
            },
            actor,
            at,
          );
          result.unlinkedDeducted += take;
        }
        result.unlinkedShortfall += unlinked - take;
        await doneRef.set({ studentId, unlinked, deducted: take, createdAt: now() });
      }
      opts.onProgress?.(++done, students.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker));

  // "Expired packages are not carried over": what is left on a lot past its date goes with it.
  result.expired = await expireLots(db, schoolId, at);
  // ...except the sessions that lessons still booked (not yet marked) inside a lot's validity need.
  result.reopened = await reopenForPending(db, schoolId, actor, at);

  await db.runTransaction(async (tx) => {
    audit(tx, school, actor, 'applyReplay', 'migration', {
      lotsCreated: result.lotsCreated,
      lessonsCreated: result.lessonsCreated,
      lessonsMarked: result.lessonsMarked,
      unknownStudents: unknown,
      expired: result.expired,
    });
  });
  return result;
}

/** Plan totals (lots, sessions, students) for checking a run against the plan. */
export function planTotals(plan: ReplayPlan) {
  return {
    lots: plan.lots.length,
    sessions: plan.lots.reduce((n, l) => n + l.sessions, 0),
    students: new Set(plan.lots.map((l) => l.studentKey)).size,
  };
}

// ---------------------------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------------------------

/**
 * A lot's leftover sessions expire with its date, but a lesson booked inside that validity and not yet
 * marked (the owner marks the past ones in review) still belongs to it. For each student, the oldest
 * expired lots whose validity covers a still-booked past lesson (or a lesson marked present but owed)
 * get that many sessions back, oldest lesson first: `adjust` entries, owed lessons settled onto them.
 * A reopened lot lives `graceDays` more, so the nightly expiry doesn't take them again mid-review.
 */
export async function reopenForPending(
  db: Firestore,
  schoolId: string,
  actor: Actor,
  at: Date = new Date(),
  opts: { graceDays?: number; dryRun?: boolean } = {},
): Promise<{ sessions: number; settled: number }> {
  const school = schoolRef(db, schoolId);
  const graceUntil = Timestamp.fromMillis(at.getTime() + (opts.graceDays ?? 180) * DAY_MS);
  const expired = await school.collection('enrolments').where('status', '==', 'expired').get();
  const lotsByStudent = new Map<string, DocumentSnapshot[]>();
  for (const d of expired.docs) {
    if (((d.get('sessionsExpired') as number | undefined) ?? 0) > 0) {
      const id = d.get('studentId') as string;
      lotsByStudent.set(id, [...(lotsByStudent.get(id) ?? []), d]);
    }
  }
  const total = { sessions: 0, settled: 0 };

  for (const [studentId, lots] of lotsByStudent) {
    const lessons = await school
      .collection('lessons')
      .where('studentIds', 'array-contains', studentId)
      .where('startAt', '<', Timestamp.fromDate(at))
      .get();
    const demand: { start: number; lessonId: string; owed: boolean }[] = [];
    for (const l of lessons.docs) {
      if (l.get('status') === 'cancelled') continue;
      const a = await l.ref.collection('attendees').doc(studentId).get();
      const start = (l.get('startAt') as Timestamp).toMillis();
      if (a.get('status') === 'booked') demand.push({ start, lessonId: l.id, owed: false });
      else if (a.get('status') === 'present' && a.get('owed') === true) demand.push({ start, lessonId: l.id, owed: true });
    }
    if (!demand.length) continue;
    demand.sort((a, b) => a.start - b.start);

    const supply = lots
      .map((d) => ({
        d,
        left: d.get('sessionsExpired') as number,
        from: (d.get('validFrom') as Timestamp).toMillis(),
        until: (d.get('validUntil') as Timestamp).toMillis(),
        take: 0,
        owedLessons: [] as string[],
      }))
      .sort((a, b) => a.until - b.until);
    for (const dm of demand) {
      const s = supply.find((x) => x.left > 0 && x.from <= dm.start && dm.start <= x.until);
      if (!s) continue;
      s.left -= 1;
      s.take += 1;
      if (dm.owed) s.owedLessons.push(dm.lessonId);
    }

    for (const s of supply.filter((x) => x.take > 0)) {
      total.sessions += s.take;
      total.settled += s.owedLessons.length;
      if (opts.dryRun) continue;
      await db.runTransaction(async (tx) => {
        const lotSnap = await tx.get(s.d.ref);
        if (lotSnap.get('status') !== 'expired' || ((lotSnap.get('sessionsExpired') as number) ?? 0) < s.take) return;
        const owedSnaps = await Promise.all(s.owedLessons.map((id) => tx.get(school.collection('lessons').doc(id).collection('attendees').doc(studentId))));
        const ct = new CreditTx(tx, school, actor, at);
        const lot = ct.useLot(lotSnap);
        lot.expired -= s.take;
        lot.remaining += s.take;
        lot.status = 'active';
        ct.ledger({
          studentId,
          enrolmentId: lot.id,
          type: 'adjust',
          delta: s.take,
          idempotencyKey: `reopen:${lot.id}:${at.getTime()}`,
          reason: 'Lessons booked in this package are still to be marked (migration review)',
        });
        ct.bump(studentId, { sessionsAvailable: s.take });
        if (owedSnaps.length) ct.settleOwed(lot, owedSnaps, `reopen:${lot.id}:${at.getTime()}`);
        ct.flush();
        tx.update(lot.ref, { validUntil: graceUntil });
      });
    }
  }
  return total;
}
