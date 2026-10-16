// Student reminder emails: before a lesson, before an invoice is due, and while it's overdue.
// schools/{id}.reminders; everything is off until the owner turns it on.

export interface ReminderSettings {
  lessons: boolean;
  /** Hours before the lesson start. */
  lessonHoursBefore: number;
  payments: boolean;
  /** Days before the due date for the one "due soon" email. */
  dueSoonDays: number;
  /** Days between overdue emails. */
  overdueEveryDays: number;
  /** Most overdue emails per invoice. */
  overdueMax: number;
}

export const DEFAULT_REMINDERS: ReminderSettings = {
  lessons: false,
  lessonHoursBefore: 24,
  payments: false,
  dueSoonDays: 3,
  overdueEveryDays: 7,
  overdueMax: 3,
};

const int = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

export function resolveReminders(raw: unknown): ReminderSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    lessons: r.lessons === true,
    lessonHoursBefore: int(r.lessonHoursBefore, 1, 168, DEFAULT_REMINDERS.lessonHoursBefore),
    payments: r.payments === true,
    dueSoonDays: int(r.dueSoonDays, 0, 30, DEFAULT_REMINDERS.dueSoonDays),
    overdueEveryDays: int(r.overdueEveryDays, 1, 60, DEFAULT_REMINDERS.overdueEveryDays),
    overdueMax: int(r.overdueMax, 0, 12, DEFAULT_REMINDERS.overdueMax),
  };
}
