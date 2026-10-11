// Callable entry points. Each one: zod-validate the input, check the caller's role from claims,
// then hand over to the engine, which does all writes in a Firestore transaction.
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { ROLES } from '@lessonkaki/shared';
import { requireRole } from './auth';
import * as attendance from './attendance';
import * as credits from './credits';
import * as lessons from './lessons';
import * as members from './members';

initializeApp();
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 });

const db = () => getFirestore();

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

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
