// Callable entry points. Each one: zod-validate the input, check the caller's role from claims,
// then hand over to the engine, which does all writes in a Firestore transaction.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { z } from 'zod';
import { HOLIDAY_COUNTRIES, LESSON_MODES, ROLES, WEEKDAYS, isWallDate, isWallTime, type HolidayCountry } from '@lessonkaki/shared';
import * as alerts from './alerts';
import { requireRole } from './auth';
import * as attendance from './attendance';
import * as booking from './booking';
import * as holidays from './holidays';
import * as credits from './credits';
import * as lessons from './lessons';
import * as invoicePdf from './invoicePdf';
import * as importing from './importStudents';
import * as invites from './invites';
import * as jobs from './jobs';
import * as members from './members';
import * as money from './money';
import * as series from './series';
import * as signInLinks from './signInLinks';

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

const ResetSecondFactor = z.object({ schoolId: id, uid: z.string().min(1).max(128) });

export const resetSecondFactor = onCall(async (req) => {
  const input = parse(ResetSecondFactor, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner']);
  if (input.uid === actor.uid) throw new HttpsError('failed-precondition', 'Owners cannot reset their own two-step sign-in');
  await members.resetSecondFactor(db(), getAuth(), input.schoolId, input.uid, actor);
  return { ok: true };
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

// Student portal (learn site): who can sign in, open slots, and booking one.

const InviteStudents = z.object({
  schoolId: id,
  studentIds: z.array(id).min(1).max(invites.MAX_INVITES),
  dryRun: z.boolean().optional(),
});

export const inviteStudents = onCall(async (req) => {
  const input = parse(InviteStudents, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner']);
  return { results: await invites.inviteStudents(db(), getAuth(), input, actor) };
});

const GetAvailability = z.object({ schoolId: id, teacherId: id.nullish() });

export const getAvailability = onCall(async (req) => {
  const input = parse(GetAvailability, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin', 'student']);
  return booking.getAvailability(db(), input, actor);
});

const BookLesson = z.object({
  schoolId: id,
  teacherId: id,
  startAt: z.iso.datetime({ offset: true }),
  mode: z.enum(LESSON_MODES),
});

export const bookLesson = onCall(async (req) => {
  const input = parse(BookLesson, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['student']);
  return booking.bookLesson(db(), { ...input, startAt: new Date(input.startAt) }, actor);
});

const Attendee = z.object({ schoolId: id, lessonId: id, studentId: id });

export const addAttendee = onCall(async (req) => {
  const input = parse(Attendee, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return attendance.addAttendee(db(), input, actor);
});

export const setAttendeePackage = onCall(async (req) => {
  const input = parse(Attendee.extend({ enrolmentId: id.nullable() }), req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return attendance.setAttendeePackage(db(), input, actor);
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
  validUntil: z.string().refine(isWallDate).nullable().optional(),
  discount: z.object({ kind: z.enum(['percent', 'amount']), value: z.number().min(0).max(100_000_000) }).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
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
  { document: 'schools/{schoolId}/invoices/{invoiceId}', region: 'asia-southeast1', memory: '512MiB' },
  async (event) => {
    if (!event.data?.after.exists) return;
    const { schoolId, invoiceId } = event.params;
    await invoicePdf.renderAndStoreInvoicePdf(db(), bucket(), schoolId, invoiceId);
  },
);

const InvoiceRef = z.object({ schoolId: id, invoiceId: id });

// Rendering may load the 10 MB CJK font into HarfBuzz (see fontSubset.ts), hence the extra memory.
const PDF_MEMORY = '512MiB' as const;

export const getInvoicePdfUrl = onCall({ memory: PDF_MEMORY }, async (req) => {
  const input = parse(InvoiceRef, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin', 'student']);
  return invoicePdf.invoicePdfUrl(db(), bucket(), input, actor);
});

export const expireLots = onSchedule({ ...JOB, schedule: 'every day 00:15' }, async () => {
  const res = await jobs.forEachSchool(db(), (schoolId) => jobs.expireLots(db(), schoolId));
  console.log(`expireLots: ${res.reduce((n, r) => n + r.lots, 0)} lots expired`);
});

export const reconcileLedger = onSchedule({ ...JOB, schedule: 'every day 03:00' }, async () => {
  const res = await jobs.forEachSchool(db(), (schoolId) => jobs.reconcileLedger(db(), schoolId));
  const problems = res.reduce((n, r) => n + r.problemCount, 0);
  if (problems) console.error(`reconcileLedger: ${problems} problems written to auditLog`);
});

const AdjustCredits = z.object({
  schoolId: id,
  studentId: id,
  delta: z.number().int().min(-100).max(100).refine((n) => n !== 0, 'Adjust by at least one session'),
  reason: z.string().trim().min(3).max(300),
  enrolmentId: id.nullish(),
  validityDays: z.number().int().min(1).max(3650).nullish(),
  idempotencyKey: Key,
});

export const adjustCredits = onCall(async (req) => {
  const input = parse(AdjustCredits, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return jobs.adjustCredits(db(), input, actor);
});

const Candidate = z.object({
  row: z.number().int().min(1),
  legacyId: z.string().max(64).nullable(),
  firstName: z.string().max(80),
  lastName: z.string().max(80),
  email: z.email().nullable(),
  phone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  phoneRaw: z.string().max(64),
  status: z.enum(['active', 'inactive']),
  createdOn: z.string().max(10).nullable(),
  referralSource: z.string().max(200).nullable(),
  signupSource: z.string().max(200).nullable(),
  note: z.string().max(2000).nullable(),
  issues: z.array(z.string()).max(10),
});

const ImportStudents = z.object({
  schoolId: id,
  rows: z.array(Candidate).min(1).max(importing.MAX_IMPORT_ROWS),
  excludeEmails: z.array(z.string().max(200)).max(20).optional(),
});

export const importStudents = onCall(async (req) => {
  const input = parse(ImportStudents, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner', 'admin']);
  return importing.importStudents(db(), input as importing.ImportStudentsInput, actor);
});

// Owner email alerts. The Resend key is one platform-wide secret (Secret Manager: RESEND_API_KEY); each
// school sends from its own verified domain (schools/{id}.mail.from, server-set), else the default below.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
/** Resend's shared test sender: delivers only to the Resend account's own address. */
const DEFAULT_ALERT_FROM = 'LessonKaki <onboarding@resend.dev>';

/** Sends each alert written by the functions above. Retries on transient errors (see alerts.ts). */
export const onAlertCreated = onDocumentCreated(
  { document: 'schools/{schoolId}/alerts/{alertId}', region: 'asia-southeast1', secrets: [RESEND_API_KEY], retry: true },
  async (event) => {
    const key = RESEND_API_KEY.value();
    const { schoolId, alertId } = event.params;
    await alerts.deliverAlert(db(), key ? alerts.resendSender(key) : null, schoolId, alertId, { defaultFrom: DEFAULT_ALERT_FROM });
  },
);

// Student sign-in links by email (learn site), sent with Resend from the school's own domain instead of
// Firebase's noreply address. No sign-in needed to call it; it answers the same whoever asks.
const SendSignInLink = z.object({ email: z.email().max(200) });

export const sendSignInLink = onCall({ secrets: [RESEND_API_KEY] }, async (req) => {
  const input = parse(SendSignInLink, req.data);
  const origin = req.rawRequest.headers.origin;
  if (!origin) throw new HttpsError('invalid-argument', 'Open the sign-in page in a browser');
  const key = RESEND_API_KEY.value();
  await signInLinks.sendSignInLink(
    db(),
    getAuth(),
    key ? alerts.resendSender(key) : null,
    { email: input.email, host: new URL(origin).hostname },
    { defaultFrom: DEFAULT_ALERT_FROM },
  );
  return { ok: true };
});

// The 6-digit code from the same email, typed on the page that asked for it. Returns a custom token.
const VerifySignInCode = z.object({ email: z.email().max(200), code: z.string().regex(/^\s*\d{3}\s?\d{3}\s*$/) });

export const verifySignInCode = onCall(async (req) => {
  const input = parse(VerifySignInCode, req.data);
  const origin = req.rawRequest.headers.origin;
  if (!origin) throw new HttpsError('invalid-argument', 'Open the sign-in page in a browser');
  const token = await signInLinks.verifySignInCode(db(), getAuth(), { ...input, host: new URL(origin).hostname });
  return { token };
});

const SetHolidays = z.object({
  schoolId: id,
  country: z.enum(Object.keys(HOLIDAY_COUNTRIES) as [HolidayCountry, ...HolidayCountry[]]).nullable(),
  closed: z.boolean(),
});

export const setHolidays = onCall(async (req) => {
  const input = parse(SetHolidays, req.data);
  const actor = requireRole(req.auth, input.schoolId, ['owner']);
  return holidays.setHolidays(db(), input, actor);
});

export const refreshHolidays = onSchedule({ ...JOB, schedule: '0 3 1 * *' }, async () => {
  const res = await holidays.refreshAllHolidays(db());
  console.log(`refreshHolidays: ${res.updated} schools`);
});
