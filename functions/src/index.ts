// Callable entry points. Each one: zod-validate the input, check the caller's role from claims,
// then hand over to the engine, which does all writes in a Firestore transaction.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { z } from 'zod';
import { ROLES, WEEKDAYS, isWallDate, isWallTime } from '@lessonkaki/shared';
import { requireRole } from './auth';
import * as attendance from './attendance';
import * as credits from './credits';
import * as lessons from './lessons';
import * as invoicePdf from './invoicePdf';
import * as members from './members';
import * as money from './money';
import * as series from './series';

initializeApp();
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 });

const db = () => getFirestore();
const bucket = () => getStorage().bucket() as unknown as invoicePdf.PdfBucket;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const wallDate = z.string().refine(isWallDate, 'Expected a date like 2026-10-14');
const wallTime = z.string().refine(isWallTime, 'Expected a time like 19:00');
const weekdays = z.array(z.enum(WEEKDAYS)).min(1).max(7);
const duration = z.number().int().min(5).max(lessons.MAX_DURATION_MIN);

/** Scheduled jobs run in the studio's zone. */
const JOB = { timeZone: 'Asia/Singapore', region: 'asia-southeast1' } as const;

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new HttpsError('invalid-argument', msg);
  }
  return result.data;
}

const SetMemberRole = z
  .object({
    schoolId: id,
    uid: id.optional(),
    email: z.email().optional(),
    role: z.enum(ROLES),
    teacherId: id.nullish(),
    studentId: id.nullish(),
  })
  .refine((v) => v.uid || v.email, { message: 'Give a uid or an email' });

export const setMemberRole = onCall(async (req) => {
  const input = parse(SetMemberRole, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner']);
  if (input.uid === actor.uid) {
    throw new HttpsError('failed-precondition', 'Owners cannot change their own role');
  }
  return members.setMemberRole(db(), getAuth(), input, actor);
});

const CreateLesson = z.object({
  schoolId: id,
  teacherId: id,
  subjectId: id,
  startAt: z.iso.datetime({ offset: true }),
  durationMin: z.number().int().min(5).max(lessons.MAX_DURATION_MIN),
  studentIds: z.array(id).min(1).max(50),
  isOnline: z.boolean(),
  locationId: id.nullish(),
  meetingUrl: z.url().nullish(),
});

export const createLesson = onCall(async (req) => {
  const input = parse(CreateLesson, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return lessons.createLesson(db(), { ...input, startAt: new Date(input.startAt) }, actor);
});

const MarkAttendance = z.object({
  schoolId: id,
  lessonId: id,
  studentId: id,
  status: z.enum(attendance.MARKABLE_STATUSES),
});

export const markAttendance = onCall(async (req) => {
  const input = parse(MarkAttendance, req.data);
  // Teachers pass this gate; setAttendance then checks the lesson is theirs, inside the transaction.
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin', 'teacher']);
  return attendance.setAttendance(db(), input, actor);
});

const CancelAttendance = z.object({
  schoolId: id,
  lessonId: id,
  studentId: id,
  mode: z.enum(attendance.CANCEL_MODES).optional(),
});

export const cancelAttendance = onCall(async (req) => {
  const input = parse(CancelAttendance, req.data);
  // Students may cancel their own lessons on time; the engine checks ownership and the cutoff.
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin', 'teacher', 'student']);
  return attendance.cancelAttendance(db(), input, actor);
});

const Attendee = z.object({ schoolId: id, lessonId: id, studentId: id });

export const addAttendee = onCall(async (req) => {
  const input = parse(Attendee, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return attendance.addAttendee(db(), input, actor);
});

export const removeAttendee = onCall(async (req) => {
  const input = parse(Attendee, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return attendance.removeAttendee(db(), input, actor);
});

const CancelLesson = z.object({ schoolId: id, lessonId: id, reason: z.string().trim().max(300).nullish() });

export const cancelLesson = onCall(async (req) => {
  const input = parse(CancelLesson, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return attendance.cancelLesson(db(), input, actor);
});

const SellPackage = z.object({
  schoolId: id,
  studentId: id,
  packageId: id,
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
});

export const sellPackage = onCall(async (req) => {
  const input = parse(SellPackage, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return credits.sellPackage(db(), input, actor);
});

const CreateSeries = z.object({
  schoolId: id,
  teacherId: id,
  subjectId: id,
  startDate: wallDate,
  time: wallTime,
  durationMin: duration,
  byDay: weekdays,
  until: wallDate.nullish(),
  studentIds: z.array(id).min(1).max(50),
  isOnline: z.boolean(),
  locationId: id.nullish(),
  meetingUrl: z.url().nullish(),
  skipConflicts: z.boolean().optional(),
});

export const createSeries = onCall(async (req) => {
  const input = parse(CreateSeries, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return series.createSeries(db(), input, actor);
});

const EditLesson = z.object({
  schoolId: id,
  lessonId: id,
  scope: z.enum(series.EDIT_SCOPES),
  changes: z
    .object({
      date: wallDate.optional(),
      time: wallTime.optional(),
      durationMin: duration.optional(),
      teacherId: id.optional(),
      isOnline: z.boolean().optional(),
      locationId: id.nullish(),
      meetingUrl: z.url().nullish(),
      byDay: weekdays.optional(),
    })
    .optional(),
  cancel: z.object({ reason: z.string().trim().max(300).nullish() }).optional(),
  skipConflicts: z.boolean().optional(),
});

export const editLesson = onCall(async (req) => {
  const input = parse(EditLesson, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return series.editLesson(db(), input, actor);
});

export const extendSeries = onSchedule({ ...JOB, schedule: 'every day 02:00' }, async () => {
  const res = await series.extendAllSeries(db());
  console.log(`extendSeries: ${res.series} series, ${res.created} lessons created`);
});

const Key = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

const RecordPayment = z.object({
  schoolId: id,
  invoiceId: id,
  amountCents: z.number().int().positive().max(100_000_000),
  method: z.enum(money.PAYMENT_METHODS),
  paidAt: z.iso.datetime({ offset: true }).optional(),
  reference: z.string().trim().max(120).nullish(),
  idempotencyKey: Key,
});

export const recordPayment = onCall(async (req) => {
  const input = parse(RecordPayment, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return money.recordPayment(db(), { ...input, paidAt: input.paidAt ? new Date(input.paidAt) : undefined }, actor);
});

const VoidInvoice = z.object({
  schoolId: id,
  invoiceId: id,
  reason: z.string().trim().min(3).max(300),
  keepCredits: z.boolean().optional(),
});

export const voidInvoice = onCall(async (req) => {
  const input = parse(VoidInvoice, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return money.voidInvoice(db(), input, actor);
});

export const markOverdue = onSchedule({ ...JOB, schedule: 'every day 08:00' }, async () => {
  const res = await money.markOverdueAll(db());
  console.log(`markOverdue: ${res.flagged} invoices flagged`);
});

/** Keeps each invoice's PDF (and PayNow payload) current. Skips when nothing printable changed. */
export const onInvoiceWritten = onDocumentWritten(
  { document: 'schools/{schoolId}/invoices/{invoiceId}', region: 'asia-southeast1' },
  async (event) => {
    if (!event.data?.after.exists) return;
    const { schoolId, invoiceId } = event.params;
    await invoicePdf.renderAndStoreInvoicePdf(db(), bucket(), schoolId, invoiceId);
  },
);

const InvoiceRef = z.object({ schoolId: id, invoiceId: id });

export const getInvoicePdfUrl = onCall(async (req) => {
  const input = parse(InvoiceRef, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin', 'student']);
  return invoicePdf.invoicePdfUrl(db(), bucket(), input, actor);
});
