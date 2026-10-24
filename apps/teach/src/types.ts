// Shapes of the Firestore docs as the staff app reads them (architecture §3). Writes to money and credit
// docs happen only in Cloud Functions.
import type { Timestamp } from 'firebase/firestore';
import type {
  AttendanceState,
  AttendanceStatus,
  CreditPolicy,
  EnrolmentStatus,
  InvoiceStatus,
  LeadStage,
  LedgerType,
  LessonStatus,
  StudentStatus,
  StudentSummary,
} from '@lessonkaki/shared';

export type Ts = Timestamp;

export interface School {
  name: string;
  timezone: string;
  currency: string;
  policy?: Partial<CreditPolicy>;
  branding?: import('@lessonkaki/shared').Branding | null;
}

export interface Teacher {
  displayName: string;
  email?: string;
  active: boolean;
  /** Subjects this teacher teaches (online booking reads this too). */
  subjectIds?: string[];
}

export interface Subject {
  name: string;
  /** Lengths offered, in minutes, e.g. [30, 45, 60]. Older docs only have defaultDurationMin. */
  durations?: number[];
  defaultDurationMin: number;
  teacherIds?: string[];
  /** Most students in one lesson (group classes); 1 = one-on-one. */
  capacity?: number;
  active: boolean;
}

export interface Package {
  name: string;
  sessions: number;
  priceCents: number;
  validityDays: number | null;
  subjectId?: string | null;
  active: boolean;
}

export interface Student {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email?: string;
  phone?: string;
  status: StudentStatus;
  legacyId?: string | null;
  /** Staff notes about the student (shown on their page and in the lesson sheet). */
  notes?: string;
  /** Date the student joined the school (yyyy-MM-dd); for imports, their original sign-up date. */
  createdOn?: string | null;
  summary?: Partial<StudentSummary> & { outstandingCents?: number; moneyCreditCents?: number };
  createdAt?: Ts;
  /** Set while they're a lead (status 'lead'), and kept after they're won or lost. */
  lead?: Lead;
}

export interface Lead {
  stage: LeadStage;
  /** Date to get back to them (yyyy-MM-dd); shows on Today once due. */
  followUpOn?: string | null;
  lostReason?: string | null;
  /** When they were won or lost. */
  closedAt?: Ts | null;
}

export interface Enrolment {
  studentId: string;
  packageName: string;
  invoiceId: string | null;
  sessionsTotal: number;
  sessionsUsed: number;
  sessionsRemaining: number;
  sessionsExpired?: number;
  validFrom: Ts;
  validUntil: Ts;
  status: EnrolmentStatus;
}

export interface LedgerEntry {
  studentId: string;
  enrolmentId: string | null;
  type: LedgerType;
  delta: number;
  lessonId: string | null;
  reason: string | null;
  createdAt?: Ts;
}

export interface Invoice {
  number: string;
  studentId: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  moneyCreditAppliedCents?: number;
  taxCents?: number;
  tax?: { rate: number; label: string; inclusive: boolean; regNo: string | null } | null;
  /** Total of credit notes on this invoice. */
  creditedCents?: number;
  totalCents: number;
  paidCents: number;
  pendingCents: number;
  status: InvoiceStatus;
  issueDate: Ts;
  dueDate: Ts;
  lines: { desc: string; qty: number; unitCents: number }[];
  note?: string | null;
  overdueSince?: Ts | null;
  voidReason?: string | null;
  paidAt?: Ts | null;
  pdfPath?: string | null;
  paynow?: { payload: string; reference: string; amountCents: number } | null;
}

export type PaymentMethod = 'paynow' | 'bank' | 'cash';

export interface Payment {
  invoiceId: string;
  invoiceNumber: string;
  studentId: string;
  amountCents: number;
  appliedCents: number;
  overpaymentCents: number;
  method: PaymentMethod | 'card_hitpay';
  reference: string | null;
  status: string;
  paidAt: Ts;
}

export interface Lesson {
  teacherId: string;
  subjectId: string;
  startAt: Ts;
  endAt: Ts;
  durationMin: number;
  isOnline: boolean;
  status: LessonStatus;
  studentIds: string[];
  attendanceState: AttendanceState;
  seriesId?: string | null;
  isException?: boolean;
  cancelReason?: string | null;
  locationId?: string | null;
  /** Every student on it cancelled (set by the attendance functions). */
  studentsCancelled?: boolean;
  /** Leads on it for a trial lesson. */
  trialStudentIds?: string[];
}

/** Cancelled by the studio, or every student on it cancelled: both show struck through. */
export const isLessonCancelled = (l: Lesson) => l.status === 'cancelled' || l.studentsCancelled === true;

export interface Attendee {
  studentId: string;
  /** A lead's trial: free unless they have a package. */
  trial?: boolean;
  status: AttendanceStatus;
  owed: boolean;
  enrolmentId: string | null;
  ledgerEntryId: string | null;
  /** Package staff chose to pay for this lesson (null = earliest expiry). */
  preferredEnrolmentId?: string | null;
  /** Note for the student about this lesson (shown in the learn portal). */
  sharedNote?: string | null;
  /** A make-up was given for this absence / late cancel (the credit came back). */
  makeUp?: { grantedAt: Ts; enrolmentId: string } | null;
  markedAt: Ts | null;
}
