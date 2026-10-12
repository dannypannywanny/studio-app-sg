// Owner email alerts: what happened in the studio (bookings, cancellations, payments), emailed to the
// addresses in `schools/{schoolId}.alerts`. Functions write one `alerts/{alertId}` doc per event in the
// same transaction as the change; a trigger sends it (functions/src/alerts.ts).

/** What the owner can switch on and off in Settings. */
export const ALERT_CATEGORIES = ['bookings', 'cancellations', 'payments', 'paymentProblems'] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/**
 * Every event type and the switch that covers it. Producers marked "later" don't exist yet:
 * payment.succeeded / failed / abandoned come with HitPay (M4), bookings with source 'booking' or
 * 'portal' with online booking (M5). They plug in by calling enqueueAlert with these types.
 */
export const ALERT_TYPES = {
  'lesson.booked': 'bookings',
  'series.booked': 'bookings',
  'attendee.cancelled': 'cancellations',
  'attendee.removed': 'cancellations',
  'lesson.cancelled': 'cancellations',
  'series.cancelled': 'cancellations',
  'payment.recorded': 'payments',
  'payment.succeeded': 'payments', // later: HitPay webhook (M4)
  'payment.failed': 'paymentProblems', // later: HitPay webhook (M4)
  'payment.abandoned': 'paymentProblems', // later: unpaid booking hold expired (M5)
} as const satisfies Record<string, AlertCategory>;
export type AlertType = keyof typeof ALERT_TYPES;

export const ALERT_CATEGORY_LABELS: Record<AlertCategory, { label: string; hint: string }> = {
  bookings: { label: 'Bookings', hint: 'A lesson or weekly lessons are booked' },
  cancellations: { label: 'Cancellations', hint: 'A student cancels or is taken off a lesson, or a lesson is cancelled' },
  payments: { label: 'Payments', hint: 'A payment is recorded or received online' },
  paymentProblems: { label: 'Payment problems', hint: 'An online payment fails or is not completed' },
};

/** Stored on `schools/{schoolId}.alerts` (owner-editable). */
export interface AlertSettings {
  /** Who gets the emails. */
  to: string[];
  events: Record<AlertCategory, boolean>;
  /** Only email about what students and online payments do, not what staff do in the app. */
  skipStaffActions: boolean;
}

export const MAX_ALERT_RECIPIENTS = 5;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string): boolean => EMAIL.test(s) && s.length <= 254;

/**
 * Merges stored settings over the defaults: everything on, sent to the school's contact email until the
 * owner picks recipients. Bad addresses are dropped rather than failing a send.
 */
export function resolveAlertSettings(stored: Partial<AlertSettings> | null | undefined, contactEmail?: string | null): AlertSettings {
  const events = Object.fromEntries(ALERT_CATEGORIES.map((c) => [c, stored?.events?.[c] !== false])) as Record<AlertCategory, boolean>;
  const raw = Array.isArray(stored?.to) ? stored.to : contactEmail ? [contactEmail] : [];
  const to = [...new Set(raw.filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase()))]
    .filter(isEmail)
    .slice(0, MAX_ALERT_RECIPIENTS);
  return { to, events, skipStaffActions: stored?.skipStaffActions === true };
}
