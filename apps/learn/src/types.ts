// Shapes of the Firestore docs as a student reads them (rules: their own records only). All writes go
// through Cloud Functions.
import type { Timestamp } from 'firebase/firestore';
import type { AttendanceStatus, CreditPolicy, EnrolmentStatus, InvoiceStatus, LessonMode, LessonStatus } from '@lessonkaki/shared';

export type Ts = Timestamp;

/** schools/{s}/public/profile: readable before sign-in. */
export interface Profile {
  name: string;
  logoUrl?: string | null;
  siteUrl?: string | null;
  contactEmail?: string | null;
  whatsapp?: string | null;
  /** Shown above the sign-in form, e.g. a note about moving from the old booking system. */
  signInNotice?: string | null;
  teachers?: Record<string, { name: string }>;
}

export interface School {
  name: string;
  timezone: string;
  currency: string;
  policy?: Partial<CreditPolicy>;
}

export interface Student {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  summary?: { sessionsAvailable?: number; sessionsOwed?: number; outstandingCents?: number };
}

export interface Lesson {
  teacherId: string;
  startAt: Ts;
  endAt: Ts;
  durationMin: number;
  isOnline: boolean;
  meetingUrl?: string | null;
  status: LessonStatus;
}

export interface Attendee {
  lessonId: string;
  studentId: string;
  status: AttendanceStatus;
  owed: boolean;
  lessonStartAt: Ts;
  source?: string;
  sharedNote?: string | null;
}

export interface Enrolment {
  packageName: string;
  sessionsTotal: number;
  sessionsRemaining: number;
  validUntil: Ts;
  status: EnrolmentStatus;
}

export interface Invoice {
  number: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  pendingCents: number;
  status: InvoiceStatus;
  issueDate: Ts;
  dueDate: Ts;
  lines: { desc: string; qty: number; unitCents: number }[];
  paynow?: { payload: string; reference: string; amountCents: number } | null;
}

/** getAvailability's answer (functions/src/booking.ts). */
export interface AvailabilityResult {
  timeZone: string;
  teachers: { teacherId: string; name: string; lessonMin: number; inPerson: boolean; online: boolean }[];
  slots: { teacherId: string; startAt: string; inPerson: boolean; online: boolean }[];
  upcoming: { booked: number; max: number | null } | null;
}

export interface BookLessonInput {
  schoolId: string;
  teacherId: string;
  startAt: string;
  mode: LessonMode;
}
