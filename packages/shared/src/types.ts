// Shared vocabulary for functions and both web apps. Pure TypeScript, no runtime deps.

export const ROLES = ['owner', 'admin', 'teacher', 'student'] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES: readonly Role[] = ['owner', 'admin'];

/** Custom claims, kept small (1000-byte limit). Keyed by schoolId. */
export interface Claims {
  /** role per school */
  r?: Record<string, Role>;
  /** linked teacher doc per school */
  t?: Record<string, string>;
  /** linked student doc per school */
  s?: Record<string, string>;
  /**
   * Local emulator only: staff may skip the second factor (the Auth emulator has no TOTP).
   * setMemberRole sets it only on `demo-*` projects, so production accounts never carry it.
   */
  devNoMfa?: true;
}

/** Everyone but students needs a second factor (TOTP) to act in a school. */
export const roleNeedsMfa = (role: Role): boolean => role !== 'student';

/**
 * Attendee status. `booked` is the unmarked state; "unmark" sets it back to `booked`.
 * `cancelled` (on time) and `removed` arrive with cancelAttendance in M2.
 */
export const ATTENDANCE_STATUSES = [
  'booked',
  'present',
  'absent',
  'cancelled',
  'lateCancelled',
  'removed',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Ledger entry types. The ledger is append-only. */
export const LEDGER_TYPES = ['grant', 'debit', 'restore', 'settle', 'expire', 'adjust', 'migrate'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export type EnrolmentStatus = 'active' | 'completed' | 'expired' | 'void';
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'void';
export type LessonStatus = 'scheduled' | 'cancelled';
export type AttendanceState = 'unmarked' | 'partial' | 'marked';
/** `lead`: a prospect (enquiry or trial), not yet a student; never gets a portal login. */
export type StudentStatus = 'active' | 'inactive' | 'archived' | 'lead';

/** Where a lead is: enquired, trial booked, became a student (won) or didn't (lost). */
export const LEAD_STAGES = ['new', 'trial', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_STAGE_LABEL: Record<LeadStage, string> = { new: 'New', trial: 'Trial booked', won: 'Won', lost: 'Lost' };

/** Function-maintained, read-only to clients. */
export interface StudentSummary {
  sessionsAvailable: number;
  sessionsOwed: number;
}
