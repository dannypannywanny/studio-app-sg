import type { AttendanceStatus } from './types';

/** Per-school credit rules, stored on `schools/{schoolId}.policy`. */
export interface CreditPolicy {
  /** A cancellation inside this many hours before the start counts as late. */
  lateCancelHours: number;
  /** Late cancel gives the credit back (Daniel's studio: yes). */
  lateCancelReturnsCredit: boolean;
  /** A no-show uses a credit. */
  absentConsumesCredit: boolean;
  /** With no credits left, the lesson goes ahead and is recorded as owed. */
  allowOwedLessons: boolean;
  /** When the credit is taken. Only 'mark' (on attendance) for now, like Classcard. */
  debitOn: 'mark';
}

export const DEFAULT_POLICY: CreditPolicy = {
  lateCancelHours: 24,
  lateCancelReturnsCredit: true,
  absentConsumesCredit: true,
  allowOwedLessons: true,
  debitOn: 'mark',
};

/** Merge a stored (possibly partial or missing) policy over the defaults. */
export function resolvePolicy(stored: Partial<CreditPolicy> | undefined | null): CreditPolicy {
  return { ...DEFAULT_POLICY, ...(stored ?? {}) };
}

/** Does an attendee in this status hold a credit (or an owed lesson)? */
export function consumesCredit(status: AttendanceStatus, policy: CreditPolicy): boolean {
  switch (status) {
    case 'present':
      return true;
    case 'absent':
      return policy.absentConsumesCredit;
    case 'lateCancelled':
      return !policy.lateCancelReturnsCredit;
    case 'booked':
    case 'cancelled':
    case 'removed':
      return false;
  }
}
