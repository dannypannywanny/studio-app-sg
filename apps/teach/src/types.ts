// Shapes of the Firestore docs as the staff app reads them (architecture §3). Writes to money and credit
// docs happen only in Cloud Functions.
import type { Timestamp } from 'firebase/firestore';
import type {
  AttendanceState,
  AttendanceStatus,
  CreditPolicy,
  EnrolmentStatus,
  InvoiceStatus,
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
}

export interface Subject {
  name: string;
  defaultDurationMin: number;
  active: boolean;
}

export interface Package {
  name: string;
  sessions: number;
  priceCents: number;
  validityDays: number | null;
  active: boolean;
}

export interface Student {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email?: string;
  phone?: string;
  status: StudentStatus;
  summary?: Partial<StudentSummary> & { outstandingCents?: number; moneyCreditCents?: number };
  createdAt?: Ts;
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
  totalCents: number;
  paidCents: number;
  pendingCents: number;
  status: InvoiceStatus;
  issueDate: Ts;
  dueDate: Ts;
  lines: { desc: string; qty: number; unitCents: number }[];
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
}

export interface Attendee {
  studentId: string;
  status: AttendanceStatus;
  owed: boolean;
  enrolmentId: string | null;
  ledgerEntryId: string | null;
  markedAt: Ts | null;
}
